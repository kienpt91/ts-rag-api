import { HashingEmbedder } from "../embedders/hashing.js";
import { ExtractiveGenerator } from "../generators/extractive.js";
import { RagService } from "../service.js";
import { InMemoryVectorStore } from "../stores/memory.js";
import { EVAL_DEPTH, loadFixtures, runEval } from "./run.js";

const embedder = new HashingEmbedder();
const service = new RagService({ embedder, store: new InMemoryVectorStore(), generator: new ExtractiveGenerator() });
const report = await runEval(service, await loadFixtures());

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const table: [string, string][] = [
  ["hit@1", pct(report.hitAt1)],
  ["hit@3", pct(report.hitAt3)],
  ["hit@5", pct(report.hitAt5)],
  [`MRR@${EVAL_DEPTH}`, report.mrr.toFixed(3)],
  ["document hit@1", pct(report.documentHitAt1)],
];

console.log(`Retrieval eval: ${report.questions} questions, ${report.documents} documents, ${report.chunks} chunks, embedder ${embedder.name}`);
console.log("");
const width = Math.max(...table.map(([name]) => name.length));
console.log(`${"metric".padEnd(width)}  value`);
console.log(`${"-".repeat(width)}  ------`);
for (const [name, value] of table) console.log(`${name.padEnd(width)}  ${value}`);

const misses = report.rows.filter((r) => r.rank === null || r.rank > 1);
if (misses.length > 0) {
  console.log("");
  console.log("Not ranked first:");
  for (const row of misses) {
    console.log(`  rank ${row.rank ?? `>${EVAL_DEPTH}`}  [${row.expectedDocument}]  ${row.question}`);
  }
}
