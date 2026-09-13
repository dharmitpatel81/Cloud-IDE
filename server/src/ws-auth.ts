import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions } from "./db/schema.js";
import { readSessionCookie, userFromToken } from "./auth/routes.js";
import { ALLOWED_HOSTS, ALLOWED_ORIGIN } from "./allowlist.js";

const REVALIDATE_INTERVAL_MS = 30_000;
const REVOKED_CLOSE_CODE = 4001;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function reject(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Who is connecting, and may they open this project's socket? Answered
 *  before the socket exists, because an upgrade is an entry point like any
 *  other route. `pathPrefix` is stripped from the URL to get the project id,
 *  so the same check works for `/collab/<id>` and `/terminal/<id>`. */
export async function authorizeProjectUpgrade(
  request: IncomingMessage,
  pathPrefix: string,
): Promise<{ projectId: string; token: string } | null> {
  // DNS rebinding: a page elsewhere can point its own hostname at 127.0.0.1.
  if (!ALLOWED_HOSTS.has(request.headers.host ?? "")) return null;
  if (request.headers.origin !== ALLOWED_ORIGIN) return null;

  const projectId = (request.url ?? "").split("?")[0].replace(pathPrefix, "");
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

/** Tracks every open socket by the session token that authorized it, and
 *  revokes them the moment that session expires or is signed out elsewhere.
 *  Shared across every WS endpoint (collab, terminal, ...) so there's one
 *  Postgres poll for revocation regardless of how many endpoints exist. */
class SessionRegistry {
  private socketsByToken = new Map<string, Set<WebSocket>>();
  private revalidating = false;

  private revalidate = setInterval(() => {
    if (this.revalidating || this.socketsByToken.size === 0) return;
    this.revalidating = true;
    const tokens = [...this.socketsByToken.keys()];
    liveTokens(tokens)
      .then((live) => {
        for (const token of tokens) {
          if (live.has(token)) continue;
          const sockets = this.socketsByToken.get(token);
          if (!sockets) continue;
          for (const ws of sockets) revoke(ws);
          this.socketsByToken.delete(token);
        }
      })
      .catch((err) => console.error("session revalidation failed:", err))
      .finally(() => {
        this.revalidating = false;
      });
  }, REVALIDATE_INTERVAL_MS).unref();

  /** Registers `ws` under `token`; automatically unregistered on close. */
  register(token: string, ws: WebSocket) {
    let sockets = this.socketsByToken.get(token);
    if (!sockets) this.socketsByToken.set(token, (sockets = new Set()));
    sockets.add(ws);
    ws.on("close", () => {
      sockets.delete(ws);
      // Compare identity: a newer upgrade for the same token may have
      // replaced this entry, and that one still needs re-checking.
      if (sockets.size === 0 && this.socketsByToken.get(token) === sockets) {
        this.socketsByToken.delete(token);
      }
    });
  }
}

// One instance for the whole process: every WS endpoint registers its
// sockets here, so revocation (logout, session expiry) reaches all of them
// off a single 30s Postgres poll.
export const sessionRegistry = new SessionRegistry();
