# AI interaction — how agents work in this repo

**AI-first policy.** This repository is intended to be changed by **AI agents**, not
hand-edited. Humans set intent (in `build-plan.md` or a prompt), review the spec and the
diff, and approve the PR. The only manual work is what an agent cannot do: GitHub secrets,
Google Cloud / OAuth browser consent, DNS, and n8n API-key/credential creation.

## Behavior

- **Spec before code.** For a new feature, write/update `current-feature.md` (what,
  done-when, ordered steps) and **pause for review** before implementing.
- **One item at a time.** Don't batch unrelated changes.
- **Observable steps.** Each step ends in something reviewable — a diff, a passing test, a
  green `validate`.
- **Verify.** Run `npm run validate` + `npm test` before every commit; keep CI green.
- **Respect the guardrails** in [`AGENTS.md`](../../AGENTS.md) (one-way deploy, SQLite, no
  bundled proxy, loopback-only port, secrets in the GitHub environment).
- **Don't touch generated copies.** Edit `lib/`, run `npm run sync`.
- **Ask when unsure** about product intent or an architectural change — don't guess.

## Definition of done

- The spec's done-when conditions are met and demonstrated.
- `validate` + `test` green locally and in CI.
- Docs updated if behavior/setup changed.
- PR opened; on merge to `main` it auto-deploys.
