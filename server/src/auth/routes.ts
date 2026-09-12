import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./password.js";

export const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A fixed, never-matching hash to run login against when the email isn't
// registered, so that branch pays the same scrypt cost as a real one. Without
// this, "unknown email" answers in ~1ms and "wrong password" in ~100ms — a
// timing oracle that reveals which emails have accounts.
const dummyPasswordHash = hashPassword(randomBytes(32).toString("hex"));

const credentials = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
});

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, // JS can't read it, so an XSS can't walk off with the session
    sameSite: "lax",
    secure: false, // localhost is plain http; must be true anywhere real
    path: "/",
    expires: expiresAt,
  });
}

async function issueSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return { token, expiresAt };
}

/** Reads one cookie out of a raw `Cookie:` header. The WebSocket upgrade is a
 *  plain http request, not a Fastify one, so it has no parsed `cookies`. */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        // A malformed value (e.g. a stray `%`) should read as "no session",
        // not throw — the HTTP-request cookie path tolerates this too.
        return undefined;
      }
    }
  }
  return undefined;
}

/** Deletes session rows nobody has presented in a while. `userFromToken` only
 *  deletes a row when that exact token is looked up again, so an abandoned
 *  session otherwise sits in the table forever after it expires. */
export async function cleanupExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export async function userFromToken(token: string | undefined) {
  if (!token) return null;

  const [found] = await db
    .select({ id: users.id, email: users.email, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1);

  if (!found) return null;
  if (found.expiresAt < new Date()) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return null;
  }
  return { id: found.id, email: found.email };
}

export function currentUser(request: FastifyRequest) {
  return userFromToken(request.cookies[SESSION_COOKIE]);
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "Email must be valid and password at least 8 characters." });
    }
    const { email, password } = parsed.data;

    // No separate "does this email exist" check first: a select-then-insert
    // has a race where two requests for the same email can both pass the
    // check before either inserts. The unique index is the actual guard, so
    // the insert itself has to be the thing that decides.
    let user: { id: string; email: string };
    try {
      [user] = await db
        .insert(users)
        .values({ email, passwordHash: await hashPassword(password) })
        .returning({ id: users.id, email: users.email });
    } catch (err) {
      // Drizzle wraps the driver error in DrizzleQueryError; the real
      // Postgres code (23505 = unique_violation) is on `.cause`, not on the
      // error itself.
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
        return reply.status(409).send({ error: "That email is already registered." });
      }
      throw err;
    }

    const { token, expiresAt } = await issueSession(user.id);
    setSessionCookie(reply, token, expiresAt);
    return user;
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = credentials.safeParse(request.body);
    // Deliberately the same message as a wrong password below: telling the
    // caller which one was wrong lets them enumerate who has an account.
    if (!parsed.success) {
      return reply.status(401).send({ error: "Invalid email or password." });
    }
    const { email, password } = parsed.data;

    const [user] = await db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Always pay the scrypt cost, even for an email that doesn't exist, so
    // "no such user" and "wrong password" take the same amount of time.
    const passwordOk = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, await dummyPasswordHash);

    if (!user || !passwordOk) {
      return reply.status(401).send({ error: "Invalid email or password." });
    }

    const { token, expiresAt } = await issueSession(user.id);
    setSessionCookie(reply, token, expiresAt);
    return { id: user.id, email: user.email };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.token, token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.status(401).send({ error: "Not signed in." });
    return user;
  });
}
