/** Arbitrary string key/value pairs attached to a document and copied onto each of its chunks. */
export type Metadata = Record<string, string>;

export interface Embedder {
  /** Short identifier reported by /health, e.g. "hashing-512". */
  readonly name: string;
  /** Length of every vector returned by `embed`. */
  readonly dimensions: number;
  /** Embeds each text; the result has the same length and order as the input. */
  embed(texts: string[]): Promise<number[][]>;
}

/** A chunk as persisted in a vector store. */
export interface StoredChunk {
  id: string;
  documentId: string;
  title: string;
  source: string | null;
  /** Heading path such as "Refund Policy > Eligibility"; empty for text before the first heading. */
  heading: string;
  /** Zero-based position within the document when the chunk was written; not refreshed if only neighbours change. */
  position: number;
  text: string;
  metadata: Metadata;
  embedding: number[];
}

export type ChunkRecord = Omit<StoredChunk, "embedding">;

export interface ScoredChunk extends ChunkRecord {
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export interface SearchOptions {
  /** Only chunks whose metadata contains every key/value pair are returned. */
  filter?: Metadata;
}

export interface VectorStore {
  readonly name: string;
  /** Inserts or overwrites chunks by id. */
  upsert(chunks: StoredChunk[]): Promise<void>;
  /** Removes chunks by id; unknown ids are ignored. */
  delete(ids: string[]): Promise<void>;
  /** Ids of all chunks currently stored for a document. */
  chunkIds(documentId: string): Promise<string[]>;
  /** Top-k chunks by cosine similarity, best first. */
  search(embedding: number[], k: number, options?: SearchOptions): Promise<ScoredChunk[]>;
  count(): Promise<number>;
  /**
   * Runs `fn` with exclusive access to one document's chunks: concurrent calls for the same document id
   * run one after another (across processes, where the store is shared). `fn` must use the store it is
   * handed, which is transactional where the backend supports it: if `fn` throws, its writes are rolled back.
   */
  withDocumentLock<T>(documentId: string, fn: (store: VectorStore) => Promise<T>): Promise<T>;
}

export interface GenerateInput {
  question: string;
  /** Retrieved context, best first. The chunk at index i is cited as `[i + 1]`. */
  chunks: ScoredChunk[];
}

export interface AnswerGenerator {
  readonly name: string;
  /** Returns answer text that cites context chunks with `[n]` markers. */
  generate(input: GenerateInput): Promise<string>;
}

/** Raised when an external embedding or LLM endpoint fails; the HTTP layer maps it to 502. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}
