import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR, loadFixtures, runEval } from "../src/eval/run.js";
import { firstRelevantRank, hitAtK, meanReciprocalRank } from "../src/eval/metrics.js";
import { createTestService } from "./helpers/fixtures.js";

describe("metrics", () => {
  it("computes ranks, hit@k and MRR", () => {
    expect(firstRelevantRank(["a", "b", "c"], (x) => x === "c")).toBe(3);
    expect(firstRelevantRank(["a"], (x) => x === "z")).toBeNull();
    const ranks = [1, 2, null, 4];
    expect(hitAtK(ranks, 1)).toBe(0.25);
    expect(hitAtK(ranks, 3)).toBe(0.5);
    expect(hitAtK(ranks, 10)).toBe(0.75);
    expect(meanReciprocalRank(ranks)).toBeCloseTo((1 + 0.5 + 0 + 0.25) / 4, 10);
    expect(hitAtK([], 1)).toBe(0);
    expect(meanReciprocalRank([])).toBe(0);
  });
});

describe("fixture Q&A set", () => {
  it("only cites evidence that exists in the referenced document", async () => {
    const { questions } = await loadFixtures();
    expect(questions.length).toBeGreaterThanOrEqual(30);
    for (const q of questions) {
      const text = readFileSync(path.join(FIXTURES_DIR, "corpus", `${q.document}.md`), "utf8").toLowerCase().replace(/\s+/g, " ");
      expect(text, q.question).toContain(q.evidence);
    }
  });

  it("is retrieved well enough by the offline embedder to guard against regressions", async () => {
    const { service } = createTestService();
    const report = await runEval(service, await loadFixtures());
    // Thresholds sit comfortably below the measured numbers (see README) so only real regressions trip them.
    expect(report.hitAt3).toBeGreaterThanOrEqual(0.8);
    expect(report.hitAt5).toBeGreaterThanOrEqual(0.85);
    expect(report.mrr).toBeGreaterThanOrEqual(0.7);
    expect(report.documentHitAt1).toBeGreaterThanOrEqual(0.9);
  });
});
