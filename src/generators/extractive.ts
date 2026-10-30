import { terms } from "../text.js";
import type { AnswerGenerator, GenerateInput } from "../types.js";

export interface ExtractiveOptions {
  /** How many of the best chunks contribute a sentence to the answer. */
  maxSources?: number;
}

function sentences(text: string): string[] {
  return text
    .replace(/^ {0,3}(```|~~~)[\s\S]*?(?:^ {0,3}\1.*$|(?![\s\S]))/gm, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^#+\s+/, "").trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * Answers without a language model: for each of the best chunks it quotes the sentence that shares the
 * most terms with the question and tags it with the chunk's citation number. The first chunk is always
 * quoted; later ones only if their best sentence matches at least two question terms (all of them for
 * very short questions) and at least half as many as the first.
 */
export class ExtractiveGenerator implements AnswerGenerator {
  readonly name = "extractive";
  private readonly maxSources: number;

  constructor(options: ExtractiveOptions = {}) {
    this.maxSources = options.maxSources ?? 3;
  }

  async generate({ question, chunks }: GenerateInput): Promise<string> {
    const wanted = new Set(terms(question));
    // Later chunks must match at least two question terms (or all of them, for short questions).
    const minOverlap = Math.min(2, wanted.size);
    const parts: string[] = [];
    let firstOverlap = 0;
    for (const [index, chunk] of chunks.slice(0, this.maxSources).entries()) {
      let best = "";
      let bestOverlap = -1;
      for (const sentence of sentences(chunk.text)) {
        const overlap = new Set(terms(sentence).filter((t) => wanted.has(t))).size;
        if (overlap > bestOverlap) {
          best = sentence;
          bestOverlap = overlap;
        }
      }
      if (index === 0) firstOverlap = bestOverlap;
      if (!best || (index > 0 && (bestOverlap < minOverlap || bestOverlap < firstOverlap / 2))) continue;
      parts.push(`${best.replace(/[.!?]+$/, "")}. [${index + 1}]`);
    }
    return parts.join(" ");
  }
}
