# Feature: error-notify — alerting & monitoring

**Status: SPEC — awaiting human review. No code written yet.**

## Problem

The hub is currently "fire and forget": nothing tells the operator when a workflow
breaks. Evidence in the repo as it stands:

| Failure | What happens today | Noticed? |
|---|---|---|
| HTTP node fails (401 after an OAuth revoke, 429 rate limit, 5xx) | Execution turns red in the n8n UI only | Only if someone looks |
| A single item fails in `Create Event` / `Update Event` | Default `stopWorkflow` aborts the run — remaining contacts are never written | No |
| n8n container / VPS down, workflow deactivated, cron never fires | **No execution at all** — no error, no record | No |
| Deploy fails | GitHub's default e-mail for a red Actions run | Yes, but deploy-time only |

Two aggravating factors:

- `docker-compose.yml:47-48` prunes executions after 336 h — after 14 days a failure
  leaves **no trace at all**.
- `workflows/birthday-sync/workflow.json` sets no `settings.errorWorkflow`, and n8n has
  **no instance-wide default** for it, so every future workflow would have to remember it.

## What we build

Four layers, so that both "something failed" *and* "nothing ran" are covered:

1. **Resilience** — `retryOnFail` on the HTTP nodes (transient 429/5xx are noise, not
   incidents) and per-item error output so one bad contact can't abort the rest.
2. **Central error workflow** — `workflows/error-notify/`: `Error Trigger` → format →
   Telegram. Every other workflow points at it via `settings.errorWorkflow`, injected at
   deploy time (see design decisions).
3. **Dead-man's-switch** — a successful `birthday-sync` run pings an **external** cron
   monitor (healthchecks.io). No ping within the grace period → the monitor alerts via
   Telegram. This is the only layer that survives the whole VPS being gone.
4. **CI failures** — an `if: failure()` step in `deploy.yml` posts to the same Telegram
   topic, so red deploys land next to red executions instead of in an inbox.

## Non-goals

- No monitoring stack in this repo (no Uptime Kuma / Prometheus container) — it would die
  with the host it is supposed to watch.
- No success notifications. Only failures push; success is silent (the heartbeat is the
  proof-of-life).
- No alert deduplication / state store. `birthday-sync` runs once a day, so the worst case
  is one alert per day per workflow. Revisit if a high-frequency workflow is added.
- No n8n log streaming (Enterprise-only).

## Done-when (observable)

1. Breaking a production execution on purpose (e.g. temporarily invalid `CALENDAR_ID`)
   produces a Telegram message within seconds containing: project prefix, workflow name,
   failing node, trimmed error message, timestamp, and a clickable execution link.
2. A **trigger-level** failure (payload shape `trigger.error`, no `execution.url`) produces
   a well-formed message too — no `undefined` anywhere.
3. `npm run deploy` sets `settings.errorWorkflow` on every workflow **except**
   `error-notify` itself; verified via `GET /api/v1/workflows`.
4. A transient 429/503 from Google is retried and produces **no** alert.
5. One failing item no longer aborts the remaining create/update items.
6. A successful run pings the healthchecks.io check exactly once — including on a
   no-change day, when zero create/update items are produced.
