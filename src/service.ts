import { chunkMarkdown, type ChunkOptions } from "./chunker.js";
import { sha256Hex } from "./hash.js";
import { chunkLabel } from "./label.js";
import type { AnswerGenerator, Embedder, Metadata, ScoredChunk, StoredChunk, VectorStore } from "./types.js";

export interface IngestInput {
  /** Stable document identifier. Defaults to a hash of the text, so identical text is the same document. */
  id?: string | undefined;
  title?: string | undefined;
  source?: string | undefined;
  metadata?: Metadata | undefined;
  /** Plain text or markdown. */
  text: string;
}

export interface IngestResult {
  documentId: string;
  title: string;
  chunks: number;
  /** Chunks embedded and written by this call. */
  added: number;
  /** Previously stored chunks of this document that no longer exist and were removed. */
  removed: number;
  /** True when the stored chunks already matched exactly and nothing was written. */
  unchanged: boolean;
}

export interface QueryInput {
  question: string;
  topK?: number | undefined;
  filter?: Metadata | undefined;
}

export interface Citation {
  /** The number used in the answer text, e.g. `1` for `[1]`. */
  ref: number;
  /** Human-readable label: "Title > Heading". */
  label: string;
  chunkId: string;
  documentId: string;
  title: string;
  heading: string;
  source: string | null;
  score: number;
}

export interface QueryResult {
  question: string;
  answer: string;
  /** Only the sources the answer actually cites, in citation order. */
  citations: Citation[];
  /** Everything retrieved, best first. `citations[i].ref - 1` indexes into this list. */
  chunks: ScoredChunk[];
  generator: string;
}

export const NO_ANSWER = "I could not find anything relevant in the indexed documents.";

export interface RagServiceOptions {
  embedder: Embedder;
  store: VectorStore;
  generator: AnswerGenerator;
  chunking?: Partial<ChunkOptions>;
  /** Retrieved chunks scoring below this cosine similarity are discarded. */
  minScore?: number;
  defaultTopK?: number;
}

export class RagService {
  private readonly minScore: number;
  private readonly defaultTopK: number;

  constructor(private readonly options: RagServiceOptions) {
    this.minScore = options.minScore ?? 0.05;
    this.defaultTopK = options.defaultTopK ?? 4;
  }

  get components() {
    return { embedder: this.options.embedder.name, store: this.options.store.name, generator: this.options.generator.name };
  }

  /**
   * Chunks, embeds and stores a document.
   *
   * Chunk ids are a SHA-256 over document id, title, source, metadata, heading, text and the number of
   * earlier identical chunks in the same document. Re-ingesting the same input therefore yields the same
   * ids, embeds nothing and writes nothing. Editing a document embeds only the chunks whose ids are new
   * and deletes the ids that disappeared.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const documentId = input.id ?? sha256Hex(input.text).slice(0, 16);
    const title = input.title ?? firstHeading(input.text) ?? documentId;
    const source = input.source ?? null;
    const metadata = sortKeys(input.metadata ?? {});
    const metadataKey = JSON.stringify(metadata);

    const seen = new Map<string, number>();
    const planned = chunkMarkdown(input.text, this.options.chunking).map((chunk) => {
      const base = sha256Hex(documentId, title, source ?? "", metadataKey, chunk.heading, chunk.text);
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { ...chunk, id: sha256Hex(base, String(occurrence)).slice(0, 24) };
    });

    const existing = new Set(await this.options.store.chunkIds(documentId));
    const fresh = planned.filter((c) => !existing.has(c.id));
    const keep = new Set(planned.map((c) => c.id));
    const stale = [...existing].filter((id) => !keep.has(id));

    if (fresh.length > 0) {
      const vectors = await this.options.embedder.embed(fresh.map((c) => embeddingText(c.heading, c.text)));
      const records: StoredChunk[] = fresh.map((chunk, i) => ({
        id: chunk.id,
        documentId,
        title,
        source,
        heading: chunk.heading,
        position: chunk.position,
        text: chunk.text,
        metadata,
        embedding: vectors[i]!,
      }));
      await this.options.store.upsert(records);
    }
    // Positions of retained chunks may have shifted; they are cosmetic and refreshed only for new chunks.
    await this.options.store.delete(stale);

    return {
      documentId,
      title,
      chunks: planned.length,
      added: fresh.length,
      removed: stale.length,
      unchanged: fresh.length === 0 && stale.length === 0,
    };
  }

  /** Embeds the question and returns the best chunks scoring at least `minScore`, best first. */
  async retrieve(question: string, k: number = this.defaultTopK, filter?: Metadata): Promise<ScoredChunk[]> {
    const [vector] = await this.options.embedder.embed([question]);
    const hits = await this.options.store.search(vector!, k, filter ? { filter } : {});
    return hits.filter((h) => h.score >= this.minScore);
  }

  async query(input: QueryInput): Promise<QueryResult> {
    const chunks = await this.retrieve(input.question, input.topK, input.filter);
    const generator = this.options.generator.name;
    if (chunks.length === 0) return { question: input.question, answer: NO_ANSWER, citations: [], chunks: [], generator };

    const answer = (await this.options.generator.generate({ question: input.question, chunks })).trim();
    return { question: input.question, answer, citations: citationsFor(answer, chunks), chunks, generator };
  }
}

/** Embeddings see the heading path so that short sections remain findable by their topic. */
export function embeddingText(heading: string, text: string): string {
  return heading ? `${heading}\n${text}` : text;
}

/** Resolves `[n]` markers in the answer to the retrieved chunks they refer to. Unknown numbers are ignored. */
export function citationsFor(answer: string, chunks: ScoredChunk[]): Citation[] {
  const refs: number[] = [];
  for (const match of answer.matchAll(/\[(\d{1,3})\]/g)) {
    const ref = Number(match[1]);
    if (ref >= 1 && ref <= chunks.length && !refs.includes(ref)) refs.push(ref);
  }
  return refs.map((ref) => {
    const chunk = chunks[ref - 1]!;
    return {
      ref,
      label: chunkLabel(chunk),
      chunkId: chunk.id,
      documentId: chunk.documentId,
      title: chunk.title,
      heading: chunk.heading,
      source: chunk.source,
      score: chunk.score,
    };
  });
}

function firstHeading(text: string): string | undefined {
  return /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(text)?.[1]?.trim();
}

function sortKeys(metadata: Metadata): Metadata {
  return Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
