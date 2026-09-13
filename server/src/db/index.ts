import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env.js";
import * as schema from "./schema.js";

// A stalled query must not hang whatever is waiting on it — the collab
// revalidation pass in particular skips its next run until this one finishes.
const pool = new Pool({ connectionString: env.DATABASE_URL, statement_timeout: 5000 });

export const db = drizzle(pool, { schema });
