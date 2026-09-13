import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

// Every WS endpoint (collab, terminal, ...) registers its own prefix here
// instead of adding its own `server.on("upgrade", ...)` listener. Two
// independent listeners can't safely share one raw socket: if one has
// already called `wss.handleUpgrade` on it, a second listener destroying
// "anything it doesn't recognize" would tear down a connection that was just
// upgraded. One dispatcher, one decision per request, avoids that.
const routes = new Map<string, UpgradeHandler>();

export function registerUpgradeRoute(prefix: string, handler: UpgradeHandler) {
  routes.set(prefix, handler);
}

export function attachUpgradeRouter(server: Server) {
  server.on("upgrade", (request, socket, head) => {
    const url = (request.url ?? "").split("?")[0];
    for (const [prefix, handler] of routes) {
      if (url.startsWith(prefix)) {
        handler(request, socket, head);
        return;
      }
    }
    // Registering an 'upgrade' listener suppresses Node's default
    // socket.destroy() for paths nobody handles here — without this, a
    // request to any unrecognized path leaks an open, unauthenticated socket.
    socket.destroy();
  });
}
