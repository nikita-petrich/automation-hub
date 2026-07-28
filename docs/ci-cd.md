# CI/CD — how the pipeline works

This explains the internals of the deploy pipeline. For the step-by-step **setup**
(secrets, SSH key, Google, first deploy), see **[manual-setup.md](manual-setup.md)**.

Every push to **`main`** deploys the whole stack to your VPS:

```
push to main ─► GitHub Actions ─► validate  (npm run validate — JSON/schema/lib/tests)
                                 ─► copy repo to the VPS            (tar stream over SSH)
                                 ─► render .env on the VPS          (from `production` secrets)
                                 ─► docker compose up -d on the VPS (vps-deploy.sh, starts n8n)
                                 ─► import workflows into n8n       (npm run deploy on the runner,
                                                                     over an SSH tunnel to n8n)
```

Two workflow files:
- **`validate.yml`** — runs on every pull request / push. JSON + schema validation,
  `lib/` drift check, unit tests. **No secrets, never deploys.**
- **`deploy.yml`** — runs on push to `main` (and manual *Run workflow*).

## What each step of `deploy.yml` does

The `deploy` job (which `needs: validate`) runs on a GitHub-hosted runner:

1. **Configure SSH** — writes the `VPS_SSH_KEY` secret to a key file and
   `ssh-keyscan`s the host.
2. **Sync repository to the VPS** — streams the repo as a `tar` archive over SSH and
   extracts it on the VPS (`tar` is on every Linux, so the VPS needs no `rsync`).
   Excludes `.git`, `node_modules`, `.env`, `backups`, `dist`.
3. **Render `.env` on the VPS** — builds the `.env` from the `production` environment
   secrets and `scp`s it to the VPS (chmod 600). You never hand-edit `.env` there.
4. **Start stack on the VPS** — over SSH runs `scripts/vps-deploy.sh`, which does
   `docker compose pull && up -d` and waits for the n8n container to be healthy.
   *(The VPS needs only Docker — no Node, no rsync.)*
5. **Import workflows into n8n** — on the runner, opens an **SSH tunnel** to the VPS's
   loopback port (`-L 127.0.0.1:5678:127.0.0.1:5678`) and runs `npm run deploy`
   against `http://127.0.0.1:5678`. This reaches the n8n API **directly and securely
   over SSH**, so it does **not** depend on the public TLS certificate (Node would
   otherwise reject an untrusted/self-signed cert). If `N8N_API_KEY` isn't set yet,
   this step is skipped with a message (first-run bootstrap).

`scripts/deploy.ts` performs the actual **upsert by workflow name** (create if new,
replace if present), injects `lib/calendar-upsert.js` into the Code node, injects the
schedule from `BIRTHDAY_SYNC_SCHEDULE`, wires `GOOGLE_OAUTH_CRED_ID` into every HTTP
node, and activates the workflow. It's idempotent — repeated deploys never duplicate.

## Why deploy this way

- **VPS needs only Docker.** No Node, no rsync, no bundled proxy.
- **Cert-independent.** The workflow import goes over the SSH tunnel, so a
  not-yet-valid public certificate never blocks a deploy.
- **Secrets stay in GitHub.** Only an SSH deploy key reaches the VPS; the n8n/Google
  secrets live in the `production` Environment and are rendered into `.env` per deploy.

## Security notes

- The SSH key grants the runner shell access to the VPS user (which drives Docker).
  Use a **dedicated** deploy key + a non-root user; revoke by removing its line from
  the VPS `~/.ssh/authorized_keys`. Alternative: a **self-hosted runner** on the VPS.
- `N8N_ENCRYPTION_KEY`, `N8N_API_KEY`, `VPS_SSH_KEY` are GitHub environment secrets
  (masked in logs). Rotate them if exposed.
- `ssh-keyscan` trusts the host key on first contact; for stricter security, store the
  host key in a secret and write it to `~/.ssh/known_hosts` instead.
- Optional: add **required reviewers** to the `production` environment (Settings →
  Environments) to gate deploys behind an approval.

## Operations

- **Add a workflow / change config / backup:** see [manual-setup.md §10](manual-setup.md#10-day-2-operations).
- **Rollback** — the repo is the source of truth:
  ```bash
  git revert <bad-commit> && git push origin main   # CD redeploys the previous state
  ```
- **Manual deploy:** Actions → *deploy* → **Run workflow** (branch `main`).
