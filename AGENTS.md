# AGENTS.md — automation-hub

**This is an AI-first repository.** Changes are made by **AI coding agents**
(Claude Code, Cursor, Codex, …) through pull requests — the code is not meant to be
hand-edited. A human's job is to set intent, review the spec and the diff, and
approve; plus the few things an agent cannot do (GitHub secrets, Google OAuth
consent, DNS, n8n API-key/credential creation).

Read this file before making any change. It is the canonical instruction set for
every agent and tool.

## What this repo is

A self-hosted n8n automation hub. The **repository is the single source of truth**;
deployment is **one-way** (repo → n8n) via GitHub Actions on merge to `main`. See
[`README.md`](README.md) for the overview, [`docs/manual-setup.md`](docs/manual-setup.md)
for how it fits together, and [`docs/ci-cd.md`](docs/ci-cd.md) for the pipeline.

## Golden rules (never break these)

1. **Repo is the source of truth.** Never rely on edits made in the n8n UI — they are
   overwritten on the next deploy. All workflow changes live in `workflows/**` and `lib/**`.
2. **One-way deploy.** Merging to `main` triggers CI/CD, which deploys to the VPS.
   Don't add steps that read live state back into the repo.
3. **Validate before committing.** Always run `npm run validate` and `npm test`; keep CI green.
4. **Small, reviewable diffs.** One feature/fix at a time. Spec first (see `blueprint/`),
   then implement in observable steps.
5. **Never commit secrets.** All config = GitHub `production` Environment secrets,
   rendered into `.env` at deploy. `.env` is gitignored.
6. **Don't hand-maintain derived copies.** Edit `lib/` (the single source of the
   Code-node logic) and run `npm run sync`; never edit the injected copy in `workflow.json`.

## Architecture guardrails (don't change without explicit instruction)

- n8n runs on **SQLite**, container name `n8n`, published only on `127.0.0.1:5678`.
- **No bundled reverse proxy** — TLS/routing is the user's external `nginx-auto-ssl`.
- Deploy runs on the **GitHub runner over an SSH tunnel** (cert-independent); the VPS
  needs only Docker.
- `N8N_ENCRYPTION_KEY` is set once and **never changed**.

## How to build a feature (= a new workflow)

Follow the spec-first loop in [`blueprint/`](blueprint/) (adapted from
[ai-blueprint](https://github.com/bradtraversy/ai-blueprint)). There is a
`/new-workflow` skill that scaffolds this.

1. **Plan** — add the item to `blueprint/build-plan.md`.
2. **Spec** — write `blueprint/context/current-feature.md` (what, done-when, steps)
   and **stop for human review** before writing code.
3. **Implement** — create `workflows/<name>/workflow.json` with a **stable, unique
   `name`** (the deploy upsert key) and `active: true|false`. Put shared logic in
   `lib/` between the `INLINE` markers; run `npm run sync`. Add `workflows/<name>/README.md`.
4. **Verify** — `npm run validate` + `npm test` green; demonstrate it works.
5. **Complete** — open a PR; on merge to `main` it auto-deploys. Archive the spec under
   `blueprint/history/features/`.

Exact conventions: [`blueprint/context/coding-standards.md`](blueprint/context/coding-standards.md).
Agent behavior: [`blueprint/context/ai-interaction.md`](blueprint/context/ai-interaction.md).

## What a human still does (cannot be automated)

Creating GitHub secrets, the Google Cloud project + OAuth **browser consent**, DNS,
and the n8n API-key/credential creation. Everything else is agent + CI/CD.
