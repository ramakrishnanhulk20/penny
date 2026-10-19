import { createHash, randomBytes } from "node:crypto";

/** The browser reads the token from the link's #fragment and sends it here, so it never sits in a URL the server sees. */
export const GROUP_TOKEN_HEADER = "x-penny-group";

// 16 random bytes in base64url without padding is always exactly 22 characters.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{22}$/;

/** Mints a new group link token (128 bits from the OS random source) and the hash to store for it. */
export function mintGroupToken(): { token: string; hash: string } {
  const token = randomBytes(16).toString("base64url");
  return { token, hash: hashGroupToken(token) };
}

/** Returns the token only if it is exactly 22 url-safe base64 characters, else null. Never trims or repairs. */
export function parseGroupToken(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !TOKEN_FORMAT.test(raw)) return null;
  return raw;
}

/** sha256 of the token string as 64 lowercase hex characters. Creation and lookup both hash through here. */
export function hashGroupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
