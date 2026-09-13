// y-websocket ships its server helper as CommonJS with no type declarations.
// A shim beats `@ts-expect-error`, which types the whole import as `any` and
// silently erases checking on the options argument.
declare module "y-websocket/bin/utils" {
  import type { WebSocket } from "ws";
  import type { IncomingMessage } from "node:http";
  import type * as Y from "yjs";

  export function setupWSConnection(
    conn: WebSocket,
    req: IncomingMessage,
    opts?: { docName?: string; gc?: boolean },
  ): void;

  /** The room's shared document, created (empty) if it doesn't exist yet.
   *  It's an instance of y-websocket's own copy of Yjs, the CommonJS one. */
  export function getYDoc(docName: string, gc?: boolean): Y.Doc;

  /** Every open room by name. With no persistence configured, a room stays
   *  here after its last client leaves. */
  export const docs: Map<string, Y.Doc & { conns: Map<WebSocket, Set<number>> }>;
}
