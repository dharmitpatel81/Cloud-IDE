import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

export function attachCollabServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/collab" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (socket) => {
    clients.add(socket);

    socket.on("message", (data) => {
      // Naive: forward every edit to everyone else, verbatim, in arrival order.
      for (const peer of clients) {
        if (peer !== socket && peer.readyState === WebSocket.OPEN) {
          peer.send(data.toString());
        }
      }
    });

    socket.on("close", () => clients.delete(socket));
  });

  return wss;
}
