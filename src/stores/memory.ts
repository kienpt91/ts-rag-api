import { KeyedMutex } from "../mutex.js";
import type { Metadata, ScoredChunk, SearchOptions, StoredChunk, VectorStore } from "../types.js";

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function matches(metadata: Metadata, filter: Metadata | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => Object.hasOwn(metadata, key) && metadata[key] === value);
}

/** Brute-force cosine search over chunks held in process memory. Data is lost on restart. */
export class InMemoryVectorStore implements VectorStore {
  readonly name = "memory";
  private readonly chunks = new Map<string, StoredChunk>();
  private readonly locks = new KeyedMutex();

  async upsert(chunks: StoredChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, { ...chunk, metadata: { ...chunk.metadata } });
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.chunks.delete(id);
  }

  async chunkIds(documentId: string): Promise<string[]> {
    return [...this.chunks.values()].filter((c) => c.documentId === documentId).map((c) => c.id);
  }

  async search(embedding: number[], k: number, options: SearchOptions = {}): Promise<ScoredChunk[]> {
    const scored: ScoredChunk[] = [];
    for (const { embedding: vector, ...record } of this.chunks.values()) {
      if (!matches(record.metadata, options.filter)) continue;
      scored.push({ ...record, metadata: { ...record.metadata }, score: cosine(embedding, vector) });
    }
    // Ties are broken by document and position so results are deterministic.
    scored.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.position - b.position);
    return scored.slice(0, k);
  }

  async count(): Promise<number> {
    return this.chunks.size;
  }

  /** In-process only, and not transactional: writes made before `fn` throws are kept. */
  withDocumentLock<T>(documentId: string, fn: (store: VectorStore) => Promise<T>): Promise<T> {
    return this.locks.run(documentId, () => fn(this));
  }
}
