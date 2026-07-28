# Project overview (agent reference)

> Generated context. Source of truth: `../project-plan.md`, `README.md`, `docs/`.

- **What / why:** [`../project-plan.md`](../project-plan.md).
- **Architecture + how it works:** [`docs/manual-setup.md` §1](../../docs/manual-setup.md).
- **CI/CD internals:** [`docs/ci-cd.md`](../../docs/ci-cd.md).
- **Reference workflow:** [`workflows/birthday-sync/README.md`](../../workflows/birthday-sync/README.md).
- **Shared, unit-tested logic:** [`lib/calendar-upsert.js`](../../lib/calendar-upsert.js) (+ `.test.js`).

## Facts an agent needs

- Repo → n8n is **one-way**; merging to `main` deploys via GitHub Actions.
- **Add a workflow:** `workflows/<name>/workflow.json` (stable `name`, `active`), shared
  logic in `lib/` between the `INLINE` markers, `npm run sync`, `npm run validate`, `npm test`.
- **Secrets** live in the GitHub `production` Environment, never in the repo; the pipeline
  renders `.env` on the VPS at deploy.
- VPS needs only Docker; n8n on SQLite, container `n8n`, loopback port `127.0.0.1:5678`.
