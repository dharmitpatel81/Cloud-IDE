import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import { setupWSConnection } from "y-websocket/bin/utils";

const ROOM = "cloud-ide";
const ALLOWED_ORIGIN = "http://localhost:5173";
const MAX_PAYLOAD_BYTES = 1024 * 1024;

// The room deliberately starts empty. Seeding default content here looks
// harmless but injects it into live documents: a server restart builds a fresh
// empty doc, the seed lands, and then the reconnecting client's real content
// merges on top of it. Under `tsx watch` that fires on every server save.

export function attachCollabServer(server: Server) {
  const wss = new WebSocketServer({
    server,
    // WebSocket upgrades are not subject to CORS, so the @fastify/cors
    // allowlist on /run buys nothing here. Without this check, any page open
    // in the browser can read and rewrite the shared document.
    verifyClient: (info: { origin: string }) => info.origin === ALLOWED_ORIGIN,
    // Yjs frames are binary, so they can't be schema-validated at the edge.
    // A size cap is the only bound available; ws otherwise allows 100MB.
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  wss.on("error", (err) => console.error("collab server error:", err));

  wss.on("connection", (socket, request) => {
    // An unhandled 'error' event on an EventEmitter takes the whole process
    // down — one ECONNRESET would kill /run along with it.
    socket.on("error", (err) => console.error("collab socket error:", err));

    // The room name is the URL path, and y-websocket allocates a Y.Doc per
    // distinct name that is never freed. Pinning to one known room bounds that
    // at exactly one document.
    const room = (request.url ?? "").slice(1).split("?")[0];
    if (room !== ROOM) {
      socket.close(1008, "unknown room");
      return;
    }

    // Yjs owns the wire protocol from here: sync steps, awareness, and the
    // room's authoritative document all live inside this call.
    setupWSConnection(socket, request, { docName: ROOM });
  });

  return wss;
}
