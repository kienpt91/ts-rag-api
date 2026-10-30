import { beforeEach, describe, expect, it } from "vitest";
import type { StoredChunk, VectorStore } from "../../src/types.js";

export const DIMS = 4;

export function chunk(id: string, embedding: number[], extra: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id,
    documentId: "doc-a",
    title: "Doc A",
    source: null,
    heading: "",
    position: 0,
    text: `text of ${id}`,
    metadata: {},
    embedding,
    ...extra,
  };
}

/** Behaviour every VectorStore implementation must share. `create` must return an empty store. */
export function describeVectorStore(
  label: string,
  create: () => Promise<VectorStore>,
  options: {
    skip?: boolean;
    transactional?: boolean;
    /** False for stores that share one connection and therefore serialise all documents. Default true. */
    parallelDocuments?: boolean;
  } = {},
) {
  describe.skipIf(options.skip)(`VectorStore contract: ${label}`, () => {
    let store: VectorStore;
    beforeEach(async () => {
      store = await create();
    });

    it("ranks by cosine similarity and returns the stored fields", async () => {
      await store.upsert([
        chunk("x", [1, 0, 0, 0], { heading: "H > X", source: "s3://x", metadata: { team: "a" }, position: 3 }),
        chunk("y", [0, 1, 0, 0]),
        chunk("xy", [1, 1, 0, 0]),
      ]);
      const hits = await store.search([1, 0.1, 0, 0], 3);
      expect(hits.map((h) => h.id)).toEqual(["x", "xy", "y"]);
      expect(hits[0]).toMatchObject({
        documentId: "doc-a",
        title: "Doc A",
        source: "s3://x",
        heading: "H > X",
        position: 3,
        text: "text of x",
        metadata: { team: "a" },
      });
      expect(hits[0]!.score).toBeGreaterThan(0.99);
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
      expect(hits[2]!.score).toBeLessThan(0.2);
      expect(hits[0]).not.toHaveProperty("embedding");
    });

    it("honours k", async () => {
      await store.upsert([chunk("a", [1, 0, 0, 0]), chunk("b", [0, 1, 0, 0]), chunk("c", [0, 0, 1, 0])]);
      expect(await store.search([1, 1, 1, 0], 2)).toHaveLength(2);
    });

    it("upsert overwrites an existing id instead of duplicating it", async () => {
      await store.upsert([chunk("a", [1, 0, 0, 0], { text: "old" })]);
      await store.upsert([chunk("a", [0, 1, 0, 0], { text: "new" })]);
      expect(await store.count()).toBe(1);
      const [hit] = await store.search([0, 1, 0, 0], 1);
      expect(hit).toMatchObject({ id: "a", text: "new" });
    });

    it("filters by metadata containment", async () => {
      await store.upsert([
        chunk("a", [1, 0, 0, 0], { metadata: { team: "billing", lang: "en" } }),
        chunk("b", [1, 0, 0, 0], { metadata: { team: "infra", lang: "en" } }),
        chunk("c", [1, 0, 0, 0], { metadata: {} }),
      ]);
      expect((await store.search([1, 0, 0, 0], 10, { filter: { team: "billing" } })).map((h) => h.id)).toEqual(["a"]);
      expect((await store.search([1, 0, 0, 0], 10, { filter: { lang: "en" } })).map((h) => h.id).sort()).toEqual(["a", "b"]);
      expect(await store.search([1, 0, 0, 0], 10, { filter: { team: "billing", lang: "de" } })).toEqual([]);
      expect(await store.search([1, 0, 0, 0], 10, { filter: {} })).toHaveLength(3);
    });

    it("lists and deletes chunk ids per document", async () => {
      await store.upsert([
        chunk("a1", [1, 0, 0, 0], { documentId: "a" }),
        chunk("a2", [0, 1, 0, 0], { documentId: "a" }),
        chunk("b1", [0, 0, 1, 0], { documentId: "b" }),
      ]);
      expect((await store.chunkIds("a")).sort()).toEqual(["a1", "a2"]);
      await store.delete(["a1", "does-not-exist"]);
      await store.delete([]);
      expect(await store.chunkIds("a")).toEqual(["a2"]);
      expect(await store.count()).toBe(2);
      expect(await store.chunkIds("missing")).toEqual([]);
    });

    it("withDocumentLock runs same-document callbacks one at a time and different documents concurrently", async () => {
      const log: string[] = [];
      const hold = (name: string, documentId: string, ms: number) =>
        store.withDocumentLock(documentId, async () => {
          log.push(`start ${name}`);
          await new Promise((r) => setTimeout(r, ms));
          log.push(`end ${name}`);
        });
      await Promise.all([hold("a1", "a", 40), hold("a2", "a", 5), hold("b", "b", 5)]);
      expect(log.indexOf("end a1")).toBeLessThan(log.indexOf("start a2"));
      if (options.parallelDocuments !== false) expect(log.indexOf("start b")).toBeLessThan(log.indexOf("end a1"));
    });

    it("withDocumentLock returns the callback result and keeps serving after a callback throws", async () => {
      await expect(store.withDocumentLock("a", async () => 42)).resolves.toBe(42);
      await expect(
        store.withDocumentLock("a", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(store.withDocumentLock("a", async (s) => s.count())).resolves.toBe(0);
    });

    it.skipIf(!options.transactional)("withDocumentLock rolls back every write when the callback throws", async () => {
      await store.upsert([chunk("keep", [1, 0, 0, 0], { documentId: "a" })]);
      await expect(
        store.withDocumentLock("a", async (tx) => {
          await tx.upsert([chunk("new", [0, 1, 0, 0], { documentId: "a" })]);
          await tx.delete(["keep"]);
          throw new Error("fail midway");
        }),
      ).rejects.toThrow("fail midway");
      expect(await store.chunkIds("a")).toEqual(["keep"]);
    });

    it("returns nothing from an empty store", async () => {
      expect(await store.search([1, 0, 0, 0], 5)).toEqual([]);
      expect(await store.count()).toBe(0);
    });
  });
}
