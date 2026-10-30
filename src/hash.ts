import { createHash } from "node:crypto";

export function sha256Hex(...parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(String(part.length));
    h.update(":");
    h.update(part);
  }
  return h.digest("hex");
}

/** 32-bit FNV-1a, used for feature hashing. */
export function fnv1a(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
