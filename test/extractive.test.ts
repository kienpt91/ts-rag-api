import { describe, expect, it } from "vitest";
import { ExtractiveGenerator } from "../src/generators/extractive.js";
import type { ScoredChunk } from "../src/types.js";

const chunk = (text: string, over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  id: "c",
  documentId: "d",
  title: "T",
  source: null,
  heading: "",
  position: 0,
  text,
  metadata: {},
  score: 0.5,
  ...over,
});

describe("ExtractiveGenerator", () => {
  const generator = new ExtractiveGenerator();

  it("quotes the sentence that best matches the question and cites its chunk", async () => {
    const answer = await generator.generate({
      question: "How long do card refunds take?",
      chunks: [chunk("Refunds go to the original method. Card refunds take 5 to 10 business days. Store credit is instant.")],
    });
    expect(answer).toBe("Card refunds take 5 to 10 business days. [1]");
  });

  it("adds later chunks only when they share terms with the question", async () => {
    const answer = await generator.generate({
      question: "password length",
      chunks: [chunk("Passwords need 14 characters. Use a manager."), chunk("Unrelated lunch menu."), chunk("The password length is checked at login.")],
    });
    expect(answer).toContain("[1]");
    expect(answer).not.toContain("[2]");
    expect(answer).toContain("The password length is checked at login. [3]");
  });

  it("drops later chunks that only match a single question term", async () => {
    const answer = await generator.generate({
      question: "How long do card refunds take?",
      chunks: [chunk("Card refunds usually appear within 5 to 10 business days."), chunk("The restore drill records how long it took.")],
    });
    expect(answer).toBe("Card refunds usually appear within 5 to 10 business days. [1]");
  });

  it("strips list markers and skips code fences", async () => {
    const answer = await generator.generate({
      question: "restore snapshot",
      chunks: [chunk("```sh\nrestore --snapshot\n```\n1. Restore the latest snapshot into a new instance.")],
    });
    expect(answer).toBe("Restore the latest snapshot into a new instance. [1]");
  });

  it("limits the number of quoted sources", async () => {
    const limited = new ExtractiveGenerator({ maxSources: 1 });
    const chunks = [chunk("Alpha beta."), chunk("Alpha gamma.")];
    expect(await limited.generate({ question: "alpha", chunks })).toBe("Alpha beta. [1]");
  });
});
