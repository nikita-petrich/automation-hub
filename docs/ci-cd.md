# CI/CD — automatic deployment to the VPS

Every push to **`main`** deploys the whole stack to your VPS automatically:

```
push to main ─► GitHub Actions ─► validate ─► rsync repo to VPS (over SSH)
                                              └─► docker compose up -d   (infra)
                                                  npm run deploy         (workflows → n8n)
```

- Pull requests and feature branches run **validation only** (`validate.yml`, no secrets).
- The n8n / Google secrets **never** leave the VPS — they live in the VPS-local
  `.env`. GitHub only holds the SSH access to the server.
- Deployment is idempotent (workflows upsert by name; `docker compose up -d` is a
  no-op when nothing changed).

## One-time setup

### 0. Prerequisite: the VPS is already bootstrapped
Do the one-time manual setup from [manual-setup.md](manual-setup.md) first: Docker +
Node installed, the repo cloned to `~/automation-hub`, `.env` filled in, the stack
started once, and the n8n owner account + Google OAuth2 credential + n8n API key
created (those are browser steps that cannot be automated). CD then handles every
deploy after that.

Also make sure the SSH user may use Docker without sudo:
```bash
sudo usermod -aG docker "$USER"   # then log out/in once
```

### 1. Create a dedicated SSH deploy key
On your laptop (not the server):
```bash
ssh-keygen -t ed25519 -C "automation-hub-deploy" -f ~/.ssh/automation-hub-deploy -N ""
```
Add the **public** key to the VPS user's authorized keys:
```bash
ssh-copy-id -i ~/.ssh/automation-hub-deploy.pub <vps-user>@<vps-host>
# or append the contents of automation-hub-deploy.pub to ~/.ssh/authorized_keys on the VPS
```

### 2. Add GitHub secrets & variables
Repo → **Settings → Secrets and variables → Actions**.

**Secrets** (New repository secret):
| Name | Value |
|------|-------|
| `VPS_SSH_KEY` | the **private** key: contents of `~/.ssh/automation-hub-deploy` |
| `VPS_HOST` | your server IP or hostname |
| `VPS_USER` | the SSH user on the VPS |

**Variables** (optional — Variables tab):
| Name | Default | Value |
|------|---------|-------|
| `VPS_PORT` | `22` | SSH port, if non-standard |
| `VPS_APP_DIR` | `automation-hub` | repo path on the VPS, relative to the user's home |

### 3. Establish the `main` branch
CD deploys from `main`. Promote the current branch to `main` and make it the
default branch:
```bash
# from a clone of the repo:
git checkout claude/automation-hub-n8n-setup-sg12v4
git branch -M main            # or: git checkout -b main
git push -u origin main
```
Then GitHub → **Settings → Branches** → set **`main`** as the default branch. On
the **VPS**, make sure the checkout tracks `main` (the pipeline overwrites files
via rsync, so the branch there only matters for manual use).

## How a deploy runs

1. You push to `main` (or click **Run workflow** on the *deploy* action for a
   manual run).
2. The **validate** job installs deps and runs `npm run validate`.
3. The **deploy** job opens SSH to the VPS, `rsync`s the repo there (excluding
   `.env`, `node_modules`, `backups`, `.git`, `dist`), then runs
   `scripts/vps-deploy.sh`, which does `docker compose pull && up -d`, waits for
   n8n to be healthy, and runs `npm run deploy`.

Watch progress under the repo's **Actions** tab.

## Security notes

- The SSH key grants the runner shell access to the VPS user (which can drive
  Docker). Use a **dedicated** deploy key and a non-root user. For extra
  hardening, restrict the key in `authorized_keys` with a forced command, or run
  a **self-hosted GitHub runner** on the VPS instead of exposing SSH (then the
  `deploy` job's `runs-on` points at your runner and the rsync/SSH steps become
  local commands).
- `ssh-keyscan` trusts the host key on first contact. For stricter security,
  pin the VPS host key by storing it in a `VPS_KNOWN_HOSTS` secret and writing it
  to `~/.ssh/known_hosts` instead of running `ssh-keyscan`.
- Rotate `VPS_SSH_KEY` if it is ever exposed; remove the corresponding line from
  the VPS `authorized_keys`.

## Rollback

Because the repo is the source of truth, rolling back is a git revert:
```bash
git revert <bad-commit>   # or reset main to a known-good commit
git push origin main      # CD redeploys the previous state
```
