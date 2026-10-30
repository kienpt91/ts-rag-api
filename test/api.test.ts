import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app.js";
import { UpstreamError, type AnswerGenerator } from "../src/types.js";
import { createTestService } from "./helpers/fixtures.js";

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

function start(options: { bodyLimit?: number; generator?: AnswerGenerator } & Partial<AppOptions> = {}) {
  const { generator, ...appOptions } = options;
  const { service, store } = createTestService(generator ? { generator } : {});
  app = buildApp({ service, healthCheck: () => store.count(), ...appOptions });
  return { store };
}

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

describe("GET /health", () => {
  it("reports component names and chunk count", async () => {
    start();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", embedder: "hashing-1536", store: "memory", generator: "extractive", chunks: 0 });
  });

  it("returns 503 when the store is unreachable", async () => {
    const { service } = createTestService();
    app = buildApp({ service, healthCheck: async () => { throw new Error("connection refused"); } });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("unavailable");
  });
});

describe("POST /documents", () => {
  it("returns 201 on first ingest and 200 when nothing changed", async () => {
    start();
    const body = { id: "faq", title: "FAQ", source: "https://example.com/faq", metadata: { team: "support" }, text: "# FAQ\n\nRefunds take five days." };
    const first = await post("/documents", body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ documentId: "faq", title: "FAQ", chunks: 1, added: 1, removed: 0, unchanged: false });
    const second = await post("/documents", body);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ added: 0, unchanged: true });
  });

  it.each([
    ["missing text", {}],
    ["blank text", { text: "   \n " }],
    ["non-string text", { text: 42 }],
    ["bad id characters", { id: "has space/slash", text: "x" }],
    ["empty title", { title: " ", text: "x" }],
    ["non-string metadata value", { text: "x", metadata: { a: 1 } }],
    ["too many metadata keys", { text: "x", metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) }],
    ["text over the schema limit", { text: "x".repeat(500_001) }],
  ])("rejects %s with 400 and a field-level message", async (_name, payload) => {
    start({ bodyLimit: 2 * 1024 * 1024 });
    const res = await post("/documents", payload);
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe("invalid_request");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues[0]).toHaveProperty("path");
  });

  it("rejects bodies larger than the configured limit with 413", async () => {
    start({ bodyLimit: 1024 });
    const res = await post("/documents", { text: "x".repeat(5000) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("rejects malformed JSON, non-JSON bodies and unsupported content types", async () => {
    start();
    const bad = await app.inject({ method: "POST", url: "/documents", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    const plain = await app.inject({ method: "POST", url: "/documents", headers: { "content-type": "text/plain" }, payload: "hello" });
    expect(plain.statusCode).toBe(400);
    const text = await app.inject({ method: "POST", url: "/documents", headers: { "content-type": "application/xml" }, payload: "<a/>" });
    expect(text.statusCode).toBe(415);
    expect(text.json().error.code).toBe("unsupported_media_type");
  });
});

describe("POST /query", () => {
  it("returns the answer, citations and ranked chunks", async () => {
    start();
    await post("/documents", { id: "refunds", text: "# Refund Policy\n\n## Processing time\n\nCard refunds usually appear within 5 to 10 business days." });
    await post("/documents", { id: "ops", text: "# Backups\n\nSnapshots are taken nightly at 02:00 UTC." });

    const res = await post("/query", { question: "How long do card refunds take?", topK: 2 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer).toBe("Card refunds usually appear within 5 to 10 business days. [1]");
    expect(body.citations).toEqual([
      expect.objectContaining({ ref: 1, label: "Refund Policy > Processing time", documentId: "refunds", source: null }),
    ]);
    expect(body.chunks[0]).toMatchObject({ documentId: "refunds", heading: "Refund Policy > Processing time" });
    expect(body.chunks[0].score).toBeGreaterThan(0.2);
    expect(body.chunks.length).toBeLessThanOrEqual(2);
  });

  it("says so when nothing relevant is indexed", async () => {
    start();
    const res = await post("/query", { question: "anything at all" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ citations: [], chunks: [], answer: expect.stringContaining("could not find") });
  });

  it.each([
    ["missing question", {}],
    ["empty question", { question: "  " }],
    ["question too long", { question: "q".repeat(2001) }],
    ["topK zero", { question: "q", topK: 0 }],
    ["topK too large", { question: "q", topK: 21 }],
    ["topK fractional", { question: "q", topK: 1.5 }],
    ["filter with non-string value", { question: "q", filter: { a: true } }],
  ])("rejects %s with 400", async (_name, payload) => {
    start();
    const res = await post("/query", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
  });

  it("maps upstream failures to 502 with a generic message and logs the detail", async () => {
    const detail = "Upstream /chat/completions responded 503: connect ECONNREFUSED 10.0.3.7:8443 (internal-llm.corp.example)";
    const lines: string[] = [];
    const { service } = createTestService({
      generator: {
        name: "broken",
        generate: async () => {
          throw new UpstreamError(detail, 503);
        },
      },
    });
    app = buildApp({ service, logger: { level: "error", stream: { write: (line: string) => void lines.push(line) } } as never });
    await post("/documents", { id: "d", text: "Refunds take five days." });
    const res = await post("/query", { question: "refunds" });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toEqual({ code: "upstream_error", message: expect.any(String) });
    expect(res.body).not.toMatch(/10\.0\.3\.7|8443|internal-llm|ECONNREFUSED|503|chat\/completions/);
    expect(lines.join("")).toContain("internal-llm.corp.example");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    start();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("API key authentication", () => {
  const apiKey = "correct-horse-battery-staple";
  const doc = { id: "d", text: "Refunds take five days." };
  const call = (url: string, headers: Record<string, string> = {}, payload: object = doc) =>
    app.inject({ method: "POST", url, headers, payload });

  it("rejects requests without a key, with a wrong key, and with a wrong-length key", async () => {
    start({ apiKey });
    for (const url of ["/documents", "/query"]) {
      const missing = await call(url, {}, { question: "q" });
      expect(missing.statusCode).toBe(401);
      expect(missing.json().error.code).toBe("unauthorized");
      expect(missing.headers["www-authenticate"]).toContain("Bearer");
      expect((await call(url, { authorization: "Bearer nope" })).statusCode).toBe(401);
      expect((await call(url, { authorization: `Bearer ${apiKey}x` })).statusCode).toBe(401);
      expect((await call(url, { authorization: `Bearer ${apiKey.slice(0, -1)}` })).statusCode).toBe(401);
      expect((await call(url, { "x-api-key": "" })).statusCode).toBe(401);
      expect((await call(url, { authorization: `Basic ${apiKey}` })).statusCode).toBe(401);
    }
  });

  it("checks the key before parsing or validating the body", async () => {
    start({ apiKey });
    const res = await app.inject({ method: "POST", url: "/documents", headers: { "content-type": "application/json" }, payload: "{bad json" });
    expect(res.statusCode).toBe(401);
  });

  it("does not store anything for unauthenticated writes", async () => {
    start({ apiKey });
    await call("/documents");
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json().chunks).toBe(0);
  });

  it("accepts the key as a bearer token or an X-API-Key header", async () => {
    start({ apiKey });
    expect((await call("/documents", { authorization: `Bearer ${apiKey}` })).statusCode).toBe(201);
    expect((await call("/query", { "x-api-key": apiKey }, { question: "refunds" })).statusCode).toBe(200);
    expect((await call("/query", { authorization: `bearer   ${apiKey}  ` }, { question: "refunds" })).statusCode).toBe(200);
  });

  it("leaves /health open", async () => {
    start({ apiKey });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("does not require a key when none is configured", async () => {
    start();
    expect((await call("/documents")).statusCode).toBe(201);
  });
});

describe("rate limiting", () => {
  const query = () => app.inject({ method: "POST", url: "/query", payload: { question: "refunds" } });

  it("returns 429 with Retry-After once the window budget is spent", async () => {
    start({ rateLimit: { max: 3, windowMs: 60_000 } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await query()).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    const limited = await query();
    expect(limited.json().error.code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("applies to ingestion as well and leaves /health alone", async () => {
    start({ rateLimit: { max: 1, windowMs: 60_000 } });
    expect((await app.inject({ method: "POST", url: "/documents", payload: { text: "a note" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/documents", payload: { text: "another note" } })).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("throttles wrong-key guesses before they reach authentication", async () => {
    start({ apiKey: "correct-horse-battery-staple", rateLimit: { max: 2, windowMs: 60_000 } });
    const guess = () => app.inject({ method: "POST", url: "/query", headers: { authorization: "Bearer wrong" }, payload: { question: "q" } });
    expect([(await guess()).statusCode, (await guess()).statusCode, (await guess()).statusCode]).toEqual([401, 401, 429]);
  });

  it("is off when no limit is configured or the limit is 0", async () => {
    start();
    for (let i = 0; i < 5; i++) expect((await query()).statusCode).toBe(200);
    await app.close();
    start({ rateLimit: { max: 0, windowMs: 1000 } });
    for (let i = 0; i < 5; i++) expect((await query()).statusCode).toBe(200);
  });
});
