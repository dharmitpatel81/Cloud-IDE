import { WebSocketServer } from "ws";
import { docs, setupWSConnection } from "y-websocket/bin/utils";
import { authorizeProjectUpgrade, reject, sessionRegistry } from "./ws-auth.js";
import { registerUpgradeRoute } from "./ws-router.js";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PROJECT_DELETED_CLOSE_CODE = 4004;

/** Drops a deleted project's room: every open tab is told, and the document
 *  leaves memory — otherwise it would keep accepting edits for a project
 *  that no longer exists. */
export function closeRoom(projectId: string) {
  const doc = docs.get(projectId);
  if (!doc) return;
  for (const conn of doc.conns.keys()) conn.close(PROJECT_DELETED_CLOSE_CODE, "project deleted");
  docs.delete(projectId);
  doc.destroy();
}

// A room deliberately starts empty, and nothing seeds it when it's created:
// after a restart the room is rebuilt empty, and a seed landing then would
// merge underneath the reconnecting client's real files. Its content comes
// from clients, and from the terminal's folder mirror (workspaceSync.ts).

export function attachCollabServer() {
  // noServer: we handle the upgrade ourselves. `verifyClient` can't do this —
  // it's synchronous, and deciding requires a database round trip.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  wss.on("error", (err) => console.error("collab server error:", err));

  registerUpgradeRoute("/collab/", (request, socket, head) => {
    // An unhandled 'error' on the raw socket would take the process down
    // before the WebSocket even exists.
    socket.on("error", (err) => console.error("collab upgrade socket error:", err));

    authorizeProjectUpgrade(request, "/collab/")
      .then((result) => {
        if (!result) return reject(socket, "401 Unauthorized");
        const { projectId, token } = result;

        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("error", (err) => console.error("collab socket error:", err));
          sessionRegistry.register(token, ws);

          // One Y.Doc per project, and only owners ever reach this line.
          setupWSConnection(ws, request, { docName: projectId });
        });
      })
      .catch((err: unknown) => {
        console.error("collab upgrade failed:", err);
        reject(socket, "500 Internal Server Error");
      });
  });

  return wss;
}
