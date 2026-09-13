import type { FastifyInstance } from "fastify";
import path from "node:path";
import { z } from "zod";
import { currentUser } from "../auth/routes.js";
import { runInContainer, type Runtime } from "../runner.js";
import { fileList, problemWithFiles, writeProjectFiles, type FileEntry } from "../projectFiles.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const runBody = z.object({
  entry: z.string(),
  files: fileList.min(1),
});
type RunBody = z.infer<typeof runBody>;

function runtimeFor(filePath: string): Runtime | null {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === ".py") return "python";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "node";
  return null;
}

/** What's wrong with this request, in words fit for the user. */
function problemWith({ entry, files }: RunBody): string | null {
  const problem = problemWithFiles(files);
  if (problem) return problem;
  if (!files.some((file: FileEntry) => file.path === entry)) return "The file to run isn't in the project.";
  if (!runtimeFor(entry)) return "Only .py and .js files can run.";
  return null;
}

export async function runRoutes(app: FastifyInstance) {
  // A whole project fits in 5 MB; the rest of the API keeps Fastify's 1 MB.
  app.post("/run", { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    // Unauthenticated since Phase 1, because it never looked like an auth
    // problem — it looked like a code runner.
    const user = await currentUser(request);
    if (!user) return reply.status(401).send({ error: "Not signed in." });

    const parsed = runBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Expected a file to run and the project's files." });
    }
    const problem = problemWith(parsed.data);
    if (problem) return reply.status(400).send({ error: problem });
    const runtime = runtimeFor(parsed.data.entry);
    if (!runtime) return reply.status(400).send({ error: "Only .py and .js files can run." });

    // A fresh folder per run, so two runs never see each other's files.
    const { dir, cleanup } = await writeProjectFiles(parsed.data.files);
    try {
      return await runInContainer({ hostDir: dir, entry: parsed.data.entry, runtime });
    } finally {
      await cleanup();
    }
  });
}
