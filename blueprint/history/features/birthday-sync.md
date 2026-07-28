# Feature: birthday-sync (completed)

**Shipped 2026-07-28.** Reference implementation for future workflows.

## What

Sync Google Contacts birthdays into a dedicated Google Calendar as **yearly all-day
recurring events**, replacing the native Contacts→Calendar sync disabled in Germany
since 2024.

## Done-when (all met)

- Contacts with a valid birthday appear as `🎂 Name (turning N)` yearly all-day events on
  the target calendar.
- Re-running creates **0 duplicates** (idempotent; dedup by People `resourceName` + a
  content signature stored in `extendedProperties.private`).
- Runs daily at 06:00 Europe/Berlin (Schedule Trigger) and on demand (Manual Trigger).

## How

- HTTP Request nodes (People API + Calendar API) with one generic `oAuth2Api` credential
  (scopes: `contacts.readonly`, `calendar.events`).
- Logic in `lib/calendar-upsert.js` (unit-tested), injected into the Code node at deploy.
- Full detail: [`workflows/birthday-sync/README.md`](../../../workflows/birthday-sync/README.md).

## Verified

Deployed via CI/CD; 25+ birthday events created in the "Contact Birthdays" calendar; a
second run produced 0 new items (idempotency confirmed).
