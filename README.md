# automation-hub

Self-hosted [n8n](https://n8n.io) automation instance, reachable over HTTPS, with
**this repository as the single source of truth**. Workflows are authored here as
code, validated in CI, and pushed **one way** into the running instance:

```
   repo  ──────────────►  n8n
        scripts/deploy.ts
   (never the other way)
```

The instance is designed to **scale**: more business workflows drop into
`workflows/<name>/` and are deployed by the same `deploy` command. The first
workflow, [`birthday-sync`](workflows/birthday-sync/), syncs birthdays from
Google Contacts into a dedicated Google Calendar as yearly all-day events —
replacing the native Contacts→Calendar birthday sync that has been disabled in
Germany since 2024 for regulatory reasons.

> 🤖 **AI-first repository.** Changes here are made by **AI coding agents** through
> pull requests — the code is not meant to be hand-edited. See **[AGENTS.md](AGENTS.md)**
> for the rules and **[blueprint/](blueprint/)** for the spec-first workflow (adapted
> from [ai-blueprint](https://github.com/bradtraversy/ai-blueprint)).

---

## Architecture

| Component | Choice | Why |
|-----------|--------|-----|
| Automation engine | **n8n** (Docker, pinned tag) | Visual workflows + code where needed. |
| Database | **SQLite** (n8n default) | Zero-ops; fine for a single-instance hub. Persisted in a Docker volume. |
| Reverse proxy / TLS | **your existing [`nginx-auto-ssl`](https://github.com/nikita-petrich/reverse-proxy) proxy** | Not part of this repo; n8n joins its shared Docker network and is routed by `SITES`. |
| Network exposure | none public; `127.0.0.1:5678` loopback only | The proxy reaches n8n over the shared network; the loopback port is only for the on-host deploy. |
| Config | **`.env`** (rendered from GitHub Environment in CI/CD) | No secrets in the repo. |
| Deploy | **n8n Public REST API** (`scripts/deploy.ts`) | Idempotent upsert by workflow name; CLI fallback. |

```
Internet ─► your nginx-auto-ssl proxy ─(shared docker net)─► n8n:5678 ─► SQLite volume
             (TLS, SITES routing)                                 ▲
                                              127.0.0.1:5678 ──────┤ X-N8N-API-KEY
                                              scripts/deploy.ts (repo → n8n)
```

> **Reverse proxy:** TLS termination and hostname routing are handled by a **separate
> repo** — [`nikita-petrich/reverse-proxy`](https://github.com/nikita-petrich/reverse-proxy)
> (an `nginx-auto-ssl` instance). n8n only joins that proxy's shared Docker network
> (`PROXY_NETWORK`) and is reachable to it as `n8n:5678`; you add it to the proxy's
> `SITES` (`<your-domain>=n8n:5678`). This repo ships no proxy of its own.

## Repository layout

```
automation-hub/
├── docker-compose.yml         # n8n (SQLite), joins your reverse proxy's network
├── .env.example               # every variable, documented (copy to .env)
├── package.json               # deploy / backup / validate / sync / test scripts
├── scripts/
│   ├── deploy.ts              # upsert ALL workflows via the n8n REST API
│   ├── backup.ts              # export live n8n → backups/ (safety net)
│   ├── validate.ts            # CI validation + `--fix` lib→workflow sync
│   └── vps-deploy.sh          # on-VPS deploy (compose up + workflow deploy)
├── workflows/
│   └── birthday-sync/         # one folder per workflow
│       ├── workflow.json      # the n8n workflow (stable id + name)
│       └── README.md
├── lib/
│   ├── calendar-upsert.js     # shared, unit-tested upsert logic (single source)
│   └── calendar-upsert.test.js
├── docs/
│   ├── manual-setup.md        # full one-time setup guide (server, DNS, Google, n8n)
│   └── ci-cd.md               # automatic deployment to the VPS (CI/CD)
└── .github/workflows/
    ├── validate.yml           # validation on PRs / pushes (no secrets)
    └── deploy.yml             # CD: deploy the whole stack to the VPS on push to main
```

## Quick start

> Full, click-by-click instructions (server, DNS, Google Cloud, OAuth, API key)
> live in **[docs/manual-setup.md](docs/manual-setup.md)**. Short version:

```bash
# 1. Configure
cp .env.example .env
nano .env                       # set DOMAIN, N8N_ENCRYPTION_KEY, CALENDAR_ID ...
#   generate the encryption key with:  openssl rand -hex 32

# 2. Start n8n (your reverse proxy must already run; PROXY_NETWORK must match it)
docker compose up -d
docker compose logs -f n8n      # wait until healthy

# 3. In the browser: create the n8n owner account at https://<your-domain>,
#    create the Google OAuth2 credential, generate an n8n API key.
#    Put N8N_API_KEY (and optionally GOOGLE_OAUTH_CRED_ID) into .env.

# 4. Deploy the workflows from the repo
npm install
npm run deploy
```

## Everyday commands

| Command | What it does |
|---------|--------------|
| `npm run validate` | Parse + schema-check every workflow, verify the Code node matches `lib/`, run type/JS checks. Used by CI. |
| `npm run sync` | Re-inject `lib/calendar-upsert.js` into `workflow.json` after you edit the library. |
| `npm test` | Run the `lib/` unit tests. |
| `npm run deploy` | Upsert **all** workflows into n8n (create if new, replace if existing). Idempotent. |
| `npm run backup` | Export the live workflows to `backups/<timestamp>/` (disaster-recovery snapshot). |

## Adding another workflow

1. Create `workflows/<your-workflow>/workflow.json` with a **stable `name`** (the
   deploy upsert key) and `active: true|false`.
2. Add a short `workflows/<your-workflow>/README.md`.
3. If it needs shared logic, put it in `lib/` and reference it from a Code node
   between `// LIB:START` / `// LIB:END` markers (see `birthday-sync`), then run
   `npm run sync`.
4. `npm run validate` locally, commit, open a PR (CI validates). Merge to `main`
   and the CD pipeline deploys it automatically (see below).

## Continuous deployment (CI/CD)

Two GitHub Actions workflows:

- **`validate.yml`** runs on every pull request / push — JSON/schema validation,
  `lib/` sync check, and unit tests. No secrets, never deploys.
- **`deploy.yml`** runs on push to **`main`** (or via *Run workflow*): it validates,
  copies the repo onto the VPS over SSH (tar), renders the `.env` from GitHub secrets,
  runs `docker compose up -d` there, and imports the workflows into n8n from the
  runner **over an SSH tunnel** (cert-independent) — so both infra and workflow
  changes go live automatically. Deploys are idempotent.

All configuration lives in a GitHub **`production` Environment** (as secrets); the
pipeline renders the VPS `.env` from it on every deploy. How the pipeline works is in
**[docs/ci-cd.md](docs/ci-cd.md)**; the full from-scratch setup (VPS, proxy, DNS,
Google, secrets) is in **[docs/manual-setup.md](docs/manual-setup.md)**.

## AI-first development

This repo is designed to be built and maintained by **AI agents**, not hand-edited.
The human role is to set intent, review specs/diffs, and handle the few things an
agent can't (secrets, Google OAuth consent, DNS). It uses a **spec-first loop**
adapted from [ai-blueprint](https://github.com/bradtraversy/ai-blueprint):
`plan → spec → implement (small diffs) → verify → complete → archive`.

- **Rules for agents:** [AGENTS.md](AGENTS.md) (Claude Code also reads [CLAUDE.md](CLAUDE.md)).
- **Framework & conventions:** [blueprint/](blueprint/) — `project-plan.md`,
  `build-plan.md`, and `context/` (coding standards, agent behavior).
- **Add a workflow:** run the `/new-workflow` skill, or follow
  [blueprint/context/coding-standards.md](blueprint/context/coding-standards.md).

## Design decisions worth knowing

- **One-way deploy.** `deploy.ts` only ever *writes* to n8n. Editing a workflow in
  the n8n UI is not the source of truth and will be overwritten on the next
  deploy. Use `backup.ts` if you want a snapshot of live state before deploying.
- **`lib/` is the single source for shared logic.** n8n Code nodes cannot
  `require()` repo files, so `deploy.ts` inlines `lib/calendar-upsert.js` into the
  Code node at deploy time, and CI fails if the committed `workflow.json` has
  drifted from `lib/`. The logic stays unit-testable in plain Node.
- **Upsert by name, not by database id.** The n8n Public API assigns its own ids,
  so `deploy.ts` matches on the stable workflow `name` — repeated deploys never
  create duplicates.
- **Pinned image tag.** `N8N_IMAGE_TAG` is pinned in `.env` for reproducibility;
  bump it deliberately and re-deploy.
- **No bundled proxy.** TLS/routing is delegated to your existing
  `nginx-auto-ssl` reverse proxy; n8n just joins its `PROXY_NETWORK`.

## Security notes

- The real `.env`, `*.sqlite`, and `backups/` are gitignored. **Never commit secrets.**
- n8n is not exposed publicly; only your reverse proxy reaches it (shared Docker
  network), plus a `127.0.0.1` loopback port for the on-host deploy script.
- `N8N_ENCRYPTION_KEY` encrypts stored credentials at rest — set it once and keep
  it safe; losing or changing it makes existing credentials unreadable.
- `validate.yml` needs no secrets. `deploy.yml` uses only an SSH deploy key
  (`VPS_SSH_KEY`) to reach the VPS — all n8n/Google secrets stay in the VPS `.env`,
  never in GitHub. See [docs/ci-cd.md](docs/ci-cd.md).

## License

[MIT](LICENSE) © 2026 Nikita Petrich. Provided **"as is", without warranty or
liability** — a small personal project, shared so others can see and reuse it.
