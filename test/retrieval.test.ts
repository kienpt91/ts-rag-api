import { beforeAll, describe, expect, it } from "vitest";
import { NO_ANSWER, citationsFor } from "../src/service.js";
import { loadFixtures } from "../src/eval/run.js";
import { createTestService } from "./helpers/fixtures.js";

const fixtures = await loadFixtures();

describe("retrieval over the fixture corpus", () => {
  const { service } = createTestService();
  beforeAll(async () => {
    for (const doc of fixtures.documents) await service.ingest(doc);
  });

  it.each([
    ["What is the request limit for free accounts?", "api-rate-limits", "60 requests per minute"],
    ["How long are application logs retained?", "data-retention", "30 days"],
    ["How long is one on-call shift?", "on-call-rotation", "one week"],
    ["When do regular releases go out?", "deployment-process", "Tuesday and Thursday"],
    ["What are the recovery time and recovery point objectives?", "backup-and-restore", "4 hours"],
    ["Is SMS accepted as a second factor?", "password-and-access", "SMS codes are not allowed"],
  ])("ranks the right chunk first for %j", async (question, documentId, evidence) => {
    const [top] = await service.retrieve(question, 3);
    expect(top?.documentId).toBe(documentId);
    expect(top?.text).toContain(evidence);
  });

  it("answers with a fixed message and no citations when nothing scores above minScore", async () => {
    const strict = createTestService({ minScore: 0.9 });
    for (const doc of fixtures.documents) await strict.service.ingest(doc);
    const result = await strict.service.query({ question: "How long do card refunds take?" });
    expect(result).toMatchObject({ answer: NO_ANSWER, citations: [], chunks: [] });
    expect(await createTestService().service.query({ question: "anything" })).toMatchObject({ answer: NO_ANSWER, chunks: [] });
  });

  it("restricts retrieval with a metadata filter", async () => {
    const scoped = createTestService();
    await scoped.service.ingest({ id: "a", text: "# Alpha\n\nRefunds take five days.", metadata: { team: "billing" } });
    await scoped.service.ingest({ id: "b", text: "# Beta\n\nRefunds take ten days.", metadata: { team: "legal" } });
    const hits = await scoped.service.retrieve("refunds", 5, { team: "legal" });
    expect(hits.map((h) => h.documentId)).toEqual(["b"]);
  });
});

describe("citations", () => {
  it("cites the retrieved chunk behind each [n] marker with a readable label", async () => {
    const { service } = createTestService();
    for (const doc of fixtures.documents) await service.ingest(doc);
    const result = await service.query({ question: "How long do card refunds take to arrive?", topK: 3 });

    expect(result.answer).toMatch(/\[1\]/);
    expect(result.citations[0]).toMatchObject({
      ref: 1,
      label: "Refund Policy > Processing time",
      documentId: "refund-policy",
      title: "Refund Policy",
      heading: "Refund Policy > Processing time",
    });
    for (const citation of result.citations) {
      const chunk = result.chunks[citation.ref - 1]!;
      expect(citation.chunkId).toBe(chunk.id);
      expect(result.answer).toContain(`[${citation.ref}]`);
    }
    expect(result.generator).toBe("extractive");
  });

  it("ignores out-of-range and repeated markers and keeps first-use order", () => {
    const chunks = [1, 2, 3].map((n) => ({
      id: `c${n}`,
      documentId: "d",
      title: `T${n}`,
      source: null,
      heading: "",
      position: n,
      text: "x",
      metadata: {},
      score: 1 / n,
    }));
    const citations = citationsFor("Claim [3], again [3], bogus [9], zero [0], then [1].", chunks);
    expect(citations.map((c) => [c.ref, c.label])).toEqual([
      [3, "T3"],
      [1, "T1"],
    ]);
  });
});

describe("ingestion", () => {
  const doc = { id: "handbook", text: "# Handbook\n\n## Refunds\n\nRefunds take five days.\n\n## Shipping\n\nShipping takes two days." };

  it("is idempotent: re-ingesting identical input embeds and writes nothing", async () => {
    const { service, store, embedCalls } = createTestService();
    const first = await service.ingest(doc);
    const idsAfterFirst = (await store.chunkIds("handbook")).sort();
    const embedCallsAfterFirst = embedCalls.length;

    const second = await service.ingest(doc);
    expect(first).toMatchObject({ documentId: "handbook", chunks: 2, added: 2, removed: 0, unchanged: false });
    expect(second).toMatchObject({ chunks: 2, added: 0, removed: 0, unchanged: true });
    expect(embedCalls).toHaveLength(embedCallsAfterFirst);
    expect((await store.chunkIds("handbook")).sort()).toEqual(idsAfterFirst);
    expect(await store.count()).toBe(2);
  });

  it("re-embeds only the chunks that changed and drops the ones that vanished", async () => {
    const { service, store, embedCalls } = createTestService();
    await service.ingest(doc);
    embedCalls.length = 0;

    const edited = await service.ingest({ ...doc, text: doc.text.replace("five days", "seven days") });
    expect(edited).toMatchObject({ chunks: 2, added: 1, removed: 1, unchanged: false });
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(1);
    expect(await store.count()).toBe(2);
    const texts = (await service.retrieve("refunds", 5)).map((c) => c.text);
    expect(texts.some((t) => t.includes("seven days"))).toBe(true);
    expect(texts.some((t) => t.includes("five days"))).toBe(false);
  });

  it("derives the document id from the content when none is given", async () => {
    const { service } = createTestService();
    const a = await service.ingest({ text: "Some note about deployments." });
    const b = await service.ingest({ text: "Some note about deployments." });
    const c = await service.ingest({ text: "A different note." });
    expect(a.documentId).toBe(b.documentId);
    expect(b.unchanged).toBe(true);
    expect(c.documentId).not.toBe(a.documentId);
  });

  it("gives identical chunks within one document distinct ids", async () => {
    const { service, store } = createTestService({ chunking: { maxTokens: 8, overlapTokens: 0 } });
    const paragraph = "Same paragraph repeated here.";
    const result = await service.ingest({ id: "dup", text: [paragraph, paragraph, paragraph].join("\n\n") });
    expect(result.chunks).toBe(3);
    expect(new Set(await store.chunkIds("dup")).size).toBe(3);
    expect(await service.ingest({ id: "dup", text: [paragraph, paragraph, paragraph].join("\n\n") })).toMatchObject({ unchanged: true });
  });

  it("treats changed metadata as a change and serves the new metadata", async () => {
    const { service, store } = createTestService();
    await service.ingest({ id: "m", text: "Refunds take five days.", metadata: { version: "1" } });
    const changed = await service.ingest({ id: "m", text: "Refunds take five days.", metadata: { version: "2" } });
    expect(changed).toMatchObject({ added: 1, removed: 1, unchanged: false });
    expect(await store.count()).toBe(1);
    expect((await service.retrieve("refunds", 1))[0]?.metadata).toEqual({ version: "2" });
  });

  it("falls back to the first heading, then the id, for the title", async () => {
    const { service } = createTestService();
    expect((await service.ingest({ id: "t1", text: "# Real Title\n\nBody." })).title).toBe("Real Title");
    expect((await service.ingest({ id: "t2", text: "No heading." })).title).toBe("t2");
    expect((await service.ingest({ id: "t3", title: "Explicit", text: "# Real Title\n\nBody." })).title).toBe("Explicit");
  });
});
