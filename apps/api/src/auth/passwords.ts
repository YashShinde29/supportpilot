import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's scrypt N=2^15, r=8, p=3 configuration: ~32 MiB per hash.
const N = 32_768;
const R = 8;
const P = 3;
const prefix = `scrypt$${N}$${R}$${P}`;
// A valid-length comparison target for unknown accounts, so they still incur
// the same scrypt work. It is never used as an actual account password hash.
const dummy = `${prefix}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128) throw new Error("Choose a password of 12–128 characters.");
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `${prefix}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored?: string): Promise<boolean> {
  const validFormat = typeof stored === "string" && /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(stored);
  const parts = (validFormat ? stored! : dummy).split("$");
  const actual = await derive(password, Buffer.from(parts[4]!, "base64url"));
  const matches = timingSafeEqual(actual, Buffer.from(parts[5]!, "base64url"));
  return validFormat && matches;
}
