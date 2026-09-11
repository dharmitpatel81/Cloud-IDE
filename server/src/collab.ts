import { WebSocketServer } from "ws";
import type { Server } from "node:http";
// y-websocket ships its server helper as CommonJS with no type declarations.
// @ts-expect-error
import { setupWSConnection } from "y-websocket/bin/utils";

export function attachCollabServer(server: Server) {
  // No `path` filter: the y-websocket client connects to /<room>, so the room
  // name *is* the path and there's no fixed one to match.
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket, request) => {
    // Yjs owns the wire protocol now — sync steps, awareness, and the room's
    // authoritative document all live inside this one call.
    setupWSConnection(socket, request);
  });

  return wss;
}
