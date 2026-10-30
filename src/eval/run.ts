import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RagService } from "../service.js";
import type { ScoredChunk } from "../types.js";
import { firstRelevantRank, hitAtK, meanReciprocalRank } from "./metrics.js";

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

const qaSchema = z.array(
  z.object({
    question: z.string().min(1),
    /** Document id (file name without extension) that holds the answer. */
    document: z.string().min(1),
    /** Lowercase text that must occur in a retrieved chunk for it to count as relevant. */
    evidence: z.string().min(1),
  }),
);

export type QaItem = z.infer<typeof qaSchema>[number];

export interface Fixtures {
  documents: { id: string; text: string }[];
  questions: QaItem[];
}

export async function loadFixtures(dir: string = FIXTURES_DIR): Promise<Fixtures> {
  const corpusDir = path.join(dir, "corpus");
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".md")).sort();
  const documents = await Promise.all(
    files.map(async (file) => ({ id: file.replace(/\.md$/, ""), text: await readFile(path.join(corpusDir, file), "utf8") })),
  );
  const questions = qaSchema.parse(JSON.parse(await readFile(path.join(dir, "qa.json"), "utf8")));
  return { documents, questions };
}

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** A retrieved chunk is relevant when it comes from the expected document and contains the evidence text. */
export function isRelevant(chunk: ScoredChunk, item: QaItem): boolean {
  return chunk.documentId === item.document && normalise(chunk.text).includes(item.evidence);
}

export interface EvalRow {
  question: string;
  expectedDocument: string;
  /** Rank of the first relevant chunk, or null if absent from the top results. */
  rank: number | null;
  /** Rank of the first chunk from the expected document, ignoring the evidence text. */
  documentRank: number | null;
}

export interface EvalReport {
  questions: number;
  documents: number;
  chunks: number;
  rows: EvalRow[];
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  mrr: number;
  documentHitAt1: number;
}

export const EVAL_DEPTH = 10;

/** Ingests the fixture corpus into `service` and scores retrieval for every fixture question. */
export async function runEval(service: RagService, fixtures: Fixtures): Promise<EvalReport> {
  let chunks = 0;
  for (const doc of fixtures.documents) chunks += (await service.ingest(doc)).chunks;

  const rows: EvalRow[] = [];
  for (const item of fixtures.questions) {
    const results = await service.retrieve(item.question, EVAL_DEPTH);
    rows.push({
      question: item.question,
      expectedDocument: item.document,
      rank: firstRelevantRank(results, (c) => isRelevant(c, item)),
      documentRank: firstRelevantRank(results, (c) => c.documentId === item.document),
    });
  }
  const ranks = rows.map((r) => r.rank);
  return {
    questions: rows.length,
    documents: fixtures.documents.length,
    chunks,
    rows,
    hitAt1: hitAtK(ranks, 1),
    hitAt3: hitAtK(ranks, 3),
    hitAt5: hitAtK(ranks, 5),
    mrr: meanReciprocalRank(ranks),
    documentHitAt1: hitAtK(
      rows.map((r) => r.documentRank),
      1,
    ),
  };
}
