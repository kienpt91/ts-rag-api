import { ExtractiveGenerator } from "../../src/generators/extractive.js";
import { RagService } from "../../src/service.js";
import { InMemoryVectorStore } from "../../src/stores/memory.js";
import type { Embedder, ScoredChunk, StoredChunk, VectorStore } from "../../src/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tiny deterministic embedder with a delay, so that concurrent ingests overlap while embedding. */
export function slowEmbedder(dimensions: number, delayMs = 15): Embedder {
  return {
    name: "slow-test",
    dimensions,
    embed: async (texts) => {
      await sleep(delayMs);
      return texts.map((text) => {
        const v = new Array<number>(dimensions).fill(0);
        for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % dimensions]! += 1;
        return v;
      });
    },
  };
}

/** Wraps a store so every call yields to the event loop, which makes unsynchronised read-modify-write cycles interleave. */
export function latent(inner: VectorStore, options: { lock: boolean }): VectorStore {
  const pause = () => sleep(3);
  const wrapped: VectorStore = {
    name: inner.name,
    upsert: async (chunks: StoredChunk[]) => (await pause(), inner.upsert(chunks)),
    delete: async (ids: string[]) => (await pause(), inner.delete(ids)),
    chunkIds: async (documentId: string) => (await pause(), inner.chunkIds(documentId)),
    search: async (embedding, k, o): Promise<ScoredChunk[]> => (await pause(), inner.search(embedding, k, o)),
    count: () => inner.count(),
    withDocumentLock: (documentId, fn) => (options.lock ? inner.withDocumentLock(documentId, () => fn(wrapped)) : fn(wrapped)),
  };
  return wrapped;
}

const CHUNKING = { maxTokens: 12, overlapTokens: 0 };

export function versionText(version: number): string {
  return Array.from({ length: 6 }, (_, i) => `Paragraph ${i} of version ${version} with filler words.`).join("\n\n");
}

/** Chunk ids a lone ingest of `text` would leave behind for document `doc`. */
export async function expectedIds(text: string, dimensions: number): Promise<string[]> {
  const store = new InMemoryVectorStore();
  await new RagService({ embedder: slowEmbedder(dimensions, 0), store, generator: new ExtractiveGenerator(), chunking: CHUNKING }).ingest({ id: "doc", text });
  return (await store.chunkIds("doc")).sort();
}

/** Ingests several versions of one document at the same time and returns the ids left in the store. */
export async function raceIngests(store: VectorStore, dimensions: number, versions: number[]): Promise<string[]> {
  const service = new RagService({ embedder: slowEmbedder(dimensions), store, generator: new ExtractiveGenerator(), chunking: CHUNKING });
  await Promise.all(versions.map((v) => service.ingest({ id: "doc", text: versionText(v) })));
  return (await store.chunkIds("doc")).sort();
}
