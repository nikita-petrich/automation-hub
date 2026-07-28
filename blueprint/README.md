# blueprint/ — the AI-first development framework

automation-hub is built with AI agents using a **spec-first loop**, adapted from
[ai-blueprint](https://github.com/bradtraversy/ai-blueprint). Describe intent → the
agent writes a spec → a human reviews it → the agent implements in small, observable,
validated steps. The opposite of "vibe coding".

Here, **a feature = a new n8n workflow**.

## Files

**Source — human-maintained intent:**
- [`project-plan.md`](project-plan.md) — what automation-hub is for, goals, tech choices.
- [`build-plan.md`](build-plan.md) — the ordered checklist of workflows/features to build.

**Context — agent reference (regenerate from the plans when they change):**
- [`context/project-overview.md`](context/project-overview.md) — architecture summary + pointers.
- [`context/coding-standards.md`](context/coding-standards.md) — the conventions an agent must follow.
- [`context/ai-interaction.md`](context/ai-interaction.md) — how agents behave here (the AI-first policy).
- `context/current-feature.md` — the active spec (one item at a time). *Created per feature.*
- `context/findings.md` — audit/quality findings ledger. *Created as needed.*

**History — archived when work completes:**
- `history/features/`, `history/fixes/`, `history/rollbacks/`.

## The loop

```
plan (build-plan) → spec (current-feature, review) → implement (small diffs)
   → verify (npm run validate + npm test) → complete (PR → merge → auto-deploy)
   → archive (history/)
```

Run it with the repo skill **`/new-workflow`**, or follow it by hand from
[`context/coding-standards.md`](context/coding-standards.md).

> Want ai-blueprint's full slash-command toolkit (`/feature`, `/implement`,
> `/audit`, `/complete`, …)? Install it from
> [ai-blueprint](https://github.com/bradtraversy/ai-blueprint). This repo ships the
> framework files + a repo-specific `/new-workflow` skill.
