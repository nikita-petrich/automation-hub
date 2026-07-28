# Setup guide — from zero to a running, auto-deploying instance

This is the complete, end-to-end guide: how the system works and exactly how to
set it up from scratch. Nothing here is out of date — it describes the final
architecture (no Caddy, config in GitHub, deploy over SSH).

> Legend: 🔴 = a one-time manual step that **cannot** be automated (DNS, Google
> browser consent, API-key creation). Everything else is automated by CI/CD.

Throughout, replace `<your-domain>` with your n8n hostname (e.g.
`n8n.example.com`) and `<vps-ip>` with your server's public IPv4 address.

---

## 1. How it works (architecture)

```
                          ┌──────────────────────── your VPS ────────────────────────┐
 Internet ──443──►  your reverse proxy  ──(shared docker net "edge")──►  n8n container │
   (TLS via         (nginx-auto-ssl,                                     (SQLite,      │
    Let's Encrypt)   routes by SITES)                                    127.0.0.1:5678)│
                          └───────────────────────────────────────────────────────────┘
                                                                              ▲
                                                                              │ SSH tunnel
   git push main ─► GitHub Actions ─► validate ─► tar repo → VPS ─► docker compose up ─┤
                    (production env      (safety)   (over SSH)      (starts n8n)        │
                     secrets → .env)                                npm run deploy ─────┘
                                                                    (imports workflows via
                                                                     the SSH tunnel)
```

**Principles**

- **The repo is the single source of truth.** Deployment is **one-way**: repo → n8n.
  Editing a workflow in the n8n UI is not the source of truth and is overwritten on
  the next deploy. (`npm run backup` exports live state if you ever need a snapshot.)
- **The VPS needs only Docker.** No Node, no rsync, no Caddy. n8n runs on SQLite,
  is published on `127.0.0.1:5678` (loopback only), and joins your existing reverse
  proxy's Docker network so the proxy can route to it. TLS is the proxy's job.
- **All configuration lives in a GitHub `production` Environment** (as secrets).
  The pipeline renders the VPS `.env` from those secrets on every deploy — you never
  hand-edit `.env` on the server.
- **Deploys are idempotent.** Workflows upsert by name; `docker compose up -d` is a
  no-op when nothing changed. The birthday sync itself is idempotent too (dedup by
  the People API `resourceName`), so it never creates duplicate calendar events.

**What runs when**

