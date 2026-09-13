import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { and, eq, gt, inArray } from "drizzle-orm";
import { setupWSConnection } from "y-websocket/bin/utils";
import { db } from "./db/index.js";
import { projects, sessions } from "./db/schema.js";
import { readSessionCookie, userFromToken } from "./auth/routes.js";
import { ALLOWED_HOSTS, ALLOWED_ORIGIN } from "./allowlist.js";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const REVALIDATE_INTERVAL_MS = 30_000;
const REVOKED_CLOSE_CODE = 4001;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The room deliberately starts empty. Seeding default content server-side
// injects it into live documents: a restart builds a fresh empty doc, the seed
// lands, and the reconnecting client's real content merges on top of it.

function reject(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Who is connecting, and may they open this room? Answered before the socket
 *  exists, because an upgrade is an entry point like any other route. */
async function authorizeUpgrade(
  request: IncomingMessage,
): Promise<{ projectId: string; token: string } | null> {
  // DNS rebinding: a page elsewhere can point its own hostname at 127.0.0.1.
  if (!ALLOWED_HOSTS.has(request.headers.host ?? "")) return null;
  if (request.headers.origin !== ALLOWED_ORIGIN) return null;

  const projectId = (request.url ?? "").split("?")[0].replace(/^\/collab\//, "");
  if (!UUID.test(projectId)) return null;

  const token = readSessionCookie(request.headers.cookie);
  const user = await userFromToken(token);
  if (!user || !token) return null;

  // Same scoped query as GET /projects/:id — ownership decides whether the row
  // comes back at all, rather than being checked after the fact.
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, user.id)))
    .limit(1);

  return project ? { projectId: project.id, token } : null;
}

/** Which of these session tokens still belong to an unexpired session. */
async function liveTokens(tokens: string[]): Promise<Set<string>> {
  const rows = await db
    .select({ token: sessions.token })
    .from(sessions)
    .where(and(inArray(sessions.token, tokens), gt(sessions.expiresAt, new Date())));
  return new Set(rows.map((row) => row.token));
}

/** Cut off a socket whose session is gone. The close frame tells the client
 *  why, but `ws` keeps delivering messages while a socket is CLOSING, so stop
 *  applying them now instead of trusting the client to hang up. */
function revoke(ws: WebSocket) {
  ws.removeAllListeners("message");
  ws.close(REVOKED_CLOSE_CODE, "session no longer valid");
  setTimeout(() => ws.terminate(), 2000).unref();
}

export function attachCollabServer(server: Server) {
  // noServer: we handle the upgrade ourselves. `verifyClient` can't do this —
  // it's synchronous, and deciding requires a database round trip.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on("error", (err) => console.error("collab server error:", err));

  // Session token -> sockets open under it. A one-time check at upgrade only
  // proves who you were; re-checked on an interval so logout and expiry
  // actually reach connections that are already open.
  const socketsByToken = new Map<string, Set<WebSocket>>();

  // One batched query per pass, and never two passes at once — if Postgres
  // stalls, passes would otherwise pile up behind it.
  let revalidating = false;
  const revalidate = setInterval(() => {
    if (revalidating || socketsByToken.size === 0) return;
    revalidating = true;
    const tokens = [...socketsByToken.keys()];
    liveTokens(tokens)
      .then((live) => {
        for (const token of tokens) {
          if (live.has(token)) continue;
          const sockets = socketsByToken.get(token);
          if (!sockets) continue;
          for (const ws of sockets) revoke(ws);
          socketsByToken.delete(token);
        }
      })
      .catch((err) => console.error("collab revalidation failed:", err))
      .finally(() => {
        revalidating = false;
      });
  }, REVALIDATE_INTERVAL_MS);
  revalidate.unref();

  server.on("upgrade", (request, socket, head) => {
    const url = (request.url ?? "").split("?")[0];
    if (!url.startsWith("/collab/")) {
      // Registering an 'upgrade' listener suppresses Node's default
      // socket.destroy() for paths nobody handles here — without this, a
      // request to any other path leaks an open, unauthenticated socket.
      socket.destroy();
      return;
    }

    // An unhandled 'error' on the raw socket would take the process down
    // before the WebSocket even exists.
    socket.on("error", (err) => console.error("collab upgrade socket error:", err));

    authorizeUpgrade(request)
      .then((result) => {
        if (!result) return reject(socket, "401 Unauthorized");
        const { projectId, token } = result;

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("error", (err) => console.error("collab socket error:", err));

          let sockets = socketsByToken.get(token);
          if (!sockets) socketsByToken.set(token, (sockets = new Set()));
          sockets.add(ws);
          ws.on("close", () => {
            sockets.delete(ws);
            // Compare identity: a newer upgrade for the same token may have
            // replaced this entry, and that one still needs re-checking.
            if (sockets.size === 0 && socketsByToken.get(token) === sockets) {
              socketsByToken.delete(token);
            }
          });

          // One Y.Doc per project, and only owners ever reach this line.
          setupWSConnection(ws, request, { docName: projectId });
        });
      })
      .catch((err) => {
        console.error("collab upgrade failed:", err);
        reject(socket, "500 Internal Server Error");
      });
  });

  return wss;
}
