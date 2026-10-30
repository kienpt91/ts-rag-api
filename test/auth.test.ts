import { describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { extractApiKey, isLoopbackHost, safeEqual } from "../src/auth.js";

describe("safeEqual", () => {
  it("compares equal and unequal strings of any length without throwing", () => {
    expect(safeEqual("secret-value-123456", "secret-value-123456")).toBe(true);
    expect(safeEqual("secret-value-123456", "secret-value-123457")).toBe(false);
    expect(safeEqual("short", "secret-value-123456")).toBe(false);
    expect(safeEqual("", "secret-value-123456")).toBe(false);
    expect(safeEqual("x".repeat(100_000), "secret-value-123456")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("only ever hands equal-length buffers to timingSafeEqual", () => {
    // timingSafeEqual throws on length mismatch; the digest step is what makes arbitrary lengths safe.
    expect(() => crypto.timingSafeEqual(Buffer.from("a"), Buffer.from("ab"))).toThrow();
    expect(() => safeEqual("a", "abcdefghijkl")).not.toThrow();
  });
});

describe("extractApiKey", () => {
  it("reads bearer tokens case-insensitively and X-API-Key", () => {
    expect(extractApiKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractApiKey({ authorization: "bearer   abc " })).toBe("abc");
    expect(extractApiKey({ "x-api-key": " abc " })).toBe("abc");
    expect(extractApiKey({ authorization: "Basic abc" })).toBeUndefined();
    expect(extractApiKey({})).toBeUndefined();
    expect(extractApiKey({ "x-api-key": ["a", "b"] })).toBeUndefined();
  });
});

describe("isLoopbackHost", () => {
  it("accepts only loopback names and addresses", () => {
    for (const host of ["127.0.0.1", "127.255.0.9", "::1", "[::1]", "localhost"]) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["0.0.0.0", "::", "10.0.0.1", "128.0.0.1", "127.0.0", "127.0.0.1.evil.test", "localhost.evil.test"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("startup refusal", () => {
  it("makes the server entrypoint exit with a clear message when the config is unsafe", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      env: { PATH: process.env.PATH ?? "", HOST: "0.0.0.0", PORT: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API_KEY is required because HOST=0.0.0.0");
    expect(result.stdout).toBe("");
  });
});
