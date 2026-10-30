import { z } from "zod";
import { isLoopbackHost } from "./auth.js";
import { HashingEmbedder } from "./embedders/hashing.js";
import { OpenAICompatibleEmbedder } from "./embedders/openai.js";
import { ExtractiveGenerator } from "./generators/extractive.js";
import { OpenAICompatibleGenerator } from "./generators/openai.js";
import type { FetchLike } from "./http.js";
import { RagService } from "./service.js";
import { InMemoryVectorStore } from "./stores/memory.js";
import { PgVectorStore, type PoolLike, type Queryable } from "./stores/pgvector.js";
import type { AnswerGenerator, Embedder, VectorStore } from "./types.js";

/** Hard ceiling for MAX_BODY_BYTES. */
export const MAX_BODY_BYTES_LIMIT = 10 * 1024 * 1024;

const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: int(0, 65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MAX_BODY_BYTES: int(1024, MAX_BODY_BYTES_LIMIT).default(1024 * 1024),
  API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16, "must be at least 16 characters").optional()),
  RATE_LIMIT_MAX: int(0, 1_000_000).default(120),
  RATE_LIMIT_WINDOW_SECONDS: int(1, 86_400).default(60),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  CHUNK_MAX_TOKENS: int(16, 8000).default(200),
  CHUNK_OVERLAP_TOKENS: int(0, 4000).default(30),
  MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.05),
  TOP_K_DEFAULT: int(1, 20).default(4),
  DATABASE_URL: optionalString,
  EMBEDDINGS_BASE_URL: optionalString,
  EMBEDDINGS_API_KEY: optionalString,
  EMBEDDINGS_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDINGS_DIMENSIONS: int(8, 16000).default(1536),
  LLM_BASE_URL: optionalString,
  LLM_API_KEY: optionalString,
  LLM_MODEL: z.string().default("gpt-4o-mini"),
});

export type Config = z.infer<typeof envSchema>;

const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const config = parsed.data;
  if (config.CHUNK_OVERLAP_TOKENS >= config.CHUNK_MAX_TOKENS) {
    throw new Error("Invalid configuration: CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_MAX_TOKENS");
  }
  if (!config.API_KEY) {
    const reason = !isLoopbackHost(config.HOST)
      ? `HOST=${config.HOST} accepts connections from other machines`
      : config.EMBEDDINGS_API_KEY || config.LLM_API_KEY
        ? "EMBEDDINGS_API_KEY or LLM_API_KEY is set, so anyone who can reach the server could spend it"
        : undefined;
    if (reason) {
      throw new Error(`Invalid configuration: API_KEY is required because ${reason}. Generate one with: openssl rand -hex 32`);
    }
  }
  return config;
}

export interface Overrides {
  fetch?: FetchLike;
  /** Supplies the database handle when DATABASE_URL is set; defaults to a `pg` pool. */
  db?: Queryable;
}

export interface Components {
  embedder: Embedder;
  store: VectorStore;
  generator: AnswerGenerator;
}

/**
 * Picks implementations from configuration:
 * - embedder: OpenAI-compatible when EMBEDDINGS_BASE_URL or EMBEDDINGS_API_KEY is set, else hashing.
 * - generator: OpenAI-compatible when LLM_BASE_URL or LLM_API_KEY is set, else extractive.
 * - store: pgvector when DATABASE_URL is set, else in-memory.
 */
export async function createComponents(config: Config, overrides: Overrides = {}): Promise<Components> {
  const embedder: Embedder =
    config.EMBEDDINGS_BASE_URL || config.EMBEDDINGS_API_KEY
      ? new OpenAICompatibleEmbedder({
          baseUrl: config.EMBEDDINGS_BASE_URL ?? OPENAI_BASE_URL,
          model: config.EMBEDDINGS_MODEL,
          dimensions: config.EMBEDDINGS_DIMENSIONS,
          apiKey: config.EMBEDDINGS_API_KEY,
          fetch: overrides.fetch,
        })
      : new HashingEmbedder({ dimensions: config.EMBEDDINGS_DIMENSIONS });

  const generator: AnswerGenerator =
    config.LLM_BASE_URL || config.LLM_API_KEY
      ? new OpenAICompatibleGenerator({
          baseUrl: config.LLM_BASE_URL ?? OPENAI_BASE_URL,
          model: config.LLM_MODEL,
          apiKey: config.LLM_API_KEY,
          fetch: overrides.fetch,
        })
      : new ExtractiveGenerator();

  let store: VectorStore;
  if (config.DATABASE_URL || overrides.db) {
    let db = overrides.db;
    let pgPool: PoolLike | undefined;
    if (!db) {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
      pool.on("error", (error) => console.error("Idle Postgres client error:", error.message));
      db = pool;
      pgPool = pool;
    }
    store = new PgVectorStore(db, pgPool ? { pool: pgPool } : {});
  } else {
    store = new InMemoryVectorStore();
  }
  return { embedder, store, generator };
}

export function createService(config: Config, components: Components): RagService {
  return new RagService({
    ...components,
    chunking: { maxTokens: config.CHUNK_MAX_TOKENS, overlapTokens: config.CHUNK_OVERLAP_TOKENS },
    minScore: config.MIN_SCORE,
    defaultTopK: config.TOP_K_DEFAULT,
  });
}
