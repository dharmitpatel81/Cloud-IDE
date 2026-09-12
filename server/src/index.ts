import Fastify from "fastify";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { runInContainer } from "./runner.js";
import { attachCollabServer } from "./collab.js";
import cookie from "@fastify/cookie";
import { authRoutes, currentUser, cleanupExpiredSessions } from "./auth/routes.js";
import { projectRoutes } from "./projects/routes.js";
import { ALLOWED_HOSTS } from "./allowlist.js";

// Without an explicit logger, app.log is a no-op and every error we "log" is discarded.
const app = Fastify({ logger: true, requestTimeout: 30000 });

// Fastify freezes the error handler per-route at registration time, so this
// must come before any register() call — a route registered first falls
// through to the default handler, which sends the raw error (host paths,
// docker socket errors, stack traces) straight to the browser.
app.setErrorHandler((error, _request, reply) => {
  // Fastify's own 4xx errors (malformed JSON, body too large) are the
  // client's problem and keep their status; only real faults become 500.
  // Fastify 5 types the error as unknown; its own errors carry statusCode.
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const status =
    typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  if (status === 500) app.log.error(error);
  const message =
    status === 500
      ? "Something went wrong."
      : status === 413
        ? "That's too large to send."
        : "That request couldn't be processed.";
  reply.status(status).send({ error: message });
});

// DNS rebinding: a page on another site can point its own hostname at
// 127.0.0.1 and then count as same-origin with this server. Only answer to
// the names we're actually reached by.
app.addHook("onRequest", async (request, reply) => {
  if (ALLOWED_HOSTS.has(request.headers.host ?? "")) return;
  reply.status(421).send({ error: "Misdirected request." });
  return reply;
});

// Every response here depends on the session cookie, so none of it is safe
// to cache — a stale cached "signed in" response after logout is exactly the
// kind of bug that's invisible until someone hits it by chance.
app.addHook("onSend", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
});

// No CORS plugin, on purpose. The browser only ever talks to Vite on :5173,
// which proxies to us, so every request is same-origin. Without CORS headers
// the browser's default applies: other origins can't read our responses.
await app.register(cookie);
await app.register(authRoutes);
await app.register(projectRoutes);

const runBody = z.object({ code: z.string().max(1024 * 1024) });

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
await mkdir(WORKSPACE_DIR, { recursive: true });

app.post("/run", async (request, reply) => {
  // Unauthenticated since Phase 1, because it never looked like an auth
  // problem — it looked like a code runner.
  const user = await currentUser(request);
  if (!user) return reply.status(401).send({ error: "Not signed in." });

  const parsed = runBody.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: "Expected a code string." });
  const { code } = parsed.data;

  const filename = `${randomUUID()}.py`;
  const filepath = path.join(WORKSPACE_DIR, filename);
  await writeFile(filepath, code);

  try {
    const result = await runInContainer(filepath);
    return result;
  } finally {
    await unlink(filepath).catch(() => { });
  }
});

attachCollabServer(app.server);

// A session's row can outlive its cookie's expiry with nobody ever deleting
// it. Sweep hourly rather than relying solely on "deleted on next use."
setInterval(() => {
  cleanupExpiredSessions().catch((err) => app.log.error(err));
}, 60 * 60 * 1000).unref();
cleanupExpiredSessions().catch((err) => app.log.error(err));

app.listen({ port: 3001, host: "127.0.0.1" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log("Server running on http://127.0.0.1:3001");
});