- **On `git push` to `main`** → GitHub Actions deploys infra + workflows to the VPS.
- **Daily at 06:00 Europe/Berlin** → n8n's Schedule Trigger runs the birthday sync
  (independent of GitHub; it's inside n8n). You can also run it on demand in n8n via
  **Execute Workflow**.

---

## 2. Prerequisites

- A Linux VPS with a **public IPv4** and SSH access, with **Docker + Compose**
  installed (nothing else). `curl -fsSL https://get.docker.com | sh`
- A **reverse proxy** already running on that VPS that terminates TLS and routes by
  hostname. This guide assumes [`valian/docker-nginx-auto-ssl`](https://github.com/Valian/docker-nginx-auto-ssl)
  (automatic Let's Encrypt), on an **external** Docker network (e.g. `edge`).
- A **domain** you control.
- A **Google account** whose Contacts hold the birthdays.
- This repository on GitHub, with **Actions** enabled.

---

## 3. Infrastructure (VPS, DNS, proxy)

### 3a. DNS 🔴
Create an **A record**: `<your-domain>` → `<vps-ip>`. Verify: `dig +short <your-domain>`.

### 3b. Reverse proxy → n8n 🔴
In your reverse-proxy stack, route the hostname to the n8n container (`n8n:5678`)
and allow it for certificate issuance, then restart that stack:

```yaml
    environment:
      # ALLOWED_DOMAINS is a PCRE regex (nginx-auto-ssl uses ngx.re.match).
      # A literal dot is "." (any char) or "\." — do NOT use Lua's "%." here.
      ALLOWED_DOMAINS: "<your-domain>"
      SITES: "<your-domain>=n8n:5678"
```

Notes:
- The n8n container is named **`n8n`** and listens on `5678` on the shared network.
- The shared network must exist; both stacks reference it as `external`. If needed:
  `docker network create edge`, and set `PROXY_NETWORK` (secret, step 5) to its name.

### 3c. Docker group (for the deploy user)
The SSH user the pipeline logs in as must run Docker without sudo:
```bash
sudo usermod -aG docker "$USER"    # then log out and back in once
```

---

## 4. Google Cloud + OAuth 🔴

All in the [Google Cloud Console](https://console.cloud.google.com/). See
[§9 for verification & cost](#9-google-cloud-verification--costs-the-risks-question)
— short version: **free, no verification needed for personal use.**

1. **Create a project** → [projectcreate](https://console.cloud.google.com/projectcreate) (e.g. `automation-hub`).
2. **Enable both APIs** (select the project first, click *Enable*):
   [People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
   and [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. **OAuth consent screen** → [auth/overview](https://console.cloud.google.com/auth/overview):
   User type **External**, app name + your email.
4. **Scopes** → [Data Access](https://console.cloud.google.com/auth/scopes) → add:
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
5. **Publish the app** → [Audience](https://console.cloud.google.com/auth/audience) →
   **Publish app**. ⚠️ Important: in **Testing** mode Google **expires the refresh
   token after 7 days**, which would break the sync weekly. Publishing (to
   *In production*) keeps it working; you click through a one-time "unverified app"
   warning as the owner (details in §9).
6. **OAuth client** → [Clients](https://console.cloud.google.com/auth/clients) →
   **Create client** → type **Web application** → name `n8n` →
   **Authorized redirect URI**: `https://<your-domain>/rest/oauth2-credential/callback`
   → **Create** → copy the **Client ID** and **Client secret**.

---

## 5. GitHub `production` Environment (all config as secrets)

### 5a. SSH deploy key 🔴 (on your laptop)
```bash
ssh-keygen -t ed25519 -C "automation-hub-deploy" -f ~/.ssh/automation-hub-deploy -N ""
ssh-copy-id -i ~/.ssh/automation-hub-deploy.pub <vps-user>@<vps-ip>
```
This lets GitHub Actions log in to the VPS non-interactively. Use a dedicated key
(easy to revoke by removing its line from the VPS `~/.ssh/authorized_keys`).

### 5b. Create the environment 🔴
Repo → **Settings → Environments → New environment** → `production`. Add everything
as **secrets** (Add environment secret):

| Secret | Value |
|--------|-------|
| `VPS_SSH_KEY` | the **private** key `~/.ssh/automation-hub-deploy` (full text) |
| `VPS_HOST` | `<vps-ip>` |
| `VPS_USER` | your SSH user |
| `N8N_ENCRYPTION_KEY` | `openssl rand -hex 32` — generate once, **keep forever** |
| `DOMAIN` | `<your-domain>` |
| `PROXY_NETWORK` | your reverse proxy's Docker network name (e.g. `edge`) |
| `CALENDAR_ID` | the target Google calendar id (see the workflow README) |
| `N8N_API_KEY` | *added in step 7* |
| `GOOGLE_OAUTH_CRED_ID` | *added in step 7* |
| `BIRTHDAY_SYNC_SCHEDULE` | optional (default `0 6 * * *`) |
| `SHOW_BIRTH_YEAR` | optional (default `true`) |
| `N8N_IMAGE_TAG` | optional (default pinned in compose) |
| `VPS_PORT` / `VPS_APP_DIR` | optional (defaults `22` / `automation-hub`) |

> ⚠️ Never change `N8N_ENCRYPTION_KEY` after credentials exist — it makes stored
> credentials unreadable.

---

## 6. First deploy (brings n8n up)

Promote the current branch to `main` (the production branch) and push:
```bash
git branch -M main && git push -u origin main
```
GitHub → **Settings → Branches** → default branch `main`.

The pipeline runs. On this first run **n8n comes up**, but the workflow import is
**skipped** (no API key yet) — that is expected. Watch it under the **Actions** tab.

---

## 7. n8n one-time setup 🔴, then finish

Open **`https://<your-domain>`** (your proxy now serves it):

1. **Create the n8n owner account** (email + password).
2. **Create the Google OAuth2 credential:** **Credentials → Add credential** → pick
   the **generic** entry named exactly **`OAuth2 API`** (NOT "Google OAuth2 API" or
   any "… OAuth2 API" — only the plain one lets you set custom URLs + scope). Fill:

   | Field | Value |
   |-------|-------|
   | Grant Type | `Authorization Code` |
   | Authorization URL | `https://accounts.google.com/o/oauth2/v2/auth` |
   | Access Token URL | `https://oauth2.googleapis.com/token` |
   | Client ID / Secret | *(from step 4.6)* |
   | Scope | `https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/calendar.events` |
   | Auth URI Query Parameters | `access_type=offline&prompt=consent` |

   → **Save** → **Connect my account** → complete the Google consent (click through
   the "unverified app" warning) → it turns green. Open the saved credential and copy
   its **id from the URL**: `…/home/credentials/`**`THIS-ID`**.
3. **Create an n8n API key:** **Settings → n8n API → Create an API key** → copy it.
4. **Add the two remaining secrets** to the `production` environment:
   `N8N_API_KEY` and `GOOGLE_OAUTH_CRED_ID` (the id from step 7.2).
5. **Re-run the deploy:** Actions → *deploy* → **Run workflow** (or push to `main`).
   This imports the workflow, wires the credential into every node, and activates it.

---

## 8. Verify & finish

1. In n8n open **Birthday Sync (Contacts → Calendar)** → **Execute Workflow**.
2. Check the target calendar → `🎂 Name (turning N)` yearly all-day events appear.
3. Run it again → **0** new items = idempotency proven (no duplicates).
4. 🔴 In Google Calendar → the target calendar → **Settings → all-day event
   notifications** → add e.g. *1 day before, 09:00* (otherwise no phone reminder).

From now on: `git push` to `main` deploys everything; the daily 06:00 schedule keeps
the calendar in sync automatically.

---

## 9. Google Cloud: verification & costs (the "risks" question)

**Verification / app review — not required for personal use.**
- `contacts.readonly` and `calendar.events` are **sensitive** scopes (not
  *restricted*). Restricted scopes (e.g. full Gmail/Drive) would need a paid annual
  third-party **security assessment** — these do **not**.
- Apps using sensitive scopes only need Google's OAuth verification once they exceed
  **100 users**. A personal instance (just you) stays well under that, so **no
  verification is required** — you simply click through the one-time
  "unverified app" warning during consent. (You *may* verify later only if you want
  to remove that warning or add many users.)

**Costs — none at this scale.**
- Creating a Google Cloud **project is free**; the People API and Calendar API are
  **free within generous daily quotas**, and a **billing account / credit card is not
  required** for free-quota usage. This workflow makes a few dozen calls per day —
  orders of magnitude below any limit.
- Google has announced that **exceeding** the free quota may incur charges *later in
  2026*, with ≥90 days notice — irrelevant at this volume, and it only affects usage
  above the free tier.

**The one caveat we already handled:** OAuth apps in **Testing** publishing status
expire the refresh token after 7 days. That is why step 4.5 **publishes** the app —
then the token persists (it can still be revoked by inactivity of ~6 months, a
password reset, or manual revocation, none of which apply to a daily job).

Sources: Google — [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification),
[OAuth app verification help](https://support.google.com/cloud/answer/13463073),
[Calendar API usage limits](https://developers.google.com/workspace/calendar/api/guides/quota).

**Other services:** Let's Encrypt is free; n8n Community Edition (self-hosted) is
free; GitHub Actions minutes are effectively free at this volume (the daily sync runs
inside n8n, not in Actions — only deploys use Actions minutes, ~1–2 min each).

---

## 10. Day-2 operations

- **Add another workflow:** create `workflows/<name>/workflow.json` with a stable
  `name` + `active: true`, add a short README, `npm run validate` locally, commit,
  merge to `main` → it deploys automatically. Shared logic goes in `lib/` between
  `// LIB:START` / `// LIB:END` markers (see `birthday-sync`).
- **Change config:** edit the secret in the `production` environment, then re-run the
  deploy (the `.env` is re-rendered).
- **Rollback:** `git revert <bad-commit> && git push origin main` — CD redeploys the
  previous state.
- **Backup:** `npm run backup` exports live workflows to `backups/` (disaster-recovery
  snapshot; gitignored). The repo remains the source of truth.

---

## 11. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Browser shows **"Dangerous" / untrusted cert** | Your reverse proxy served a self-signed fallback because `ALLOWED_DOMAINS` didn't match. It's a **PCRE regex** — use `"<your-domain>"` (or `"\.example\.com$"`), not Lua's `%.`. Restart the proxy, reload the page. |
| n8n OAuth `redirect_uri_mismatch` | The Google redirect URI must be exactly `https://<your-domain>/rest/oauth2-credential/callback`. |
| Sync stops after ~7 days | Consent screen still in **Testing** — publish the app (step 4.5) and reconnect. |
| Deploy is red at "Start stack" | The SSH user isn't in the `docker` group, or the `edge` network doesn't exist. |
| Deploy red at "Deploy workflows" | `N8N_API_KEY` missing/invalid, or n8n not healthy. Check the two secrets. |
| Only "OAuth2 API" variants shown in n8n | Pick the **plain** `OAuth2 API` (generic), not `Google OAuth2 API`. |
