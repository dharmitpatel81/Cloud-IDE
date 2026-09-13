import { WebSocketServer, type WebSocket } from "ws";
import type { Duplex } from "node:stream";
import type Docker from "dockerode";
import { z } from "zod";
import { authorizeProjectUpgrade, reject, sessionRegistry } from "./ws-auth.js";
import { registerUpgradeRoute } from "./ws-router.js";
import { attachShell, getOrCreateTerminalSession, resizeShell } from "./runner.js";
import { startMirror } from "./workspaceSync.js";

const MAX_PAYLOAD_BYTES = 64 * 1024;
// Enough scrollback to hand a joining tab what the shell already printed —
// including the very first prompt, which is emitted before anyone is listening.
const HISTORY_BYTES = 64 * 1024;

const size = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
};
// The size rides along with init: a resize sent right after it would land
// before the shell exists and be dropped, leaving the pty at Docker's default
// width — every line then wraps in the wrong place.
const initMessage = z.object({ type: z.literal("init"), ...size });
const resizeMessage = z.object({ type: z.literal("resize"), ...size });

/** One shell's output fanned out to every client attached to this project,
 *  and input merged in from all of them — the shared-pty model: a pty has
 *  exactly one authoritative owner (the shell process), so this is the
 *  correct shape here, not a shortcut standing in for something better. */
type Hub = {
  stream: Duplex;
  exec: Docker.Exec;
  clients: Set<WebSocket>;
  history: Buffer[];
  historyBytes: number;
};
const hubs = new Map<string, Hub>();

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function remember(hub: Hub, chunk: Buffer) {
  hub.history.push(chunk);
  hub.historyBytes += chunk.length;
  while (hub.historyBytes > HISTORY_BYTES && hub.history.length > 1) {
    hub.historyBytes -= hub.history.shift()!.length;
  }
}

async function attachHub(projectId: string): Promise<Hub> {
  const existing = hubs.get(projectId);
  if (existing) return existing;

  const session = await getOrCreateTerminalSession(projectId, async () => {
    const mirror = await startMirror(projectId);
    return { dir: mirror.dir, cleanup: mirror.stop };
  });
  const { exec, stream } = await attachShell(session);
  const hub: Hub = { stream, exec, clients: new Set(), history: [], historyBytes: 0 };
  hubs.set(projectId, hub);

  stream.on("data", (chunk: Buffer) => {
    remember(hub, chunk);
    for (const ws of hub.clients) {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    }
  });
  const detach = () => {
    if (hubs.get(projectId) === hub) hubs.delete(projectId);
    for (const ws of hub.clients) ws.close(1011, "shell exited");
  };
  stream.on("close", detach);
  stream.on("error", (err) => {
    console.error(`terminal shell stream error for project ${projectId}:`, err);
    detach();
  });

  return hub;
}

export function attachTerminalServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on("error", (err) => console.error("terminal server error:", err));

  registerUpgradeRoute("/terminal/", (request, socket, head) => {
    socket.on("error", (err) => console.error("terminal upgrade socket error:", err));

    authorizeProjectUpgrade(request, "/terminal/")
      .then((result) => {
        if (!result) return reject(socket, "401 Unauthorized");
        const { projectId, token } = result;

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("error", (err) => console.error("terminal socket error:", err));
          sessionRegistry.register(token, ws);

          let hub: Hub | null = null;
          let initialized = false;

          ws.on("message", (data, isBinary) => {
            if (isBinary) {
              hub?.stream.write(toBuffer(data));
              return;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(toBuffer(data).toString());
            } catch {
              return;
            }

            if (!initialized) {
              const init = initMessage.safeParse(parsed);
              if (!init.success) {
                // Loudly: a silently ignored init is a terminal that never
                // starts and never says why.
                ws.close(1008, "invalid init message");
                return;
              }
              initialized = true;
              const { cols, rows } = init.data;
              attachHub(projectId)
                .then((attached) => {
                  // The socket may already be gone by the time Docker responds.
                  if (ws.readyState !== ws.OPEN) return;
                  hub = attached;
                  if (hub.history.length > 0) ws.send(Buffer.concat(hub.history));
                  hub.clients.add(ws);
                  void resizeShell(hub.exec, cols, rows);
                })
                .catch((err: unknown) => {
                  console.error(`failed to start terminal session for project ${projectId}:`, err);
                  ws.close(1011, "couldn't start a terminal");
                });
              return;
            }

            const resize = resizeMessage.safeParse(parsed);
            if (resize.success && hub) void resizeShell(hub.exec, resize.data.cols, resize.data.rows);
          });

          ws.on("close", () => {
            hub?.clients.delete(ws);
          });
        });
      })
      .catch((err: unknown) => {
        console.error("terminal upgrade failed:", err);
        reject(socket, "500 Internal Server Error");
      });
  });

  return wss;
}
