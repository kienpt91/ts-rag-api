import { UpstreamError } from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}

/** Minimal JSON POST client for OpenAI-compatible endpoints. */
export class JsonClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: JsonClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async post(pathname: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new UpstreamError(`Request to ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new UpstreamError(`Upstream ${pathname} responded ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new UpstreamError(`Upstream ${pathname} returned invalid JSON`, response.status);
    }
  }
}
