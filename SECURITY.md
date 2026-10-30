# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue:

- use GitHub's private vulnerability reporting ("Report a vulnerability" under the repository's Security tab), or
- email kienphan.dev@gmail.com.

Include what you found, how to reproduce it and the version or commit. You will get an acknowledgement within a few days. This is a small project maintained by one person, so there is no bug bounty and no fixed SLA, but confirmed issues are fixed as quickly as practical and credited if you wish.

## Security model

- The server binds to `127.0.0.1` by default. Binding to any other address, or configuring `EMBEDDINGS_API_KEY` / `LLM_API_KEY`, requires `API_KEY` to be set; otherwise it refuses to start.
- With `API_KEY` set, every route except `GET /health` requires `Authorization: Bearer <key>` or `X-API-Key: <key>`. Keys are compared in constant time. There is a single shared key: no users, roles or per-tenant isolation. The `filter` query field narrows results but is not an access-control boundary.
- Requests are rate limited per client address (in memory, per process) and bodies are capped by `MAX_BODY_BYTES` (at most 10 MiB).
- Ingested text is untrusted input to any language model it is later shown to (see "Prompt injection" in the README). Do not ingest content from sources you do not trust into an instance that uses an LLM generator.
- Error responses to clients never include upstream URLs or response bodies; those go to the server log only.

## Dependency policy

Direct dependencies are pinned to exact versions, and every package in `package-lock.json` (direct and transitive) was published on or before 2026-09-30, i.e. at least 30 days before it was chosen. GitHub Actions and the pgvector image used in CI are pinned by commit SHA / digest. Dependabot is configured with a 30-day cooldown.

## Open advisories

`npm audit` reports the following against the locked versions. The patched releases were published after the 2026-09-30 cutoff, so they have not been taken yet; each entry says whether the vulnerable code is reachable here. Re-check when the cutoff moves.

| Package (locked) | Advisory | Fixed in | Reachable here? |
| --- | --- | --- | --- |
| `zod` 4.6.5 (runtime) | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): memory exhaustion validating a very large array | 4.6.6 | No. The advisory concerns `z.array()` schemas; this project's request and config schemas contain no arrays (only objects, strings, numbers and string-keyed records), and request bodies are capped at `MAX_BODY_BYTES`. |
| `fastify` 5.12.5 (runtime) | [GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8) (low): header validation bypass via case-sensitive `propertyNames` | 5.12.6 | No. It affects routes that declare JSON-schema header validation with `propertyNames`; no route here uses Fastify schemas (validation is done with zod). |
| `fast-uri` 3.1.8 and 4.2.1 (runtime, via fastify's ajv and fast-json-stringify) | [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp): URI parsing and normalisation flaws | 4.2.3 (3.x: see advisories) | No. It is only used to resolve `$id`/`$ref` URIs in JSON schemas that Fastify compiles for its own internals; no request data is passed to it. |
| `ip-address` 10.7.2 (runtime, via `@fastify/rate-limit`) | [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) (moderate): quadratic-time IPv6 zone-identifier parsing | 10.7.4 | Barely. The rate limiter parses the client address only for IPv6 clients, and that address comes from the TCP socket, or from `X-Forwarded-For` only when `TRUST_PROXY=true`, in which case your proxy should already normalise it. |
| `vitest` 5.0.2, `@vitest/mocker`, `vite` 8.3.1, `source-map-js` 1.2.1 (dev only) | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp), [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) and several vite / launch-editor advisories (GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm, GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg) | vitest 5.0.3, vite 8.3.3, source-map-js 1.2.2 | Development and CI only; none of it ships with the server (`npm ci --omit=dev`). The issues involve Vite's dev server, the vitest UI/mock registration and Windows path handling, none of which `vitest run` exposes. Do not run the test suite against untrusted code on a machine with secrets. |
