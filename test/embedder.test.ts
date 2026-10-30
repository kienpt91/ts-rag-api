import { describe, expect, it } from "vitest";
import { HashingEmbedder } from "../src/embedders/hashing.js";
import { cosine } from "../src/stores/memory.js";

const embedder = new HashingEmbedder();
const one = async (text: string) => (await embedder.embed([text]))[0]!;

describe("HashingEmbedder", () => {
  it("is deterministic and returns unit vectors of the configured size", async () => {
    const [a, b] = await embedder.embed(["Refunds are processed in 5 days", "Refunds are processed in 5 days"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1536);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
    expect(await new HashingEmbedder({ dimensions: 64 }).embed(["x"])).toHaveLength(1);
  });

  it("places texts that share vocabulary closer than unrelated texts", async () => {
    const q = await one("how long do refunds take");
    const related = await one("Refunds take five business days to reach your card.");
    const unrelated = await one("Rotate the database credentials every ninety days.");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated) + 0.1);
  });

  it("treats plurals and verb endings as the same term", async () => {
    expect(cosine(await one("deploying services"), await one("deployed service"))).toBeGreaterThan(0.9);
  });

  it("is case-insensitive and ignores punctuation", async () => {
    expect(cosine(await one("Reset PASSWORD!"), await one("reset password"))).toBeCloseTo(1, 6);
  });

  it("never returns a zero vector, even for stopword-only or symbol-only text", async () => {
    for (const text of ["", "the of and", "!!!", "🙂🙂"]) {
      const v = await one(text);
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    }
  });

  it("rejects absurd dimensions", () => {
    expect(() => new HashingEmbedder({ dimensions: 2 })).toThrow(RangeError);
  });
});
