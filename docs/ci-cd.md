# CI/CD — automatic deployment to the VPS

Every push to **`main`** deploys the whole stack to your VPS automatically:

```
push to main ─► GitHub Actions ─► validate
                                 ─► rsync repo to the VPS (over SSH)
                                 ─► render .env on the VPS from the `production`
                                    GitHub Environment (all secrets)
                                 ─► docker compose up -d      (starts n8n)
                                    npm run deploy             (workflows → n8n)
```

- All config lives in the GitHub **`production` Environment** — you never edit
  `.env` on the server by hand; the pipeline renders it on every deploy.
- TLS/routing is handled by your **existing `nginx-auto-ssl` reverse proxy**; n8n
  joins its shared Docker network. This repo ships no proxy.
- Deploys are idempotent (workflow upsert by name; `docker compose up -d` is a
  no-op when nothing changed).

## One-time setup

### 1. VPS prerequisites
- Docker + Compose and Node.js (≥20) installed.
- Your reverse-proxy stack already running, and its shared network name known
  (its compose defaults to `example-net`).
- The SSH deploy user in the `docker` group: `sudo usermod -aG docker "$USER"`
  (then log out/in once).
- DNS: an A record for your n8n hostname → the VPS IP.

### 2. Point your reverse proxy at n8n
In your **reverse-proxy** repo's `compose.yml`, add n8n to `SITES` and
`ALLOWED_DOMAINS` (semicolon-separated), then restart that stack:
```yaml
    environment:
      ALLOWED_DOMAINS: "yourexisting.de;n8n.yourdomain.de"
      SITES: "yourexisting.de=web:3000;n8n.yourdomain.de=automation-hub-n8n:5678"
```
n8n's container is `automation-hub-n8n` on port `5678`, on the same network.

### 3. Create a dedicated SSH deploy key (on your laptop)
```bash
ssh-keygen -t ed25519 -C "automation-hub-deploy" -f ~/.ssh/automation-hub-deploy -N ""
ssh-copy-id -i ~/.ssh/automation-hub-deploy.pub <vps-user>@<vps-host>
```

### 4. Create the GitHub `production` Environment
Repo → **Settings → Environments → New environment** → `production`. Add
everything as **Secrets** (Add environment secret):

| Secret | Value |
|--------|-------|
| `VPS_SSH_KEY` | the **private** key `~/.ssh/automation-hub-deploy` |
| `VPS_HOST` | server IP / hostname |
| `VPS_USER` | SSH user |
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 32` (generate once, keep forever) |
| `DOMAIN` | your n8n hostname, e.g. `n8n.yourdomain.de` |
| `PROXY_NETWORK` | your reverse proxy's Docker network name (e.g. `example-net`) |
| `CALENDAR_ID` | target Google calendar id |
| `N8N_API_KEY` | *(added after step 6)* |
| `GOOGLE_OAUTH_CRED_ID` | *(added after step 6)* |
| `BIRTHDAY_SYNC_SCHEDULE` | optional (default `0 6 * * *`) |
| `SHOW_BIRTH_YEAR` | optional (default `true`) |
| `N8N_IMAGE_TAG` | optional (default `2.31.4`) |
| `VPS_PORT` / `VPS_APP_DIR` | optional (defaults `22` / `automation-hub`) |

### 5. Promote `main` and first deploy
```bash
git branch -M main && git push -u origin main   # from a clone of the repo
```
(GitHub → Settings → Branches → default branch = `main`.) The pipeline runs: it
brings n8n up. Until `N8N_API_KEY` is set the workflow deploy is **skipped**
(with a message) — that's expected.

### 6. One-time browser steps, then finish
Open `https://<DOMAIN>` (your proxy now serves it): create the **n8n owner**,
create + authorize the **Google OAuth2 credential**, and generate an **n8n API
key** (Settings → n8n API). Then:
- add secret **`N8N_API_KEY`** and variable **`GOOGLE_OAUTH_CRED_ID`** to the
  `production` environment,
- re-run the deploy (Actions → *deploy* → **Run workflow**, or push to `main`).

Done — the workflow deploys and activates, and every future push to `main`
redeploys automatically.

## Security notes
- The SSH key grants the runner shell access to the VPS user (which drives
  Docker). Use a dedicated key + non-root user. Alternative: a **self-hosted
  runner** on the VPS instead of inbound SSH.
- `N8N_ENCRYPTION_KEY` and `N8N_API_KEY` live in GitHub as environment secrets
  (masked in logs). Rotate them if exposed.
- `ssh-keyscan` trusts the host key on first contact; for stricter security pin
  it via a `VPS_KNOWN_HOSTS` secret.

## Rollback
The repo is the source of truth, so rollback is a git revert:
```bash
git revert <bad-commit> && git push origin main   # CD redeploys the previous state
```
