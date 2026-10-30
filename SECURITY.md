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

Direct dependencies are pinned to exact versions, and every package in `package-lock.json` (direct and transitive) was published on or before 2026-10-23, i.e. at least 7 days before it was chosen. Dependabot is configured with a 7-day cooldown. Packages are installed, tested and built only inside throwaway containers, and installs run with `--ignore-scripts` (CI uses `npm ci --ignore-scripts`), so package install scripts never run. The two packages in the lockfile that declare install scripts are `esbuild` (via `tsx`, dev only) and the optional macOS `fsevents`; neither is needed, because `esbuild` ships its binary as a platform-specific optional dependency. GitHub Actions are pinned by full commit SHA and the pgvector image used in CI by digest.

## Open advisories

None. `npm audit` and `npm audit --omit=dev` report 0 vulnerabilities against the locked versions as of 2026-10-30. The advisories listed here previously (zod, fastify, fast-uri, ip-address, vitest/vite/source-map-js) are fixed by the current lockfile.
