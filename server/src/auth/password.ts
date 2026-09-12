import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  // A per-user random salt means two people with the same password get
  // different hashes, so one cracked hash doesn't reveal the other.
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const derived = await scryptAsync(password, salt, KEY_LENGTH);

  // Constant-time compare. A plain === returns early on the first differing
  // byte, and that timing difference is enough to reconstruct the hash one
  // byte at a time.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
