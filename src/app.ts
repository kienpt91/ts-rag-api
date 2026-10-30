import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
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

export interface AppOptions {
  service: RagService;
  bodyLimit?: number;
  logger?: boolean | { level: string };
  /** Reports whether the backing store is reachable. */
  healthCheck?: () => Promise<number>;
}

export function buildApp({ service, bodyLimit = 1024 * 1024, logger = false, healthCheck }: AppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit });

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
      request.log.error({ err: error }, "upstream failure");
      return reply.status(502).send({ error: { code: "upstream_error", message: error.message } });
    }
    const status = error.statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : "bad_request";
      return reply.status(status).send({ error: { code, message: error.message } });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: "not_found", message: "Route not found" } }));

  app.get("/health", async (_request, reply) => {
    try {
      const chunks = healthCheck ? await healthCheck() : undefined;
      return { status: "ok", ...service.components, ...(chunks === undefined ? {} : { chunks }) };
    } catch {
      return reply.status(503).send({ status: "unavailable", ...service.components });
    }
  });

  app.post("/documents", async (request, reply) => {
    const result = await service.ingest(ingestSchema.parse(request.body));
    return reply.status(result.unchanged ? 200 : 201).send(result);
  });

  app.post("/query", async (request) => service.query(querySchema.parse(request.body)));

  return app;
}
