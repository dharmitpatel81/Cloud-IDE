import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./password.js";

export const SESSION_COOKIE = "sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
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

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ error: "That email is already registered." });
    }

    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(password) })
      .returning({ id: users.id, email: users.email });

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

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
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
