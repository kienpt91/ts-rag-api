import { describe, expect, it } from "vitest";
import { createComponents, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the offline demo setup", async () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ PORT: 3000, MAX_BODY_BYTES: 1024 * 1024, CHUNK_MAX_TOKENS: 200, EMBEDDINGS_DIMENSIONS: 1536 });
    const { embedder, store, generator } = await createComponents(config);
    expect([embedder.name, store.name, generator.name]).toEqual(["hashing-1536", "memory", "extractive"]);
  });

  it("treats empty strings as unset", async () => {
    const config = loadConfig({ DATABASE_URL: "", LLM_BASE_URL: "", EMBEDDINGS_API_KEY: "" });
    const { store, generator, embedder } = await createComponents(config);
    expect([embedder.name, store.name, generator.name]).toEqual(["hashing-1536", "memory", "extractive"]);
  });

  it("selects OpenAI-compatible components from env, with a fetch override", async () => {
    const requests: string[] = [];
    const fetch = async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(8).fill(0.1) }], choices: [{ message: { content: "ok [1]" } }] }));
    };
    const config = loadConfig({
      EMBEDDINGS_BASE_URL: "http://localhost:11434/v1",
      EMBEDDINGS_MODEL: "nomic",
      EMBEDDINGS_DIMENSIONS: "8",
      LLM_API_KEY: "sk-x",
      LLM_MODEL: "small",
    });
    const { embedder, generator } = await createComponents(config, { fetch });
    expect(embedder.name).toBe("openai-compatible:nomic");
    expect(generator.name).toBe("openai-compatible:small");
    await embedder.embed(["x"]);
    await generator.generate({ question: "q", chunks: [] });
    expect(requests).toEqual(["http://localhost:11434/v1/embeddings", "https://api.openai.com/v1/chat/completions"]);
  });

  it("uses pgvector when a database handle is configured", async () => {
    const db = { query: async () => ({ rows: [] }) };
    const { store } = await createComponents(loadConfig({}), { db });
    expect(store.name).toBe("pgvector");
  });

  it("reports invalid values by name", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ TOP_K_DEFAULT: "99" })).toThrow(/TOP_K_DEFAULT/);
    expect(() => loadConfig({ CHUNK_MAX_TOKENS: "50", CHUNK_OVERLAP_TOKENS: "50" })).toThrow(/CHUNK_OVERLAP_TOKENS/);
  });
});
