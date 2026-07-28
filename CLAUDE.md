# CLAUDE.md

This is an **AI-first** repository. All conventions, guardrails, and the
feature-building workflow live in **[AGENTS.md](AGENTS.md)** — read it first and
follow it for every change.

Quick reminders for Claude Code:

- Run `npm run validate` and `npm test` before committing; keep CI green.
- Changes go through pull requests; merging to `main` auto-deploys (one-way, repo → n8n).
- Never hand-edit the lib copy inside `workflow.json` — edit `lib/` and run `npm run sync`.
- Never commit secrets (all config is in the GitHub `production` Environment).
- Small, spec-first, one-feature-at-a-time diffs (see [`blueprint/`](blueprint/)).

Project skill: **`/new-workflow`** scaffolds a new n8n workflow the AI-first way
(see `.claude/skills/new-workflow`).
