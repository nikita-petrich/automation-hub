#!/usr/bin/env bash
# =============================================================================
# On-VPS step — bring the Docker stack up. Invoked over SSH by the CD pipeline
# (.github/workflows/deploy.yml); also safe to run by hand on the VPS.
#
# The workflow import (npm run deploy) runs on the GitHub runner against the
# public n8n API, NOT here — so the VPS needs only Docker + tar + ssh (no Node).
#
# The CI job copies the repo (tar over SSH) and renders .env (from the GitHub
# `production` environment) before calling this.
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
    echo "    WARNING: n8n not healthy after waiting" >&2
  fi
  sleep 3
done

echo "==> Stack is up"
