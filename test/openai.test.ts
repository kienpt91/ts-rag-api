import { describe, expect, it } from "vitest";
import { OpenAICompatibleEmbedder } from "../src/embedders/openai.js";
import { OpenAICompatibleGenerator, buildUserPrompt } from "../src/generators/openai.js";
import type { FetchLike } from "../src/http.js";
import { UpstreamError, type ScoredChunk } from "../src/types.js";

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(respond: (body: any) => { status?: number; json?: unknown; text?: string }) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    const { status = 200, json, text } = respond(body);
    return new Response(text ?? JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const chunk = (over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  id: "c1",
  documentId: "d",
  title: "Refund Policy",
  source: null,
  heading: "Eligibility",
  position: 0,
  text: "Refunds within 30 days.",
  metadata: {},
  score: 0.9,
  ...over,
});

describe("OpenAICompatibleEmbedder", () => {
  it("posts to /embeddings with the bearer key and restores input order", async () => {
    const { fetch, calls } = fakeFetch((body) => ({
      // Return items out of order; `index` must be honoured.
      json: { data: body.input.map((_: string, index: number) => ({ index, embedding: [index, 0, 0] })).reverse() },
    }));
    const embedder = new OpenAICompatibleEmbedder({ baseUrl: "https://llm.example/v1/", model: "m", dimensions: 3, apiKey: "sk-test", fetch });
    expect(await embedder.embed(["a", "b", "c"])).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://llm.example/v1/embeddings");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]!.body).toEqual({ model: "m", input: ["a", "b", "c"] });
  });

  it("batches large inputs and omits the auth header without a key", async () => {
    const { fetch, calls } = fakeFetch((body) => ({ json: { data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 2] })) } }));
    const embedder = new OpenAICompatibleEmbedder({ baseUrl: "http://localhost:11434/v1", model: "m", dimensions: 2, batchSize: 2, fetch });
    expect(await embedder.embed(["a", "b", "c", "d", "e"])).toHaveLength(5);
    expect(calls.map((c) => c.body.input.length)).toEqual([2, 2, 1]);
    expect(calls[0]!.headers).not.toHaveProperty("authorization");
  });

  it("raises UpstreamError on HTTP errors, wrong dimensions and malformed bodies", async () => {
    const make = (respond: Parameters<typeof fakeFetch>[0]) =>
      new OpenAICompatibleEmbedder({ baseUrl: "http://x", model: "m", dimensions: 3, fetch: fakeFetch(respond).fetch });

    const http = make(() => ({ status: 401, text: "bad key" }));
    await expect(http.embed(["a"])).rejects.toMatchObject({ name: "UpstreamError", status: 401, message: expect.stringContaining("bad key") });
    await expect(make(() => ({ json: { data: [{ index: 0, embedding: [1, 2] }] } })).embed(["a"])).rejects.toThrow(/EMBEDDINGS_DIMENSIONS=3/);
    await expect(make(() => ({ json: { data: [] } })).embed(["a"])).rejects.toBeInstanceOf(UpstreamError);
    await expect(make(() => ({ text: "not json" })).embed(["a"])).rejects.toThrow(/invalid JSON/);
  });
});

describe("OpenAICompatibleGenerator", () => {
  it("sends numbered context and returns the message content", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: "  Within 30 days [1].  " } }] } }));
    const generator = new OpenAICompatibleGenerator({ baseUrl: "https://llm.example/v1", model: "gpt-x", apiKey: "k", fetch });
    const answer = await generator.generate({ question: "How long?", chunks: [chunk(), chunk({ id: "c2", title: "Shipping", heading: "" })] });
    expect(answer).toBe("Within 30 days [1].");
    expect(calls[0]!.url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("gpt-x");
    expect(calls[0]!.body.temperature).toBe(0);
    const user = calls[0]!.body.messages[1].content as string;
    expect(user).toContain("[1] Refund Policy > Eligibility\nRefunds within 30 days.");
    expect(user).toContain("[2] Shipping\n");
    expect(user.endsWith("Question: How long?")).toBe(true);
  });

  it("fails loudly on empty completions and upstream errors", async () => {
    const empty = new OpenAICompatibleGenerator({ baseUrl: "http://x", model: "m", fetch: fakeFetch(() => ({ json: { choices: [] } })).fetch });
    await expect(empty.generate({ question: "q", chunks: [chunk()] })).rejects.toThrow(/no content/);
    const down = new OpenAICompatibleGenerator({ baseUrl: "http://x", model: "m", fetch: fakeFetch(() => ({ status: 503, text: "overloaded" })).fetch });
    await expect(down.generate({ question: "q", chunks: [chunk()] })).rejects.toMatchObject({ status: 503 });
  });

  it("buildUserPrompt keeps the question last", () => {
    expect(buildUserPrompt({ question: "Q?", chunks: [chunk()] }).split("\n").at(-1)).toBe("Question: Q?");
  });
});
