# ts-rag-api

A small retrieval-augmented generation (RAG) HTTP API in TypeScript. You post documents, ask questions, and get back the top-k matching chunks plus an answer that cites them.

It runs fully offline by default (deterministic local embedder, in-memory index, extractive answers), and swaps in Postgres + pgvector and any OpenAI-compatible embeddings/chat endpoint through environment variables. The retrieval pipeline has a test suite and a small evaluation script (hit@k, MRR) so quality changes are measurable.

Stack: Node, TypeScript (strict), Fastify, zod, `pg`, vitest.

## Quick start (demo mode, no API keys, no database)

```bash
npm install
npm run build
PORT=3000 npm start          # or: npm run dev
```

The server listens on `127.0.0.1` only. To expose it (for example in a container) you must also set `HOST` and `API_KEY`, see [Security](#security).

Seed it with the sample handbook in `fixtures/corpus` (needs `jq`):

```bash
for f in fixtures/corpus/*.md; do
  id=$(basename "$f" .md)
  jq -Rs --arg id "$id" '{id: $id, source: ("fixtures/corpus/" + $id + ".md"), metadata: {collection: "handbook"}, text: .}' "$f" |
    curl -s -X POST localhost:3000/documents -H 'content-type: application/json' -d @-
  echo
done
```

```bash
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -d '{"question":"How long do card refunds take?","topK":3}' | jq '{answer, citations: [.citations[] | {ref, label}]}'
```

```json
{
  "answer": "Card refunds usually appear within 5 to 10 business days, depending on the issuing bank. [1]",
  "citations": [{ "ref": 1, "label": "Refund Policy > Processing time" }]
}
```

## API

All bodies are JSON. Errors always look like `{"error": {"code": "...", "message": "..."}}`.

### `GET /health`

```bash
curl -s localhost:3000/health
```
```json
{"status":"ok","embedder":"hashing-1536","store":"memory","generator":"extractive","chunks":0}
```

Returns 503 with `"status":"unavailable"` if the store cannot be reached.

### `POST /documents`

Ingests plain text or markdown.

| field      | type                    | notes                                                                      |
| ---------- | ----------------------- | -------------------------------------------------------------------------- |
| `text`     | string, required        | up to 500,000 characters, must not be blank                                |
| `id`       | string, optional        | `[A-Za-z0-9._:-]{1,128}`. Defaults to a hash of `text`                     |
| `title`    | string, optional        | up to 200 chars. Defaults to the first markdown heading, then the id       |
| `source`   | string, optional        | free-form origin (URL, path), returned in citations                        |
| `metadata` | `{string: string}`, opt | at most 20 keys; copied to every chunk and usable as a query filter        |

```bash
curl -s -X POST localhost:3000/documents -H 'content-type: application/json' -d '{
  "id": "refund-policy",
  "title": "Refund Policy",
  "source": "handbook/refunds.md",
  "metadata": {"team": "support"},
  "text": "# Refund Policy\n\n## Eligibility\n\nCustomers may request a refund within 30 days of purchase.\n\n## Processing time\n\nCard refunds usually appear within 5 to 10 business days, depending on the issuing bank."
}'
```
```json
{"documentId":"refund-policy","title":"Refund Policy","chunks":2,"added":2,"removed":0,"unchanged":false}
```

Sending the identical request again is a no-op: status `200` instead of `201`, nothing is embedded or written:

```json
{"documentId":"refund-policy","title":"Refund Policy","chunks":2,"added":0,"removed":0,"unchanged":true}
```

### `POST /query`

| field      | type                    | notes                                              |
| ---------- | ----------------------- | -------------------------------------------------- |
| `question` | string, required        | 1 to 2000 characters                               |
| `topK`     | integer, optional       | 1 to 20, default 4 (`TOP_K_DEFAULT`)               |
| `filter`   | `{string: string}`, opt | only chunks whose metadata contains all pairs      |

```bash
curl -s -X POST localhost:3000/query -H 'content-type: application/json' \
  -d '{"question":"How long do card refunds take?","topK":1,"filter":{"team":"support"}}'
```
```json
{
  "question": "How long do card refunds take?",
  "answer": "Card refunds usually appear within 5 to 10 business days, depending on the issuing bank. [1]",
  "citations": [
    {
      "ref": 1,
      "label": "Refund Policy > Processing time",
      "chunkId": "b42fa05e80063fef88484108",
      "documentId": "refund-policy",
      "title": "Refund Policy",
      "heading": "Refund Policy > Processing time",
      "source": "handbook/refunds.md",
      "score": 0.29740968108632754
    }
  ],
  "chunks": [
    {
      "id": "b42fa05e80063fef88484108",
      "documentId": "refund-policy",
      "title": "Refund Policy",
      "source": "handbook/refunds.md",
      "heading": "Refund Policy > Processing time",
      "position": 1,
      "text": "Card refunds usually appear within 5 to 10 business days, depending on the issuing bank.",
      "metadata": { "team": "support" },
      "score": 0.29740968108632754
    }
  ],
  "generator": "extractive"
}
```

- `chunks` is everything retrieved (best first, scores are cosine similarity, anything below `MIN_SCORE` is dropped).
- `answer` marks its sources with `[n]`. `citations` lists exactly the sources the answer refers to, and `citations[i].ref - 1` indexes into `chunks`.
- If nothing scores above `MIN_SCORE`, the answer is `I could not find anything relevant in the indexed documents.` with empty `citations` and `chunks`; the generator is not called.

Validation and limits:

```bash
curl -s -X POST localhost:3000/query -H 'content-type: application/json' -d '{"question":"","topK":50}'
```
```json
{"error":{"code":"invalid_request","message":"Request validation failed","issues":[{"path":"question","message":"Too small: expected string to have >=1 characters"},{"path":"topK","message":"Too big: expected number to be <=20"}]}}
```

| situation                                    | status | `error.code`            |
| -------------------------------------------- | ------ | ----------------------- |
| schema violation, malformed JSON             | 400    | `invalid_request` / `bad_request` |
| missing or wrong API key (when `API_KEY` is set) | 401 | `unauthorized`      |
| body larger than `MAX_BODY_BYTES` (1 MiB)    | 413    | `payload_too_large`     |
| non-JSON content type such as `application/xml` | 415 | `unsupported_media_type` |
| more than `RATE_LIMIT_MAX` requests per window | 429  | `rate_limited` (with `Retry-After`) |
| embeddings / LLM endpoint failed             | 502    | `upstream_error`, generic message; detail is only in the server log |

## Architecture

```mermaid
flowchart LR
    client([Client]) -->|POST /documents| api
    client -->|POST /query| api
    client -->|GET /health| api

    subgraph app [ts-rag-api]
        api[Fastify routes<br/>zod validation, size limits] --> svc[RagService]
        svc --> chunker[Markdown chunker<br/>heading-aware, overlap,<br/>content-hash ids]
        svc --> emb{{Embedder}}
        svc --> vs{{VectorStore}}
        svc --> gen{{AnswerGenerator}}
    end

    emb -.default.-> hashing[HashingEmbedder<br/>local, deterministic]
    emb -.EMBEDDINGS_BASE_URL.-> oaiE[OpenAI-compatible<br/>/embeddings]
    vs -.default.-> mem[InMemoryVectorStore<br/>cosine]
    vs -.DATABASE_URL.-> pg[(Postgres + pgvector)]
    gen -.default.-> ext[ExtractiveGenerator<br/>quotes best sentences]
    gen -.LLM_BASE_URL.-> oaiG[OpenAI-compatible<br/>/chat/completions]
```

Source layout:

```
src/
  app.ts            Fastify routes, zod schemas, error mapping
  service.ts        RagService: ingest (chunk, id, diff, embed, store) and query (retrieve, generate, cite)
  chunker.ts        markdown-aware chunking
  types.ts          Embedder, VectorStore, AnswerGenerator interfaces
  embedders/        hashing.ts (local), openai.ts (OpenAI-compatible HTTP)
  stores/           memory.ts, pgvector.ts (store + SQL migration runner)
  generators/       extractive.ts, openai.ts
  config.ts         env parsing and component selection
  eval/             metrics, fixture loader, `npm run eval`
migrations/         001_create_chunks.sql, 002_embedding_index.sql
fixtures/           sample corpus (9 markdown documents) and 32 Q&A pairs
test/               vitest suites
```

### Chunking and idempotent ingestion

- The chunker splits markdown into paragraphs, never crosses a heading, and records each chunk's heading path (`Refund Policy > Processing time`). Fenced code blocks stay in one piece unless they exceed the size limit. Chunks are packed up to `CHUNK_MAX_TOKENS` (estimated as characters / 4); long paragraphs are split on sentences, then words; consecutive chunks in a section share up to `CHUNK_OVERLAP_TOKENS` of trailing text.
- Chunk id = first 24 hex chars of a SHA-256 over document id, title, source, metadata, heading path, text and the number of identical chunks seen earlier in the document. Same input, same ids.
- On ingest the service compares the new ids with the ids already stored for that document, embeds and upserts only the new ones, and deletes the ones that disappeared. Re-sending an unchanged document performs no embedding calls and no writes; editing one paragraph re-embeds only that chunk (its neighbours' `position` field is not refreshed).
- Embedding happens outside any lock. The diff, upsert and delete then run under a per-document lock: on Postgres one transaction holding `pg_advisory_xact_lock(hashtext('rag_chunks:' || document_id))` (so concurrent ingests of the same document, even from different processes, run one after another and a failure rolls everything back); on the in-memory store an in-process mutex per document.
- Changing title, source or metadata changes the ids, so those chunks are re-embedded and the old ones removed.

## Configuration

| variable                 | default                    | description                                                                                       |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3000`                     | listen port                                                                                       |
| `HOST`                   | `127.0.0.1`                | listen address. Anything other than a loopback address requires `API_KEY`                         |
| `API_KEY`                | unset                      | shared secret (16+ characters) required on every route except `/health`. **Required** when `HOST` is not loopback or when `EMBEDDINGS_API_KEY` / `LLM_API_KEY` is set; the server refuses to start otherwise |
| `RATE_LIMIT_MAX`         | `120`                      | requests per client address per window on every route except `/health`; `0` disables              |
| `RATE_LIMIT_WINDOW_SECONDS` | `60`                    | length of the rate limit window                                                                   |
| `TRUST_PROXY`            | `false`                    | `true` to take the client address from `X-Forwarded-For`; set it only behind a proxy you control, otherwise every client looks like the proxy (or can spoof its address) |
| `LOG_LEVEL`              | `info`                     | `fatal` `error` `warn` `info` `debug` `trace` `silent`                                            |
| `MAX_BODY_BYTES`         | `1048576`                  | request body limit; larger requests get 413. Values above 10 MiB are rejected at startup          |
| `CHUNK_MAX_TOKENS`       | `200`                      | max estimated tokens per chunk                                                                    |
| `CHUNK_OVERLAP_TOKENS`   | `30`                       | overlap between consecutive chunks (must be < max)                                                |
| `MIN_SCORE`              | `0.05`                     | retrieved chunks with lower cosine similarity are discarded                                       |
| `TOP_K_DEFAULT`          | `4`                        | `topK` used when a query omits it                                                                 |
| `DATABASE_URL`           | unset                      | set to use Postgres + pgvector instead of the in-memory store                                     |
| `EMBEDDINGS_DIMENSIONS`  | `1536`                     | vector size. Must match the embedding model and the migrated column (hashing embedder uses it too) |
| `EMBEDDINGS_BASE_URL`    | unset                      | OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`, an Ollama or vLLM server). Setting it or `EMBEDDINGS_API_KEY` switches off the local embedder |
| `EMBEDDINGS_API_KEY`     | unset                      | bearer token; base URL defaults to `https://api.openai.com/v1` when only the key is set           |
| `EMBEDDINGS_MODEL`       | `text-embedding-3-small`   | model name sent to `/embeddings`                                                                  |
| `LLM_BASE_URL`           | unset                      | OpenAI-compatible base URL for `/chat/completions`. Setting it or `LLM_API_KEY` switches off the extractive generator |
| `LLM_API_KEY`            | unset                      | bearer token; base URL defaults to `https://api.openai.com/v1` when only the key is set           |
| `LLM_MODEL`              | `gpt-4o-mini`              | model name sent to `/chat/completions`                                                            |

Empty strings count as unset. Invalid values stop the process at startup with the variable name in the message.

Example, hosted embeddings and chat with Postgres:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/rag
export API_KEY=$(openssl rand -hex 32)      # required once provider keys are set
export EMBEDDINGS_API_KEY=... EMBEDDINGS_DIMENSIONS=1536
export LLM_API_KEY=...
npm run migrate && npm start
```

When a generator is configured the model is told to answer only from the numbered passages and to cite them as `[n]`; `citations` is built from whichever markers appear in its reply. If the model writes none, `citations` is empty but `chunks` still shows what was retrieved. Upstream failures return 502.

### Postgres + pgvector

```bash
docker run -d --name rag-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rag pgvector/pgvector:0.8.6-pg16
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/rag
npm run migrate        # creates the vector extension, rag_chunks table, indexes; safe to re-run
npm start
```

`npm run migrate` applies `migrations/*.sql` in order, records them in `rag_migrations`, and substitutes `EMBEDDINGS_DIMENSIONS` into `vector(N)`. The column size is fixed at migration time: if you change embedding models you need a new table or database. Search uses cosine distance (`<=>`) with an HNSW index (requires pgvector 0.5 or newer, and N <= 2000 for the index) and a GIN index for metadata filters (`metadata @> filter`).

## Security

- **Network exposure.** The server listens on `127.0.0.1` by default. To accept remote connections set `HOST` (for example `0.0.0.0` in a container) **and** `API_KEY`; without a key the process exits at startup with a message saying why. The same applies when `EMBEDDINGS_API_KEY` or `LLM_API_KEY` is set, because an open endpoint would let anyone spend it.
- **Authentication.** With `API_KEY` set, send `Authorization: Bearer <key>` or `X-API-Key: <key>` on `POST /documents` and `POST /query`; `GET /health` stays open for probes. Comparison is constant-time (SHA-256 digests compared with `crypto.timingSafeEqual`, so key length is not leaked either), and the key is checked before the request body is read. It is a single shared secret. Terminate TLS in front of the server; keys travel in headers.
- **Rate limiting.** `@fastify/rate-limit` runs before authentication so wrong-key guessing is throttled too: `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_SECONDS` per client address, then 429 with `Retry-After`. Behind a reverse proxy set `TRUST_PROXY=true`, otherwise all clients share the proxy's address.
- **Limits.** Bodies are capped by `MAX_BODY_BYTES` (default 1 MiB, hard maximum 10 MiB); text, ids, metadata and `topK` have schema limits (see the API tables).
- **Errors.** 502 responses carry a generic message; upstream hosts, ports and response bodies appear only in the server log. Request bodies are not logged.
- **Prompt injection.** Anything you ingest becomes context for the generator, so ingested text is untrusted input. With an LLM generator, a document containing "ignore your instructions and ..." can try to steer the answer. The system prompt tells the model to treat passages as data and cite them, which reduces but does not eliminate the risk: only ingest content you trust, protect `POST /documents` with the API key, and read `citations` / `chunks` to see what an answer was based on. The default **extractive generator is not exposed to this**: it never sends text to a model, it only copies the highest-overlap sentence from each retrieved chunk and appends `[n]`, so instructions inside a document can at worst appear as quoted text. Document ids are caller-chosen, so a client with the key can overwrite any document by reusing its id.
- Reporting and open dependency advisories: see [SECURITY.md](SECURITY.md).

## Tests

```bash
npm run typecheck
npm test
```

`npm test` needs no network, API keys or database. It covers the chunker, embedder, both vector stores (one shared contract suite), the OpenAI-compatible adapters (fake `fetch`), extractive answers, citation format, retrieval ranking on the fixture corpus, idempotent and incremental re-ingest, zod validation, body size limits, error mapping, and config wiring.

The pgvector integration tests (contract suite plus migrations) run only when `DATABASE_URL` is set and are reported as skipped otherwise. Without a database `npm test` reports `118 passed | 22 skipped`. With one:

```bash
docker run -d --name rag-test-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rag_test pgvector/pgvector:0.8.6-pg16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/rag_test npm test
```

With a database the full suite reports `139 passed | 1 skipped` (the one skip is a rollback test that only applies to transactional stores). Each run creates and drops its own schema. CI starts a `pgvector/pgvector:0.8.6-pg16` service (pinned by digest) and runs everything.

## Evaluation

```bash
npm run eval
```

Ingests the 9 documents in `fixtures/corpus` (45 chunks) into an in-memory store with the local embedder and asks the 32 questions in `fixtures/qa.json`. A retrieved chunk counts as relevant when it comes from the expected document **and** contains the quoted evidence text, so landing on the right document but the wrong section is a miss. Output from this repository:

```
Retrieval eval: 32 questions, 9 documents, 45 chunks, embedder hashing-1536

metric          value
--------------  ------
hit@1           78.1%
hit@3           93.8%
hit@5           93.8%
MRR@10          0.860
document hit@1  100.0%

Not ranked first:
  rank 10  [refund-policy]  How many days do I have to ask for my money back?
  rank 2  [on-call-rotation]  How long before the secondary engineer is paged?
  rank 2  [incident-severity]  How often are status page updates posted during a SEV1?
  rank 2  [incident-severity]  Who writes the postmortem and when is it due?
  rank 3  [api-rate-limits]  How should clients back off after being rate limited?
  rank 2  [backup-and-restore]  How far back can the database be recovered to a point in time?
  rank 10  [expense-reimbursement]  What is the daily meal allowance on business trips?
```

hit@k is the share of questions with a relevant chunk in the top k; MRR@10 is the mean of 1/rank of the first relevant chunk (0 if absent from the top 10). Treat these numbers as a smoke test on a tiny corpus: the questions are phrased differently from the source text but I wrote both, so the set is friendlier than real traffic. The test suite asserts only loose floors (hit@3 >= 0.8, MRR >= 0.7) so it fails on regressions, not on small tweaks. To evaluate your own embedder or corpus, replace the fixtures or construct a `RagService` with your components and call `runEval` from `src/eval/run.ts`.

## Limitations

- **The default embedder is a toy.** `HashingEmbedder` is a bag of stemmed words and word pairs hashed into a fixed-size vector. It matches vocabulary, not meaning: "money back" will not find "refund", and "daily meal allowance" only ranks the "Meals are limited to 60 dollars" chunk 10th in the eval above. Hash collisions also give unrelated text a small non-zero similarity (the nonsense query "zyzzyva quokka xylophone" scores 0.15 against some chunk of the sample corpus), so `MIN_SCORE` is a weak "no answer" filter in demo mode. It exists so the pipeline is testable and demoable offline; use a real embedding model (`EMBEDDINGS_BASE_URL`) for anything that needs semantic search.
- **Extractive answers are quotes, not synthesis.** The default generator picks the sentence overlapping the question most from each of the best chunks. It cannot combine facts, resolve pronouns or say "no" to a yes/no question.
- **The in-memory store is not persistent** and does brute-force search; use `DATABASE_URL` for anything beyond demos or a few thousand chunks.
- **One shared API key, no multi-tenancy.** There are no users, roles or per-collection permissions; `filter` is a convenience, not an access control boundary. Rate limiting is in memory and per process, so it is per instance, not global.
- No document deletion or listing endpoints, no hybrid (keyword + vector) search, no reranking, no streaming responses.
- The token count is a characters / 4 estimate, not a real tokenizer, so chunk sizes are approximate for non-English text and code.
- The pgvector column dimension is fixed when the migration runs.
- The migration runner splits files on a semicolon at the end of a line; keep migrations to plain DDL.
- Verified on Node 22. The `engines` field says Node >= 20 but that range is not tested here.

## Secrets and hooks

- Never commit `.env` files or credentials. Copy `.env.example` to `.env` for local settings; `.env` is gitignored.
- Install [lefthook](https://github.com/evilmartians/lefthook) and run `lefthook install` once per clone. This enables two hooks from `lefthook.yml`:
  - `pre-commit` runs `sh scripts/secret-scan.sh --staged` and blocks a commit that stages a secret.
  - `pre-push` runs `sh scripts/secret-scan.sh --tree` and blocks a push if the working tree contains one.
- The scanner (`scripts/secret-scan.sh`) has no dependencies. It flags secret-shaped values and forbidden file names, and prints the file, line and rule but never the value. CI also scans the tree and the full history.
- A reviewed false positive can be listed in `.secret-scan-allow`, one line per file and rule: `<path> <rule>  # reason`. A single line can be allowed with the inline marker `secret-scan: allow`. Keep entries specific and never allow a real credential.
- If a secret is ever committed, rotate it first (assume it is compromised), then remove it from history.

## License

MIT, see [LICENSE](LICENSE).
