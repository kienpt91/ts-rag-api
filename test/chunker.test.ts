import { describe, expect, it } from "vitest";
import { chunkMarkdown, estimateTokens } from "../src/chunker.js";

const lorem = (sentences: number, tag = "s") =>
  Array.from({ length: sentences }, (_, i) => `Sentence ${tag}${i} talks about topic number ${i} in some detail.`).join(" ");

describe("chunkMarkdown", () => {
  it("returns nothing for blank input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("  \n\n \n")).toEqual([]);
    expect(chunkMarkdown("# Only a heading")).toEqual([]);
  });

  it("keeps a short document as one chunk without a heading", () => {
    const chunks = chunkMarkdown("Just a plain note.\n\nWith two paragraphs.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ heading: "", position: 0, text: "Just a plain note.\n\nWith two paragraphs." });
  });

  it("never crosses headings and records the heading path", () => {
    const md = ["# Handbook", "Intro text.", "## Refunds", "Refund text.", "### Exceptions", "Exception text.", "## Shipping", "Shipping text."].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks.map((c) => [c.heading, c.text])).toEqual([
      ["Handbook", "Intro text."],
      ["Handbook > Refunds", "Refund text."],
      ["Handbook > Refunds > Exceptions", "Exception text."],
      ["Handbook > Shipping", "Shipping text."],
    ]);
    expect(chunks.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  });

  it("ignores # lines inside code fences", () => {
    const md = "# Title\n\n```sh\n# not a heading\necho hi\n\necho there\n```\n\nAfter the code.";
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Title");
    expect(chunks[0]!.text).toContain("# not a heading\necho hi\n\necho there");
  });

  it("packs paragraphs up to the token limit and overlaps consecutive chunks", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${"word ".repeat(18)}`.trim());
    const md = `# Doc\n\n${paragraphs.join("\n\n")}`;
    const chunks = chunkMarkdown(md, { maxTokens: 80, overlapTokens: 30 });

    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(80);

    for (let i = 1; i < chunks.length; i++) {
      const lastParagraphOfPrev = chunks[i - 1]!.text.split("\n\n").at(-1)!;
      expect(chunks[i]!.text.startsWith(lastParagraphOfPrev)).toBe(true);
    }
    const covered = new Set(chunks.flatMap((c) => c.text.split("\n\n")));
    for (const p of paragraphs) expect(covered.has(p)).toBe(true);
  });

  it("splits an oversized paragraph on sentence boundaries", () => {
    const chunks = chunkMarkdown(lorem(30), { maxTokens: 60, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(60);
      expect(c.text.endsWith(".")).toBe(true);
      expect(c.text.startsWith("Sentence")).toBe(true);
    }
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect(rejoined).toBe(lorem(30));
  });

  it("hard-splits a single token-less run that exceeds the limit", () => {
    const chunks = chunkMarkdown("x".repeat(1000), { maxTokens: 50, overlapTokens: 0 });
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true);
    expect(chunks.map((c) => c.text).join("")).toBe("x".repeat(1000));
  });

  it("splits long code fences on line boundaries", () => {
    const code = Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i});`).join("\n");
    const chunks = chunkMarkdown("## Example\n\n```ts\n" + code + "\n```", { maxTokens: 60, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(60);
  });

  it("is deterministic and tolerates CRLF line endings", () => {
    const md = "# A\r\n\r\nFirst.\r\n\r\n## B\r\n\r\nSecond.";
    expect(chunkMarkdown(md)).toEqual(chunkMarkdown(md.replaceAll("\r\n", "\n")));
    expect(chunkMarkdown(md)).toEqual(chunkMarkdown(md));
  });

  it("rejects impossible options", () => {
    expect(() => chunkMarkdown("x", { maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkMarkdown("x", { maxTokens: 10, overlapTokens: 10 })).toThrow(RangeError);
  });
});
