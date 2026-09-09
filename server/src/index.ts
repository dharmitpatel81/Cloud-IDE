import Fastify from "fastify";
import cors from "@fastify/cors";
import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runInContainer } from "./runner.js";

const app = Fastify();
await app.register(cors, { origin: "http://localhost:5173" });

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
await mkdir(WORKSPACE_DIR, { recursive: true });

app.post("/run", async (request, reply) => {
  const { code } = request.body as { code: string };

  const filename = `${randomUUID()}.py`;
  const filepath = path.join(WORKSPACE_DIR, filename);
  await writeFile(filepath, code);

  const result = await runInContainer(filepath);
  return result;

});

app.listen({ port: 3001, host: "127.0.0.1" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log("Server running on http://127.0.0.1:3001");
});