7. Pausing/deactivating the workflow past the grace period produces a Telegram alert
   *from the monitor* (proves the dead-man's-switch).
8. A failing `deploy.yml` run posts to the same Telegram topic.
9. `npm run validate` + `npm test` green, new `lib/` unit tests cover both error payload
   shapes; no secrets in the repo.

## Design decisions (please review these)

| Decision | Rationale |
|---|---|
| **HTTP Request + `$env.TELEGRAM_BOT_TOKEN`**, not the native Telegram node | Needs **zero manual n8n UI steps** — `N8N_BLOCK_ENV_ACCESS_IN_NODE` is already `false` and the secret flows through the existing `.env` render in `deploy.yml`. Keeps the AGENTS.md promise that OAuth consent is the only manual step. **Trade-off:** the token appears in that node's execution data (single-user instance, pruned after 14 days). The stricter alternative is a one-time Telegram credential in the UI. |
| **Two-pass deploy** in `scripts/deploy.ts` | `settings.errorWorkflow` takes an n8n-assigned **ID**, not a name. Pass 1 upserts the workflow containing an `errorTrigger` node and records its id; pass 2 injects `settings.errorWorkflow = <id>` into all others — same pattern as the existing schedule/credential injection. New workflows are wired automatically, forever. |
| Detect the error workflow **by node type**, not by folder name | Self-maintaining. 0 found → deploy behaves exactly as today (backwards compatible); >1 found → hard error. |
| `error-notify` ships with **`active: false`** | Error workflows are invoked internally and do not need activation; calling `activate` on an Error-Trigger-only workflow is a known n8n failure. |
| `error-notify` gets **no** `errorWorkflow` of its own | Loop prevention: an alert that fails must not alert about itself. |
| Committed `workflow.json` files contain **no** `errorWorkflow` value | Injected at deploy, like `GOOGLE_OAUTH_CRED_ID` — the repo stays environment-agnostic. |
| Message formatter lives in **`lib/alert-format.js`** | Same convention as `calendar-upsert.js`: dependency-free between `INLINE` markers, unit-tested, injected into the Code node, CI fails on drift. |
| **External** cron monitor (healthchecks.io free tier) | A heartbeat monitor on the same VPS dies with the VPS and reports nothing. |
| **One shared bot, one group with topics** | Matches the "one bot across all my projects" goal: `ALERT_PROJECT` prefixes every message and `TELEGRAM_TOPIC_ID` routes it into that project's topic. One token, clean separation, everything in one chat. |

## Ordered steps

Each step ends in something reviewable (a diff, a passing test, a green `validate`).

**Step 1 — `lib/alert-format.js` + `lib/alert-format.test.js`**
`formatAlert(payload, opts)` → `{ text, parseMode }`. Handles both Error-Trigger shapes:
`execution.error` + `execution.url` + `lastNodeExecuted`, and `trigger.error` (no
execution/url). HTML-escapes all interpolated values, trims the message to a sane length,
formats the timestamp for `Europe/Berlin`. Tests cover: execution error, trigger error,
missing/partial fields, HTML injection in a workflow name, message truncation.
*Verify:* `npm test` green.

**Step 2 — `workflows/error-notify/workflow.json` + README**
`Error Trigger` → Code node `Format Alert` (LIB markers) → HTTP Request
`POST https://api.telegram.org/bot{{$env.TELEGRAM_BOT_TOKEN}}/sendMessage` with
`chat_id`, `text`, `parse_mode=HTML`, optional `message_thread_id`,
`disable_web_page_preview=true`; `retryOnFail: true`, `maxTries: 3`.
`name: "Error Notify (→ Telegram)"`, `active: false`, `settings.executionOrder: v1`.
*Verify:* `npm run validate` green.

**Step 3 — `scripts/deploy.ts`: two-pass wiring**
Detect the error workflow by `errorTrigger` node type, deploy it first, capture the id,
inject `settings.errorWorkflow` into every other workflow's payload. Log which id was
wired. Keep it idempotent; keep the CLI fallback working (it can't wire ids — log a clear
notice there).
*Verify:* dry run output shows the injection for `birthday-sync`.

**Step 4 — `scripts/validate.ts`: new rules**
At most one workflow with an `errorTrigger`; a workflow with an `errorTrigger` must be
`active: false` and must not set `settings.errorWorkflow`; no committed workflow sets
`settings.errorWorkflow` (it is deploy-injected).
*Verify:* `npm run validate` green; rules fail on a deliberately broken fixture.

**Step 5 — `birthday-sync` resilience**
`retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 2000` on all four HTTP nodes.
`onError: "continueErrorOutput"` on `Create Event` / `Update Event`, with the error output
collected so a single bad contact no longer aborts the run.
*Verify:* `npm run validate` + `npm test` green.

**Step 6 — heartbeat in `birthday-sync`**
The catch: on a no-change day `Plan Operations` emits **zero** items, so nothing downstream
of the Switch executes and a naive heartbeat node would never fire — producing a false
"down" alert on exactly the days everything is fine. Plan: `lib/calendar-upsert.js` also
emits one `action: 'summary'` item (counts of created/updated/skipped); the Switch gets a
third output for it; `Create Event` + `Update Event` + summary feed a **Merge (append)**
node, and only then the `Heartbeat` HTTP node
(`$env.HEALTHCHECK_PING_URL`, body = the counts, `onError: continueRegularOutput` so a dead
monitor never reddens the sync). The merge is what guarantees the ping happens **after**
the writes — a failing write aborts before the ping, which is the whole point.
*To verify during implementation:* that a Merge input receiving zero items still resolves
under `executionOrder: v1`. If it does not, fall back to `alwaysOutputData` on the write
nodes. Also update the `birthday-sync` README node graph + the lib unit tests for the new
summary item.

**Step 7 — config plumbing**
`.env.example`, `docker-compose.yml` (env passthrough) and the `.env` render block in
`.github/workflows/deploy.yml` get: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_TOPIC_ID` (optional), `ALERT_PROJECT` (default `automation-hub`),
`HEALTHCHECK_PING_URL` (optional — empty disables the heartbeat cleanly).

**Step 8 — CI failure notification + docs**
`if: failure()` step in `deploy.yml` posting to the same chat/topic (skipped when the
secret is absent). New `docs/monitoring.md` (what alerts exist, what each layer catches,
how to test each one, how to add the bot to another project). README "Monitoring" section,
`AGENTS.md` note that new workflows are auto-wired, `blueprint/build-plan.md` ticked, spec
archived to `blueprint/history/features/error-notify.md`.

## New configuration

| Variable | Where | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | GitHub `production` secret → `.env` → container | Bot API token |
| `TELEGRAM_CHAT_ID` | same | Target chat (the alerts group) |
| `TELEGRAM_TOPIC_ID` | same (optional) | Forum topic for this project |
| `ALERT_PROJECT` | same (default `automation-hub`) | Message prefix — makes one shared bot unambiguous across repos |
| `HEALTHCHECK_PING_URL` | same (optional) | `https://hc-ping.com/<uuid>`; empty = heartbeat off |

## Human prerequisites (~5 minutes, cannot be automated)

1. **@BotFather** → `/newbot` → token.
2. Create a Telegram group, enable **Topics**, add the bot, create a topic
   `automation-hub`, post one message in it.
3. `curl https://api.telegram.org/bot<TOKEN>/getUpdates` → read `chat.id` (negative for
   groups) and `message_thread_id`.
4. **healthchecks.io** → new check, cron `0 6 * * *`, timezone `Europe/Berlin`, grace 2 h,
   integration → Telegram. Copy the ping URL.
5. Put the five values into the GitHub `production` Environment.

No n8n UI steps.

## Sample alert

```
🚨 [automation-hub] Birthday Sync (Contacts → Calendar)

Node:  Create Event
Error: 401 Unauthorized — Invalid Credentials
Time:  2026-07-28 06:00:14 (Europe/Berlin)

→ Open execution
```

## Open questions for review

1. **Topics or plain chat?** Topics scale better across projects but require the group to
   be a forum. Plain chat + `ALERT_PROJECT` prefix also works — preference?
2. **healthchecks.io (external SaaS, free) or self-hosted Uptime Kuma on a different
   host?** Spec assumes healthchecks.io. Self-hosting only makes sense if there is a
   second box.
3. **Sanity alert wanted?** e.g. "run succeeded but the People API returned 0 contacts" —
   technically green, practically broken. Not in scope unless you want it.
4. **CI failures to Telegram, or is the GitHub e-mail enough?** Step 8 is easy to drop.
5. **Strict token handling?** If the token in execution data bothers you, we switch to a
   one-time Telegram credential in the n8n UI (one manual step, native Telegram node).
