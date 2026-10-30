import { JsonClient, type FetchLike } from "../http.js";
import { UpstreamError, type Embedder } from "../types.js";

export interface OpenAIEmbedderOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  apiKey?: string | undefined;
  fetch?: FetchLike | undefined;
  batchSize?: number;
}

/** Embedder for any server implementing `POST {baseUrl}/embeddings` in the OpenAI format. */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly name: string;
  readonly dimensions: number;
  private readonly client: JsonClient;
  private readonly batchSize: number;

  constructor(private readonly options: OpenAIEmbedderOptions) {
    this.dimensions = options.dimensions;
    this.batchSize = options.batchSize ?? 64;
    this.name = `openai-compatible:${options.model}`;
    this.client = new JsonClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, fetch: options.fetch });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const input = texts.slice(start, start + this.batchSize);
      const json = (await this.client.post("/embeddings", { model: this.options.model, input })) as {
        data?: { index?: number; embedding?: unknown }[];
      };
      const data = json.data;
      if (!Array.isArray(data) || data.length !== input.length) {
        throw new UpstreamError(`Embeddings response had ${Array.isArray(data) ? data.length : "no"} items for ${input.length} inputs`);
      }
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const item of ordered) {
        const vector = item.embedding;
        if (!Array.isArray(vector) || vector.length !== this.dimensions || !vector.every((n) => typeof n === "number")) {
          throw new UpstreamError(`Embedding length does not match EMBEDDINGS_DIMENSIONS=${this.dimensions}`);
        }
        out.push(vector as number[]);
      }
    }
    return out;
  }
}
