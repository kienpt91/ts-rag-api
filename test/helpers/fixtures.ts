import { HashingEmbedder } from "../../src/embedders/hashing.js";
import { ExtractiveGenerator } from "../../src/generators/extractive.js";
import { RagService, type RagServiceOptions } from "../../src/service.js";
import { InMemoryVectorStore } from "../../src/stores/memory.js";
import type { Embedder } from "../../src/types.js";

export function createTestService(overrides: Partial<RagServiceOptions> = {}) {
  const store = new InMemoryVectorStore();
  const base = new HashingEmbedder();
  const embedCalls: string[][] = [];
  const embedder: Embedder = {
    name: base.name,
    dimensions: base.dimensions,
    embed: async (texts) => {
      embedCalls.push(texts);
      return base.embed(texts);
    },
  };
  const service = new RagService({ embedder, store, generator: new ExtractiveGenerator(), ...overrides });
  return { service, store, embedCalls };
}
