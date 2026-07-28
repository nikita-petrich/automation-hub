# Coding standards & conventions

## Workflows (`workflows/<name>/workflow.json`)

- Every workflow has a **stable, unique `name`** — it is the deploy upsert key. Never
  rename casually (a rename creates a *second* workflow in n8n).
- Set `active: true|false` explicitly; include `settings: { "executionOrder": "v1" }`.
- Node `type` / `typeVersion` must be valid for the pinned n8n image (`N8N_IMAGE_TAG`).
  Prefer **HTTP Request + a generic `oAuth2Api` credential** over buggy native nodes when
  you need `extendedProperties` / custom filtering.
- **Idempotency is mandatory** for anything that writes data: dedup by a stable external id
  in `extendedProperties.private` + a content signature; decide create / update / skip.
- **Never read `$env` in a workflow** — the container runs with
  `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` so that no node can read `N8N_ENCRYPTION_KEY` (and
  with it decrypt the stored Google credentials). `npm run validate` rejects any node
  that mentions `$env`. Don't hardcode calendar ids or schedules either: put runtime
  config in a `// CONFIG:START` / `// CONFIG:END` region (or a placeholder like
  `REPLACE_WITH_CALENDAR_ID`) and inject it at deploy time in `scripts/deploy.ts`.

## Shared logic (`lib/`)

- `lib/*.js` is the **single source** for Code-node logic. Keep the injectable part between
  `// ==== INLINE:START ====` / `// ==== INLINE:END ====` — dependency-free, no n8n globals
  (the thin glue in the Code node calls it). Export functions for tests; add `lib/*.test.js`.
- After editing `lib/`, run `npm run sync` (writes the copy into `workflow.json`). **CI fails on drift.**

## Deploy / tooling (`scripts/`)

- `deploy.ts` upserts by name via the n8n API, injects lib + schedule + runtime config +
  credential id, and activates. Keep it idempotent. Never publish n8n's port beyond
  `127.0.0.1`. Never add a bundled proxy.
- New runtime config belongs here, not in the container's `environment:`. Read it from
  `process.env` in `deploy.ts` and bake it into the workflow; add it to the
  *Deploy workflows into n8n* step in `.github/workflows/deploy.yml` so the runner has it.

## Validation (always, before commit)

```bash
npm run validate   # JSON/schema + lib drift + JS syntax
npm test           # lib unit tests
```

## Secrets & config

- **Never commit secrets.** All config = GitHub `production` Environment secrets, rendered
  into `.env` on the VPS at deploy. `.env` is gitignored.
- `N8N_ENCRYPTION_KEY` is set once and never changed.

## Commits / PRs

- Small, focused diffs; one feature/fix at a time. Descriptive messages. Open a PR;
  `validate.yml` must be green before merge.
