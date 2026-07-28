---
name: new-workflow
description: Scaffold and add a new n8n workflow to the automation-hub repo the AI-first way — spec-first, with a stable workflow name, shared lib logic, validation, and a PR that auto-deploys on merge to main. Use when asked to add, build, or scaffold a new workflow or automation in this repository.
---

# Add a new n8n workflow (automation-hub)

Follow the spec-first loop. Read [`AGENTS.md`](../../../AGENTS.md) and
[`blueprint/context/coding-standards.md`](../../../blueprint/context/coding-standards.md) first.

## 1. Plan
Add the workflow as a checklist item in `blueprint/build-plan.md`.

## 2. Spec — then stop for review
Write `blueprint/context/current-feature.md`: **what** it does, **done-when** conditions
(observable), and ordered build steps. Pause for human review before writing code.

## 3. Implement
- Create `workflows/<name>/workflow.json`:
  - a **stable, unique `name`** (the deploy upsert key), `active: true|false`,
    `settings: { "executionOrder": "v1" }`.
  - triggers + nodes. Prefer HTTP Request + a generic `oAuth2Api` credential for Google/
    other APIs. If it writes data, build in **idempotency** (stable dedup key + a content
    signature → create/update/skip).
- If it needs shared JS, add it to `lib/` between `// ==== INLINE:START ====` /
  `// ==== INLINE:END ====` (dependency-free, unit-tested), reference it from the Code node
  between `// LIB:START` / `// LIB:END`, then run `npm run sync`.
- Add `workflows/<name>/README.md` (what it does, nodes, config, edge cases).
- Add any new config as a GitHub `production` Environment secret; read it via `$env.*` in
  the workflow (and wire it in `scripts/deploy.ts` if it must be injected at deploy time).

## 4. Verify
```bash
npm run validate   # JSON/schema + lib drift + JS syntax
npm test           # lib unit tests
```
Both green. Never commit secrets.

## 5. Complete
Open a PR (CI must pass). On merge to `main` it **auto-deploys**. Move the spec to
`blueprint/history/features/<name>.md` and check the item off in `blueprint/build-plan.md`.
