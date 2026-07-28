#!/usr/bin/env bash
# =============================================================================
# On-VPS deployment — runs ON the server, invoked over SSH by the CD pipeline
# (.github/workflows/deploy.yml). Also safe to run by hand on the VPS.
#
# The CI job copies the repo (tar over SSH) and renders .env (from the GitHub `production`
# environment) before calling this. Real secrets never live in GitHub logs.
#
# Requirements on the VPS: Docker + Compose, Node.js (>=20), the SSH user in the
# `docker` group, and your reverse proxy already running (its shared network is
# referenced by PROXY_NETWORK in .env).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
echo "==> Working dir: $(pwd)"

if [ ! -f .env ]; then
  echo "ERROR: .env is missing. In CI/CD it is rendered from the 'production'" >&2
  echo "       GitHub environment; set DOMAIN + N8N_ENCRYPTION_KEY there (docs/ci-cd.md)." >&2
  exit 1
fi

echo "==> Pull images and (re)start the stack"
docker compose pull
docker compose up -d --remove-orphans

echo "==> Wait for n8n to become healthy"
for i in $(seq 1 40); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' n8n 2>/dev/null || echo missing)"
  if [ "$status" = "healthy" ]; then
    echo "    n8n is healthy"
    break
  fi
  if [ "$i" -eq 40 ]; then
    echo "    WARNING: n8n not healthy after waiting; continuing" >&2
  fi
  sleep 3
done

# Deploy workflows only once the n8n API key exists (created once in the n8n UI).
api_key="$(grep -E '^N8N_API_KEY=' .env | head -1 | cut -d= -f2- || true)"
if [ -z "${api_key}" ]; then
  echo "==> N8N_API_KEY not set yet — stack is up, skipping workflow deploy."
  echo "    Create the n8n owner + API key in the browser, add N8N_API_KEY and"
  echo "    GOOGLE_OAUTH_CRED_ID to the 'production' environment, then re-deploy."
  exit 0
fi

echo "==> Install deploy tooling"
npm install --no-audit --no-fund --silent

echo "==> Deploy workflows into n8n (idempotent upsert)"
npm run deploy

echo "==> Deployment complete"
