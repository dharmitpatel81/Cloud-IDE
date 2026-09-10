import Fastify from "fastify";
import cors from "@fastify/cors";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runInContainer } from "./runner.js";
import { attachCollabServer } from "./collab.js";


// Without an explicit logger, app.log is a no-op and every error we "log" is discarded.
const app = Fastify({ logger: true, requestTimeout: 30000 });
await app.register(cors, { origin: "http://localhost:5173" });

// Never let a raw error (host paths, docker socket errors, stack traces)
// reach the browser — the program's stderr is the product, ours isn't.
app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.status(500).send({ error: "Something went wrong running your code." });
});

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
await mkdir(WORKSPACE_DIR, { recursive: true });

app.post("/run", async (request, reply) => {
  const { code } = request.body as { code: string };

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
