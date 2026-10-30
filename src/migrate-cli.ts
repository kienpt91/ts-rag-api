import pg from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./stores/pgvector.js";

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error("DATABASE_URL is required to run migrations");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
try {
  const applied = await migrate(pool, { dimensions: config.EMBEDDINGS_DIMENSIONS });
  console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await pool.end();
}
