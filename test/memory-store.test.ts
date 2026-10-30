import { describe, expect, it } from "vitest";
import { InMemoryVectorStore, cosine } from "../src/stores/memory.js";
import { chunk, describeVectorStore } from "./helpers/store-contract.js";

describeVectorStore("in-memory", async () => new InMemoryVectorStore());

describe("InMemoryVectorStore", () => {
  it("does not let callers mutate stored metadata", async () => {
    const store = new InMemoryVectorStore();
    const input = chunk("a", [1, 0, 0, 0], { metadata: { k: "v" } });
    await store.upsert([input]);
    input.metadata.k = "changed";
    const [hit] = await store.search([1, 0, 0, 0], 1);
    expect(hit!.metadata).toEqual({ k: "v" });
  });

  it("scores zero vectors as 0 rather than NaN", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
});
