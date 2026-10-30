import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgVectorStore, migrate, toVectorLiteral, type Queryable } from "../src/stores/pgvector.js";
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

beforeAll(async () => {
  if (!DATABASE_URL) return;
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await migrate(client, { dimensions: DIMS });
});

afterAll(async () => {
  if (!DATABASE_URL) return;
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await client.end();
});

describeVectorStore(
  "pgvector (needs DATABASE_URL)",
  async () => {
    await client.query("TRUNCATE rag_chunks");
    return new PgVectorStore(client);
  },
  { skip: !DATABASE_URL },
);

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
