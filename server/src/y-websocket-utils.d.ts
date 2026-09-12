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

  export function setContentInitializor(f: (ydoc: Y.Doc) => Promise<void>): void;
}
