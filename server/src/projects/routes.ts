import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { currentUser } from "../auth/routes.js";

const newProject = z.object({ name: z.string().min(1).max(100) });

export async function projectRoutes(app: FastifyInstance) {
  app.post("/projects", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.status(401).send({ error: "Not signed in." });

    const parsed = newProject.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Project name is required." });
    }

    const [project] = await db
      .insert(projects)
      .values({ name: parsed.data.name, ownerId: user.id })
      .returning();
    return project;
  });

  app.get("/projects", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.status(401).send({ error: "Not signed in." });

    return db.select().from(projects).where(eq(projects.ownerId, user.id));
  });

  app.get("/projects/:id", async (request, reply) => {
    const user = await currentUser(request);
    if (!user) return reply.status(401).send({ error: "Not signed in." });

    const parsed = z.uuid().safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid project id." });

    // Scope the query rather than fetching and then checking. An unauthorized
    // row never leaves the database, so there's no window where it sits in
    // memory waiting for a check someone might refactor away.
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, parsed.data), eq(projects.ownerId, user.id)))
      .limit(1);

    // 404 rather than 403 on purpose: "forbidden" would confirm that a project
    // with this id exists, which is information the caller shouldn't have.
    if (!project) return reply.status(404).send({ error: "No such project." });
    return project;
  });
}