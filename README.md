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

---

## Architecture

| Component | Choice | Why |
|-----------|--------|-----|
| Automation engine | **n8n** (Docker, pinned tag) | Visual workflows + code where needed. |
| Database | **SQLite** (n8n default) | Zero-ops; fine for a single-instance hub. Persisted in a Docker volume. |
| Reverse proxy / TLS | **Caddy** | Automatic Let's Encrypt certificates, HTTP/3, tiny config. |
| Network exposure | Only **80/443** via Caddy | n8n's port `5678` is **never** published; it stays on the internal Docker network. |
| Config | **`.env`** (gitignored) | No secrets in the repo. |
| Deploy | **n8n Public REST API** (`scripts/deploy.ts`) | Idempotent upsert by workflow name; CLI fallback. |

```
Internet ──443──► Caddy ──(internal docker network)──► n8n:5678 ──► SQLite volume
                  (TLS)                                   ▲
                                                          │ X-N8N-API-KEY
                                             scripts/deploy.ts (repo → n8n)
```

## Repository layout

```
automation-hub/
├── docker-compose.yml         # n8n (SQLite) + Caddy (TLS), n8n not exposed
├── Caddyfile                  # {$DOMAIN} { reverse_proxy n8n:5678 }
├── .env.example               # every variable, documented (copy to .env)
├── package.json               # deploy / backup / validate / sync / test scripts
├── scripts/
│   ├── deploy.ts              # upsert ALL workflows via the n8n REST API
│   ├── backup.ts              # export live n8n → backups/ (safety net)
│   └── validate.ts            # CI validation + `--fix` lib→workflow sync
├── workflows/
│   └── birthday-sync/         # one folder per workflow
│       ├── workflow.json      # the n8n workflow (stable id + name)
│       └── README.md
├── lib/
│   ├── calendar-upsert.js     # shared, unit-tested upsert logic (single source)
│   └── calendar-upsert.test.js
├── docs/
│   └── manual-setup.md        # full one-time setup guide (server, DNS, Google, n8n)
└── .github/workflows/
    └── validate.yml           # JSON/schema/sync validation only — NO deploy
```

## Quick start

> Full, click-by-click instructions (server, DNS, Google Cloud, OAuth, API key)
> live in **[docs/manual-setup.md](docs/manual-setup.md)**. Short version:

```bash
# 1. Configure
cp .env.example .env
nano .env                       # set DOMAIN, N8N_ENCRYPTION_KEY, CALENDAR_ID ...
#   generate the encryption key with:  openssl rand -hex 32

# 2. Start the stack (on your server, ports 80/443 open, DNS pointing at it)
docker compose up -d
docker compose logs -f caddy    # watch it obtain the Let's Encrypt certificate

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
4. `npm run validate` locally, commit, open a PR (CI validates), then `npm run deploy`.

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
- **Pinned image tags.** `N8N_IMAGE_TAG` / `CADDY_IMAGE_TAG` are pinned in `.env`
  for reproducibility; bump them deliberately and re-deploy.

## Security notes

- The real `.env`, `*.sqlite`, and `backups/` are gitignored. **Never commit secrets.**
- n8n is not reachable except through Caddy over HTTPS.
- `N8N_ENCRYPTION_KEY` encrypts stored credentials at rest — set it once and keep
  it safe; losing or changing it makes existing credentials unreadable.
- CI needs no secrets: it only validates JSON and runs unit tests.

## License

Private project. Not licensed for redistribution.
