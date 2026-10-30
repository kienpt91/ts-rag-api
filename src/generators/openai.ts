import { chunkLabel } from "../label.js";
import { JsonClient, type FetchLike } from "../http.js";
import { UpstreamError, type AnswerGenerator, type GenerateInput } from "../types.js";

export interface OpenAIGeneratorOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  fetch?: FetchLike | undefined;
}

export const SYSTEM_PROMPT =
  "You answer questions using only the numbered context passages provided. " +
  "Cite every claim with the passage number in square brackets, for example [1] or [2]. " +
  "If the passages do not contain the answer, say that you do not know. Do not use outside knowledge.";

export function buildUserPrompt({ question, chunks }: GenerateInput): string {
  const context = chunks
    .map((c, i) => `[${i + 1}] ${chunkLabel(c)}\n${c.text}`)
    .join("\n\n");
  return `Context:\n\n${context}\n\nQuestion: ${question}`;
}

/** Answer generator for any server implementing `POST {baseUrl}/chat/completions` in the OpenAI format. */
export class OpenAICompatibleGenerator implements AnswerGenerator {
  readonly name: string;
  private readonly client: JsonClient;

  constructor(private readonly options: OpenAIGeneratorOptions) {
    this.name = `openai-compatible:${options.model}`;
    this.client = new JsonClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, fetch: options.fetch, timeoutMs: 60_000 });
  }

  async generate(input: GenerateInput): Promise<string> {
    const json = (await this.client.post("/chat/completions", {
      model: this.options.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
    })) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new UpstreamError("Chat completion response had no content");
    return content.trim();
  }
}
