import { config } from "dotenv";
import { z } from "zod";

config({ path: "../.env" });

const schema = z.object({
  DATABASE_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail at boot, loudly. A missing var should never surface later as a
  // confusing runtime error, and a secret should never quietly default.
  console.error("Invalid environment:", z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
