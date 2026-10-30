import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Metadata, ScoredChunk, SearchOptions, StoredChunk, VectorStore } from "../types.js";

/** The subset of `pg.Pool` / `pg.Client` used here, so tests can substitute a recording fake. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const INSERT_BATCH = 100;
const COLUMNS = 9;

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** pgvector text input format, e.g. `[0.1,0.2]`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Applies `*.sql` files in name order, recording each in `rag_migrations`. `{{dimensions}}` is replaced
 * with the embedding size. Files are split into statements on a semicolon at the end of a line, so keep
 * them to plain DDL (no function bodies). Returns the names of the migrations that were applied.
 */
export async function migrate(db: Queryable, options: { dimensions: number; dir?: string }): Promise<string[]> {
  if (!Number.isInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 16000) {
    throw new RangeError("dimensions must be an integer between 1 and 16000");
  }
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  await db.query("CREATE TABLE IF NOT EXISTS rag_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT name FROM rag_migrations")).rows.map((r) => String(r.name)));
  const applied: string[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = (await readFile(path.join(dir, file), "utf8")).replaceAll("{{dimensions}}", String(options.dimensions));
    for (const statement of sql.split(/;[ \t]*\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      await db.query(statement);
    }
    await db.query("INSERT INTO rag_migrations (name) VALUES ($1)", [file]);
    applied.push(file);
  }
  return applied;
}

export class PgVectorStore implements VectorStore {
  readonly name = "pgvector";

  constructor(private readonly db: Queryable) {}

  async upsert(chunks: StoredChunk[]): Promise<void> {
    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      const batch = chunks.slice(start, start + INSERT_BATCH);
      const params: unknown[] = [];
      const rows = batch.map((chunk, i) => {
        const base = i * COLUMNS;
        params.push(
          chunk.id,
          chunk.documentId,
          chunk.title,
          chunk.source,
          chunk.heading,
          chunk.position,
          chunk.text,
          JSON.stringify(chunk.metadata),
          toVectorLiteral(chunk.embedding),
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}::vector)`;
      });
      await this.db.query(
        `INSERT INTO rag_chunks (id, document_id, title, source, heading, position, text, metadata, embedding)
         VALUES ${rows.join(", ")}
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id, title = EXCLUDED.title, source = EXCLUDED.source,
           heading = EXCLUDED.heading, position = EXCLUDED.position, text = EXCLUDED.text,
           metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding`,
        params,
      );
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query("DELETE FROM rag_chunks WHERE id = ANY($1::text[])", [ids]);
  }

  async chunkIds(documentId: string): Promise<string[]> {
    const { rows } = await this.db.query("SELECT id FROM rag_chunks WHERE document_id = $1", [documentId]);
    return rows.map((r) => String(r.id));
  }

  async search(embedding: number[], k: number, options: SearchOptions = {}): Promise<ScoredChunk[]> {
    const { rows } = await this.db.query(
      `SELECT id, document_id, title, source, heading, position, text, metadata,
              1 - (embedding <=> $1::vector) AS score
         FROM rag_chunks
        WHERE metadata @> $3::jsonb
        ORDER BY embedding <=> $1::vector, document_id, position
        LIMIT $2`,
      [toVectorLiteral(embedding), k, JSON.stringify(options.filter ?? {})],
    );
    return rows.map((r) => ({
      id: String(r.id),
      documentId: String(r.document_id),
      title: String(r.title),
      source: r.source === null ? null : String(r.source),
      heading: String(r.heading),
      position: Number(r.position),
      text: String(r.text),
      metadata: r.metadata as Metadata,
      score: Number(r.score),
    }));
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query("SELECT count(*)::int AS n FROM rag_chunks");
    return Number(rows[0]?.n ?? 0);
  }
}
