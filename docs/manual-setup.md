# Manual setup guide

> **Using CI/CD + your existing reverse proxy?** Follow **[ci-cd.md](ci-cd.md)** —
> it supersedes the `docker compose up` / `.env` / TLS steps below. This repo
> ships **no** proxy: your `nginx-auto-ssl` handles TLS and routing, so n8n needs
> no 80/443 of its own. Where this guide says "Caddy", read "your reverse proxy".

Everything you must do by hand to get `automation-hub` running and the
`birthday-sync` workflow live. Steps that **cannot** be automated (browser OAuth
consent, DNS, API-key generation) are marked 🔴.

Throughout, replace `<your-domain>` with the hostname you'll use (e.g.
`n8n.example.com`) and `<server-ip>` with your server's public IPv4 address.

---

## 0. What you need up front

- A Linux server (VPS or similar) with a **public IPv4 address** and root/SSH.
- A **domain** you control, so you can add a subdomain record.
- A **Google account** whose Contacts hold the birthdays.
- This repository checked out on the server (or on a machine that can reach the
  server's public URL for the deploy step).

🔴 **You must hand me** (if you want me to continue the automated parts):
your exact `<your-domain>`, and later the **n8n API key** and optionally the
**Google OAuth2 credential ID**. I cannot click through Google's browser consent,
create DNS records, or generate the n8n API key for you.

---

## 1. Server prerequisites

Install Docker Engine + the Compose plugin (Debian/Ubuntu shown):

```bash
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

Open the firewall for HTTP/HTTPS (needed for Let's Encrypt + access). Example
with `ufw`:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp   # HTTP/3 (optional)
sudo ufw reload
```

> If your server is behind a cloud provider firewall/security group (AWS, Hetzner
> Cloud, GCP, …), open **80 and 443** there as well — the OS firewall alone is not
> enough.

---

## 2. Domain / DNS 🔴

In your DNS provider, create an **A record** for the subdomain pointing at your
server:

| Type | Name (host) | Value | TTL |
|------|-------------|-------|-----|
| A | `n8n` (→ `n8n.example.com`) | `<server-ip>` | 300 (or default) |

Wait for it to propagate, then verify from your laptop:

```bash
dig +short <your-domain>      # must print <server-ip>
```

Do **not** start the stack until this resolves — Caddy needs it to obtain the
certificate.

---

## 3. Google Cloud: APIs, consent screen, OAuth client 🔴

All in the [Google Cloud Console](https://console.cloud.google.com/).

### 3a. Create a project
- Top bar → project dropdown → **New Project** → name it e.g. `automation-hub` → **Create**.

### 3b. Enable the two APIs
For each, open the link, make sure your new project is selected, click **Enable**:
- **People API** → https://console.cloud.google.com/apis/library/people.googleapis.com
- **Google Calendar API** → https://console.cloud.google.com/apis/library/calendar-json.googleapis.com

### 3c. Configure the OAuth consent screen
**APIs & Services → OAuth consent screen** (https://console.cloud.google.com/apis/credentials/consent):
1. User type: **External** → **Create**.
2. App name: `automation-hub`; user support email: your email; developer contact:
   your email → **Save and continue**.
3. **Scopes** → **Add or remove scopes** → add these two, then **Update**:
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
4. **Test users** → **Add users** → add your own Google address → **Save and continue**.
5. **Publishing status** (important for a daily, unattended sync):
   - In **Testing** mode, Google **expires the refresh token after 7 days**, so
     the sync would break weekly and need re-authorization.
   - Recommended: **Publish app** (→ "In production"). As the sole user you can
     click through the "Google hasn't verified this app" warning, and the refresh
     token no longer expires on a 7-day clock. Full verification is only required
     for wide public distribution.

### 3d. Create the OAuth client ID
**APIs & Services → Credentials** → **Create Credentials → OAuth client ID**:
1. Application type: **Web application**.
2. Name: `n8n`.
3. **Authorized redirect URIs → Add URI**:
   ```
   https://<your-domain>/rest/oauth2-credential/callback
   ```
   (This is n8n's standard OAuth2 callback path.)
4. **Create**. Copy the **Client ID** and **Client secret** — you'll paste them
   into n8n in step 7.

**Required scopes (for reference):**
`contacts.readonly` (read Contacts) and `calendar.events` (create/update events).

---

## 4. Create the target calendar & get its ID 🔴

This repo ships a default `CALENDAR_ID` in `.env.example`. To use a **fresh,
dedicated** calendar instead (recommended so birthdays are separable/toggleable):

1. [Google Calendar](https://calendar.google.com/) → left sidebar → **Other
   calendars** → **+** → **Create new calendar**.
2. Name it **`Contact Birthdays`** → **Create calendar**.
3. **Settings for my calendars → Contact Birthdays → Integrate calendar** →
   copy the **Calendar ID** (looks like `...@group.calendar.google.com`).
4. Use that value for `CALENDAR_ID` in `.env` (step 5).

---

## 5. Fill in `.env`

```bash
cp .env.example .env
```

| Variable | Value |
|----------|-------|
| `DOMAIN` | `<your-domain>` |
| `N8N_IMAGE_TAG` | leave pinned (e.g. `2.31.4`) unless upgrading |
| `N8N_ENCRYPTION_KEY` | **generate once:** `openssl rand -hex 32` → paste the output |
| `CALENDAR_ID` | the calendar ID from step 4 |
| `BIRTHDAY_SYNC_SCHEDULE` | leave `0 6 * * *` (daily 06:00) or adjust |
| `SHOW_BIRTH_YEAR` | `true` for `(turning N)` titles, else `false` |
| `N8N_API_KEY` | **leave blank for now** — created in step 8 |
| `N8N_API_URL` | `https://<your-domain>` |
| `GOOGLE_OAUTH_CRED_ID` | **leave blank for now** — optional, filled in step 7 |

> ⚠️ Set `N8N_ENCRYPTION_KEY` **before first start** and never change it
> afterwards — changing it makes stored credentials unreadable.

---

## 6. Start the stack, verify TLS, create the owner

```bash
docker compose up -d
docker compose ps
docker compose logs -f caddy      # watch for a successfully obtained certificate
```

Caddy fetches the Let's Encrypt certificate on the first HTTPS request. A healthy
log shows `certificate obtained successfully` for `<your-domain>` and no ACME
errors. If it fails, re-check DNS (step 2) and that 80/443 are open (step 1).

Then open **`https://<your-domain>`** in the browser. n8n shows a first-run
screen — **create the owner account** (email + password). This is your admin
login.

---

## 7. Create & authorize the Google OAuth2 credential in n8n 🔴

1. In n8n: **top-right menu → Credentials → Add credential** (or
   `https://<your-domain>/home/credentials`).
2. Search for and choose **"OAuth2 API"** (the generic one). Name it exactly
   **`Google OAuth2 (automation-hub)`** (matches what `workflow.json` expects).
3. Fill in:
   | Field | Value |
   |-------|-------|
   | Grant Type | `Authorization Code` |
   | Authorization URL | `https://accounts.google.com/o/oauth2/v2/auth` |
   | Access Token URL | `https://oauth2.googleapis.com/token` |
   | Client ID | *(from step 3d)* |
   | Client Secret | *(from step 3d)* |
   | Scope | `https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/calendar.events` |
   | Auth URI Query Parameters | `access_type=offline&prompt=consent` |
   | Authentication | leave default; if the token step later errors, switch to **Body** |
4. Confirm the **OAuth Redirect URL** shown by n8n is
   `https://<your-domain>/rest/oauth2-credential/callback` — it must match the URI
   you registered in step 3d.
5. Click **Connect my account / Sign in with Google** → complete the browser
   consent (choose your account; click through the "unverified app" warning if
   shown; approve both permissions). The credential should turn green
   ("Connected").
6. **Note the credential ID** — open the saved credential and copy the id from the
   URL: `https://<your-domain>/home/credentials/<THIS-ID>`. Put it in `.env` as
   `GOOGLE_OAUTH_CRED_ID=<THIS-ID>` so `deploy` can wire it into every node
   automatically. *(Optional — otherwise you'll select the credential by hand on
   each HTTP node after deploying.)*

---

## 8. Generate an n8n API key 🔴

In n8n: **Settings → n8n API → Create an API key**
(`https://<your-domain>/settings/api`). Copy the key and put it in `.env`:

```
N8N_API_KEY=<the key you just created>
```

---

## 9. Deploy the workflow from the repo

From the repo (on the server, or any machine that can reach
`https://<your-domain>`):

```bash
npm install       # first time only
npm run deploy
```

Expected output: `created "Birthday Sync (Contacts → Calendar)"` and, if
`GOOGLE_OAUTH_CRED_ID` was set, `activated`. If you left the credential ID blank,
deploy leaves the workflow **inactive** and prints a note — open the workflow,
select the Google credential on each HTTP Request node, save, then either
re-run `npm run deploy` (with `GOOGLE_OAUTH_CRED_ID` set) or toggle **Active** in
the UI.

---

## 10. Run a manual full sync & verify

1. Open the **Birthday Sync (Contacts → Calendar)** workflow in n8n.
2. Click **Execute Workflow**.
3. Each node should light up green. `Create Event` shows one item per new
   birthday.
4. Open [Google Calendar](https://calendar.google.com/) → the **Contact
   Birthdays** calendar now contains `🎂 Name (turning N)` all-day events that
   repeat yearly.
5. Click **Execute Workflow** again — this time `Plan Operations` outputs **0**
   items (everything skipped). That confirms idempotency: no duplicates.

---

## 11. Enable notifications for all-day events 🔴

Reminders for all-day events are a **per-calendar** setting — the workflow can't
set your phone's reminder for you:

- **Google Calendar (web):** Settings → **Contact Birthdays** → **Event
  notifications** / **All-day event notifications** → add e.g. *Notification, 1
  day before, at 09:00* (or your preference).
- **Phone:** make sure the **Contact Birthdays** calendar is enabled/synced in the
  Google Calendar app so the notification reaches you.

---

## 12. Confirm the schedule is active

- In the workflow list, the **Active** toggle for *Birthday Sync* is **on**.
- **Executions** (`https://<your-domain>/home/executions`) will show a run each
  day at your `BIRTHDAY_SYNC_SCHEDULE` time (default 06:00 Europe/Berlin).

Done. New contacts and edited birthdays are picked up automatically every day,
and you can always trigger a full sync manually (step 10).

---

## What can't be automated (must be you)

- 🔴 **DNS** A record and propagation (step 2).
- 🔴 **Google Cloud** project, API enablement, consent screen, OAuth client
  (step 3) — and the **browser OAuth consent** in n8n (step 7).
- 🔴 **n8n owner account** creation (step 6) and **API-key generation** (step 8).

## What to hand me so I can continue

- Your exact **`<your-domain>`** (to personalize the guide and configs).
- After step 8, the **`N8N_API_KEY`** and (optionally) **`GOOGLE_OAUTH_CRED_ID`**,
  if you want me to run/verify the deploy for you.
- Do **not** share your `N8N_ENCRYPTION_KEY`, OAuth **client secret**, or the
  contents of `.env` in plain text unless you intend to.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Caddy can't get a certificate | DNS not pointing at the server yet, or 80/443 blocked (OS **and** cloud firewall). |
| n8n OAuth error `redirect_uri_mismatch` | The redirect URI in Google (step 3d) must exactly equal `https://<your-domain>/rest/oauth2-credential/callback`. |
| Token exchange fails in n8n | In the credential, set **Authentication = Body** and reconnect. |
| Sync stops working after ~7 days | Consent screen still in **Testing** — publish the app (step 3c.5) and reconnect the credential. |
| `deploy` says *Public API unreachable* | Check `N8N_API_URL`/`N8N_API_KEY` in `.env`; the key is created under Settings → n8n API. |
| Events created but no phone reminder | All-day notifications are per-calendar — configure them (step 11). |
| Duplicate events | Shouldn't happen (dedup by `contactId`). If you imported the workflow twice under different names, delete the extra and its events, then re-deploy. |
