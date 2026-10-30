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
export function describeVectorStore(label: string, create: () => Promise<VectorStore>, options: { skip?: boolean } = {}) {
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

    it("returns nothing from an empty store", async () => {
      expect(await store.search([1, 0, 0, 0], 5)).toEqual([]);
      expect(await store.count()).toBe(0);
    });
  });
}
