import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; maxmem: number },
) => Promise<Buffer>;

const KEY_LENGTH = 64;
// Node's own scrypt default (N = 2^14) is below current guidance. scrypt's
// memory cost is roughly 128 * N * r bytes (r=8 here), so raising N means
// raising maxmem too, or the call rejects with ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
const SCRYPT_N = 1 << 16; // 65536
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const LEGACY_N = 1 << 14; // what hashPassword used before this file recorded N

export async function hashPassword(password: string): Promise<string> {
  // A per-user random salt means two people with the same password get
  // different hashes, so one cracked hash doesn't reveal the other.
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    maxmem: SCRYPT_MAXMEM,
  });
  // The cost parameter travels with the hash so it can be raised later
  // without invalidating existing rows, and so an old row is identifiable
  // for a rehash-on-next-login migration.
  return `scrypt$${SCRYPT_N}$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  let salt: string | undefined;
  let hash: string | undefined;
  let N: number;

  if (stored.startsWith("scrypt$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    N = Number(parts[1]);
    salt = parts[2];
    hash = parts[3];
    if (!Number.isInteger(N) || N <= 0) return false;
  } else {
    // Format from before this file recorded cost parameters: "salt:hash",
    // hashed at Node's scrypt default.
    [salt, hash] = stored.split(":");
    N = LEGACY_N;
  }
  if (!salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { N, maxmem: SCRYPT_MAXMEM });

  // Constant-time compare. A plain === returns early on the first differing
  // byte, and that timing difference is enough to reconstruct the hash one
  // byte at a time.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
