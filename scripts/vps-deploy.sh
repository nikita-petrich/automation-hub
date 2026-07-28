#!/usr/bin/env bash
# =============================================================================
# On-VPS deployment — runs ON the server, invoked over SSH by the CD pipeline
# (.github/workflows/deploy.yml). Also safe to run by hand on the VPS.
#
# The CI job first rsyncs the repository onto the VPS (excluding .env), then runs
# this script. Real secrets live only in the VPS-local .env (gitignored) and are
# NEVER stored in GitHub.
#
# Requirements on the VPS: Docker + Compose, Node.js (>=20), and the SSH user in
# the `docker` group. A one-time-created .env must be present (see
# docs/manual-setup.md).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
echo "==> Working dir: $(pwd)"

if [ ! -f .env ]; then
  echo "ERROR: .env is missing on the VPS. Create it once from .env.example" >&2
  echo "       (see docs/manual-setup.md), then re-run the deploy." >&2
  exit 1
fi

echo "==> Pull images and (re)start the stack"
docker compose pull
docker compose up -d --remove-orphans

echo "==> Wait for n8n to become healthy"
for i in $(seq 1 40); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' automation-hub-n8n 2>/dev/null || echo missing)"
  if [ "$status" = "healthy" ]; then
    echo "    n8n is healthy"
    break
  fi
  if [ "$i" -eq 40 ]; then
    echo "    WARNING: n8n not healthy after waiting; attempting workflow deploy anyway" >&2
  fi
  sleep 3
done

echo "==> Install deploy tooling"
npm install --no-audit --no-fund --silent

echo "==> Deploy workflows into n8n (idempotent upsert)"
npm run deploy

echo "==> Deployment complete"
