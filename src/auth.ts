import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison that does not leak the length of the expected value: both sides are
 * hashed to fixed-size digests before `timingSafeEqual`.
 */
export function safeEqual(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Extracts the credential from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim());
    if (match) return match[1]!.trim();
  }
  const header = headers["x-api-key"];
  return typeof header === "string" ? header.trim() : undefined;
}

const LOOPBACK = /^127(\.\d{1,3}){3}$/;

/** True for hosts that only accept connections from the local machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || LOOPBACK.test(h);
}
