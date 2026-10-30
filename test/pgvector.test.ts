import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgVectorStore, migrate, toVectorLiteral, type PoolLike, type Queryable } from "../src/stores/pgvector.js";
import { expectedIds, raceIngests, versionText } from "./helpers/ingest-race.js";
import { DIMS, chunk, describeVectorStore } from "./helpers/store-contract.js";

describe("PgVectorStore SQL (no database needed)", () => {
  function recorder() {
    const calls: { text: string; params: unknown[] | undefined }[] = [];
    const db: Queryable = {
      async query(text, params) {
        calls.push({ text, params });
        return { rows: [] };
      },
    };
    return { db, calls };
  }

  it("formats vectors as pgvector literals", () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe("[0.5,-1,0]");
  });

  it("upserts with a parameterised multi-row insert", async () => {
    const { db, calls } = recorder();
    await new PgVectorStore(db).upsert([chunk("a", [1, 0, 0, 0], { metadata: { k: "v" } }), chunk("b", [0, 1, 0, 0])]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(calls[0]!.text).toContain("$18::vector");
    expect(calls[0]!.params).toHaveLength(18);
    expect(calls[0]!.params![7]).toBe('{"k":"v"}');
    expect(calls[0]!.params![8]).toBe("[1,0,0,0]");
  });

  it("splits large upserts into batches and skips empty deletes", async () => {
    const { db, calls } = recorder();
    const store = new PgVectorStore(db);
    await store.upsert(Array.from({ length: 250 }, (_, i) => chunk(`c${i}`, [1, 0, 0, 0])));
    expect(calls).toHaveLength(3);
    await store.delete([]);
    expect(calls).toHaveLength(3);
  });

  it("passes the metadata filter as jsonb containment", async () => {
    const { db, calls } = recorder();
    await new PgVectorStore(db).search([1, 0, 0, 0], 5, { filter: { team: "x" } });
    expect(calls[0]!.text).toContain("metadata @> $3::jsonb");
    expect(calls[0]!.params).toEqual(["[1,0,0,0]", 5, '{"team":"x"}']);
  });

  it("wraps withDocumentLock in a transaction holding an advisory lock, on a dedicated pooled connection", async () => {
    const main = recorder();
    const leased = recorder();
    let released: unknown = "not released";
    const pool: PoolLike = {
      query: main.db.query,
      connect: async () => ({ query: leased.db.query, release: (e) => void (released = e) }),
    };
    const result = await new PgVectorStore(pool, { pool }).withDocumentLock("doc-1", async (tx) => {
      await tx.delete(["x"]);
      return "done";
    });
    expect(result).toBe("done");
    expect(main.calls).toHaveLength(0);
    expect(leased.calls.map((c) => c.text.split(" ").slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "DELETE FROM rag_chunks",
      "COMMIT",
    ]);
    expect(leased.calls[1]!.params).toEqual(["rag_chunks:doc-1"]);
    expect(released).toBe(false);
  });

  it("rolls back, releases the connection and rethrows when the callback fails", async () => {
    const leased = recorder();
    let released: unknown = "not released";
    const pool: PoolLike = { query: leased.db.query, connect: async () => ({ query: leased.db.query, release: (e) => void (released = e) }) };
    await expect(
      new PgVectorStore(pool, { pool }).withDocumentLock("d", async () => {
        throw new Error("embedding failed");
      }),
    ).rejects.toThrow("embedding failed");
    expect(leased.calls.map((c) => c.text.split(" ")[0])).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
    expect(released).toBe(false);
  });

  it("discards a connection whose ROLLBACK failed", async () => {
    let released: unknown = "not released";
    const broken: Queryable = {
      query: async (text) => {
        if (text === "ROLLBACK") throw new Error("connection lost");
        return { rows: [] };
      },
    };
    const pool: PoolLike = { query: broken.query, connect: async () => ({ ...broken, release: (e) => void (released = e) }) };
    await expect(
      new PgVectorStore(pool, { pool }).withDocumentLock("d", async () => {
        throw new Error("original");
      }),
    ).rejects.toThrow("original");
    expect(released).toBe(true);
  });

  it("rejects invalid dimensions before touching the database", async () => {
    const { db, calls } = recorder();
    await expect(migrate(db, { dimensions: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

// Integration tests run against a real Postgres with the pgvector extension, e.g.
//   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rag_test pgvector/pgvector:pg16
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/rag_test npm test
// They are skipped when DATABASE_URL is not set. Each run uses its own throw-away schema.
const DATABASE_URL = process.env.DATABASE_URL;
const schema = `rag_test_${process.pid}_${Date.now()}`;
let client: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await migrate(client, { dimensions: DIMS });
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8, options: `-c search_path=${schema},public` });
});

afterAll(async () => {
  if (!DATABASE_URL) return;
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await pool.end();
  await client.end();
});

describeVectorStore(
  "pgvector (needs DATABASE_URL)",
  async () => {
    await client.query("TRUNCATE rag_chunks");
    return new PgVectorStore(client);
  },
  { skip: !DATABASE_URL, transactional: true, parallelDocuments: false },
);

describeVectorStore(
  "pgvector via pool, one connection per transaction (needs DATABASE_URL)",
  async () => {
    await client.query("TRUNCATE rag_chunks");
    return new PgVectorStore(pool, { pool });
  },
  { skip: !DATABASE_URL, transactional: true },
);

describe.skipIf(!DATABASE_URL)("concurrent ingests against Postgres (needs DATABASE_URL)", () => {
  it("serialise per document and leave exactly one complete version", async () => {
    await client.query("TRUNCATE rag_chunks");
    const versions = [1, 2, 3, 4, 5, 6];
    const left = await raceIngests(new PgVectorStore(pool, { pool }), DIMS, versions);
    const candidates = await Promise.all(versions.map((v) => expectedIds(versionText(v), DIMS)));
    expect(candidates.map((c) => c.join())).toContain(left.join());
    const { rows } = await client.query("SELECT count(*)::int AS n FROM rag_chunks WHERE document_id = 'doc'");
    expect(rows[0]!.n).toBe(left.length);
  });
});

describe.skipIf(!DATABASE_URL)("migrations (needs DATABASE_URL)", () => {
  it("are idempotent and recorded", async () => {
    expect(await migrate(client, { dimensions: DIMS })).toEqual([]);
    const { rows } = await client.query("SELECT name FROM rag_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["001_create_chunks.sql", "002_embedding_index.sql"]);
  });

  it("create an embedding column sized from the dimensions argument", async () => {
    const { rows } = await client.query(
      "SELECT format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = 'rag_chunks'::regclass AND a.attname = 'embedding'",
    );
    expect(rows[0]!.type).toBe(`vector(${DIMS})`);
  });
});
