import Fastify from "fastify";
import cors from "@fastify/cors";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { runInContainer } from "./runner.js";
import { attachCollabServer } from "./collab.js";
import cookie from "@fastify/cookie";
import { authRoutes, currentUser } from "./auth/routes.js";
import { projectRoutes } from "./projects/routes.js";

// Without an explicit logger, app.log is a no-op and every error we "log" is discarded.
const app = Fastify({ logger: true, requestTimeout: 30000 });
await app.register(cors, { origin: "http://localhost:5173" });
await app.register(cookie);
await app.register(authRoutes);
await app.register(projectRoutes);

// Never let a raw error (host paths, docker socket errors, stack traces)
// reach the browser — the program's stderr is the product, ours isn't.
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.status(500).send({ error: "Something went wrong running your code." });
});

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

app.listen({ port: 3001, host: "127.0.0.1" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log("Server running on http://127.0.0.1:3001");
});
