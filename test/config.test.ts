import { describe, expect, it } from "vitest";
import { createComponents, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the offline demo setup", async () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ HOST: "127.0.0.1", RATE_LIMIT_MAX: 120, TRUST_PROXY: false, PORT: 3000, MAX_BODY_BYTES: 1024 * 1024, CHUNK_MAX_TOKENS: 200, EMBEDDINGS_DIMENSIONS: 1536 });
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
      API_KEY: "a".repeat(32),
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

  describe("network exposure", () => {
    const key = "k".repeat(32);

    it("binds to loopback by default and needs no API key there", () => {
      expect(loadConfig({}).HOST).toBe("127.0.0.1");
      for (const host of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST"]) {
        expect(() => loadConfig({ HOST: host }), host).not.toThrow();
      }
    });

    it("refuses to start on a non-loopback host without API_KEY", () => {
      for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.internal", "127.example.com"]) {
        expect(() => loadConfig({ HOST: host }), host).toThrow(/API_KEY is required because HOST=/);
      }
      expect(loadConfig({ HOST: "0.0.0.0", API_KEY: key }).API_KEY).toBe(key);
    });

    it("refuses to start with provider keys but no API_KEY, even on loopback", () => {
      expect(() => loadConfig({ LLM_API_KEY: "sk-x" })).toThrow(/API_KEY is required because EMBEDDINGS_API_KEY or LLM_API_KEY/);
      expect(() => loadConfig({ EMBEDDINGS_API_KEY: "sk-x" })).toThrow(/API_KEY is required/);
      expect(() => loadConfig({ LLM_API_KEY: "sk-x", API_KEY: key })).not.toThrow();
      // Self-hosted endpoints without keys do not spend anything.
      expect(() => loadConfig({ LLM_BASE_URL: "http://localhost:11434/v1" })).not.toThrow();
    });

    it("rejects short API keys and treats an empty one as unset", () => {
      expect(() => loadConfig({ API_KEY: "short" })).toThrow(/API_KEY/);
      expect(loadConfig({ API_KEY: "" }).API_KEY).toBeUndefined();
    });

    it("caps MAX_BODY_BYTES at 10 MiB", () => {
      expect(loadConfig({ MAX_BODY_BYTES: String(10 * 1024 * 1024) }).MAX_BODY_BYTES).toBe(10 * 1024 * 1024);
      expect(() => loadConfig({ MAX_BODY_BYTES: String(10 * 1024 * 1024 + 1) })).toThrow(/MAX_BODY_BYTES/);
    });

    it("parses rate limit and proxy settings", () => {
      expect(loadConfig({ RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_SECONDS: "10", TRUST_PROXY: "true" })).toMatchObject({
        RATE_LIMIT_MAX: 5,
        RATE_LIMIT_WINDOW_SECONDS: 10,
        TRUST_PROXY: true,
      });
      expect(() => loadConfig({ TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
    });
  });
});
