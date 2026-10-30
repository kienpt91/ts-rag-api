import { fnv1a } from "../hash.js";
import { terms, words } from "../text.js";
import type { Embedder } from "../types.js";

export interface HashingEmbedderOptions {
  dimensions?: number;
  /** Weight of adjacent-term pairs relative to single terms. */
  bigramWeight?: number;
}

/**
 * Deterministic bag-of-words embedder using the hashing trick: stemmed unigrams and bigrams are hashed
 * into a fixed-size signed vector, sublinearly weighted by term frequency, then L2-normalised.
 *
 * It has no notion of meaning: two texts are similar only when they share vocabulary. It exists so the
 * whole pipeline runs offline, deterministically and without an API key.
 */
export class HashingEmbedder implements Embedder {
  readonly name: string;
  readonly dimensions: number;
  private readonly bigramWeight: number;

  constructor(options: HashingEmbedderOptions = {}) {
    this.dimensions = options.dimensions ?? 1536;
    this.bigramWeight = options.bigramWeight ?? 0.5;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 8) throw new RangeError("dimensions must be an integer >= 8");
    this.name = `hashing-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const counts = new Map<string, { count: number; weight: number }>();
    const add = (feature: string, weight: number) => {
      const entry = counts.get(feature);
      if (entry) entry.count++;
      else counts.set(feature, { count: 1, weight });
    };

    const unigrams = terms(text);
    unigrams.forEach((term, i) => {
      add(`u:${term}`, 1);
      const next = unigrams[i + 1];
      if (next !== undefined) add(`b:${term}_${next}`, this.bigramWeight);
    });
    // Text with no letters or digits (emoji, punctuation) still gets a stable, non-zero vector.
    if (counts.size === 0) add(`raw:${text.trim() || words(text).join(" ")}`, 1);

    const vector = new Array<number>(this.dimensions).fill(0);
    for (const [feature, { count, weight }] of counts) {
      const h = fnv1a(feature);
      const sign = fnv1a(feature, 0x9747b28c) & 1 ? -1 : 1;
      vector[h % this.dimensions]! += sign * weight * (1 + Math.log(count));
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) {
      // Hash features cancelled each other out exactly; fall back to a fixed unit vector.
      vector[0] = 1;
      return vector;
    }
    return vector.map((v) => v / norm);
  }
}
