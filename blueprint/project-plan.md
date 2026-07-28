# Project plan (source of truth for intent)

> Human-maintained. When this changes, regenerate `context/project-overview.md`.

## What

A self-hosted **n8n automation hub**. Business workflows are versioned as code in this
repo (single source of truth) and deployed **one-way** to a VPS via GitHub Actions.

## Why

Run reliable, self-hosted automations with full history, review, and reproducibility —
starting with automations that were removed elsewhere (e.g. the Contacts→Calendar
birthday sync disabled in Germany since 2024). The instance is meant to **scale**:
more business workflows drop into the same repo over time.

## Users

The repo owner and future collaborators / AI agents building new workflows.

## Tech choices

- **n8n** (Docker, **SQLite**) behind the user's existing **nginx-auto-ssl** reverse proxy.
- Config in a GitHub **`production` Environment** (secrets), rendered to `.env` on deploy.
- **CI/CD:** GitHub Actions → SSH → `docker compose up` + workflow import over an SSH tunnel.
- Shared logic in **`lib/`** (unit-tested), injected into n8n Code nodes at deploy.

## Non-goals

- No Postgres (SQLite is enough for a single instance).
- No bundled proxy (the user runs their own).
- No UI-first / hand editing (repo is the source of truth; changes go through AI agents).
