import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { extractApiKey, safeEqual } from "./auth.js";
import type { RagService } from "./service.js";
import { UpstreamError } from "./types.js";

const metadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, "at most 20 metadata keys");

export const ingestSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/, "id may contain letters, digits and . _ : - (max 128 characters)")
    .optional(),
  title: z.string().trim().min(1).max(200).optional(),
  source: z.string().trim().min(1).max(500).optional(),
  metadata: metadataSchema.optional(),
  text: z.string().max(500_000).refine((t) => t.trim().length > 0, "text must not be blank"),
});

export const querySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional(),
  filter: metadataSchema.optional(),
});

export interface RateLimitOptions {
  /** Requests allowed per client address per window. */
  max: number;
  windowMs: number;
}

export interface AppOptions {
  service: RagService;
  bodyLimit?: number;
  logger?: boolean | { level: string };
  /** Reports whether the backing store is reachable. */
  healthCheck?: () => Promise<number>;
  /** When set, every route except /health requires this key (`Authorization: Bearer` or `X-API-Key`). */
  apiKey?: string | undefined;
  /** Per-client request limit for every route except /health. Omit to disable. */
  rateLimit?: RateLimitOptions | undefined;
  /** Trust `X-Forwarded-For` when identifying clients; enable only behind a proxy you control. */
  trustProxy?: boolean;
}

const UPSTREAM_MESSAGE = "The embeddings or language model service failed. Try again later.";

export function buildApp({
  service,
  bodyLimit = 1024 * 1024,
  logger = false,
  healthCheck,
  apiKey,
  rateLimit: limits,
  trustProxy = false,
}: AppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit, trustProxy });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (error instanceof UpstreamError) {
      // Upstream detail (hosts, ports, response bodies) stays in the server log.
      request.log.error({ err: error, upstreamStatus: (error as UpstreamError).status }, "upstream failure");
      return reply.status(502).send({ error: { code: "upstream_error", message: UPSTREAM_MESSAGE } });
    }
    const status = error.statusCode;
    if (status && status >= 400 && status < 500) {
      const codes: Record<number, string> = { 413: "payload_too_large", 415: "unsupported_media_type", 429: "rate_limited" };
      return reply.status(status).send({ error: { code: codes[status] ?? "bad_request", message: error.message } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: "not_found", message: "Route not found" } }));

  // Unauthenticated and not rate limited, so load balancers can probe it.
  app.get("/health", async (_request, reply) => {
    try {
      const chunks = healthCheck ? await healthCheck() : undefined;
      return { status: "ok", ...service.components, ...(chunks === undefined ? {} : { chunks }) };
    } catch {
      return reply.status(503).send({ status: "unavailable", ...service.components });
    }
  });

  // Everything that reads or writes data lives in this context. Registration order matters: the rate
  // limiter runs first so that wrong-key guessing is throttled too, then authentication, then the routes.
  app.register(async (api) => {
    if (limits && limits.max > 0) {
      await api.register(rateLimit, { global: true, max: limits.max, timeWindow: limits.windowMs, hook: "onRequest" });
    }
    if (apiKey) {
      // preParsing runs after the rate limiter (a route-level onRequest hook) and before the body is read.
      api.addHook("preParsing", async (request, reply) => {
        const provided = extractApiKey(request.headers);
        if (provided === undefined || !safeEqual(provided, apiKey)) {
          return reply
            .status(401)
            .header("www-authenticate", 'Bearer realm="ts-rag-api"')
            .send({ error: { code: "unauthorized", message: "Missing or invalid API key" } });
        }
      });
    }

    api.post("/documents", async (request, reply) => {
      const result = await service.ingest(ingestSchema.parse(request.body));
      return reply.status(result.unchanged ? 200 : 201).send(result);
    });

    api.post("/query", async (request) => service.query(querySchema.parse(request.body)));
  });

  return app;
}
