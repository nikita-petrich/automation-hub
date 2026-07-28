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
- Read runtime config via `$env.*` (passed into the container) — don't hardcode calendar
  ids, schedules, etc.

## Shared logic (`lib/`)

- `lib/*.js` is the **single source** for Code-node logic. Keep the injectable part between
  `// ==== INLINE:START ====` / `// ==== INLINE:END ====` — dependency-free, no n8n globals
  (the thin glue in the Code node calls it). Export functions for tests; add `lib/*.test.js`.
- After editing `lib/`, run `npm run sync` (writes the copy into `workflow.json`). **CI fails on drift.**

## Deploy / tooling (`scripts/`)

- `deploy.ts` upserts by name via the n8n API, injects lib + schedule + credential id, and
  activates. Keep it idempotent. Never publish n8n's port beyond `127.0.0.1`. Never add a
  bundled proxy.

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
