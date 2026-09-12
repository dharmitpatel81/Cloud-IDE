import { WebSocketServer } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import { setupWSConnection } from "y-websocket/bin/utils";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { readSessionCookie, userFromToken } from "./auth/routes.js";

const ALLOWED_ORIGIN = "http://localhost:5173";
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The room deliberately starts empty. Seeding default content server-side
// injects it into live documents: a restart builds a fresh empty doc, the seed
// lands, and the reconnecting client's real content merges on top of it.

function reject(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Who is connecting, and may they open this room? Answered before the socket
 *  exists, because an upgrade is an entry point like any other route. */
async function authorizeUpgrade(request: IncomingMessage): Promise<string | null> {
  if (request.headers.origin !== ALLOWED_ORIGIN) return null;

  const projectId = (request.url ?? "").split("?")[0].replace(/^\/collab\//, "");
  if (!UUID.test(projectId)) return null;

  const user = await userFromToken(readSessionCookie(request.headers.cookie));
  if (!user) return null;

  // Same scoped query as GET /projects/:id — ownership decides whether the row
  // comes back at all, rather than being checked after the fact.
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, user.id)))
    .limit(1);

  return project ? project.id : null;
}

export function attachCollabServer(server: Server) {
  // noServer: we handle the upgrade ourselves. `verifyClient` can't do this —
  // it's synchronous, and deciding requires a database round trip.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on("error", (err) => console.error("collab server error:", err));

  server.on("upgrade", (request, socket, head) => {
    if (!(request.url ?? "").startsWith("/collab/")) return;

    // An unhandled 'error' on the raw socket would take the process down
    // before the WebSocket even exists.
    socket.on("error", (err) => console.error("collab upgrade socket error:", err));

    authorizeUpgrade(request)
      .then((projectId) => {
        if (!projectId) return reject(socket, "401 Unauthorized");

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("error", (err) => console.error("collab socket error:", err));
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
