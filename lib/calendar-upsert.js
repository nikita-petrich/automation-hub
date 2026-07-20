/**
 * automation-hub — shared birthday-sync upsert logic
 * =====================================================================
 * This file is the SINGLE SOURCE OF TRUTH for the birthday-sync business
 * logic. Everything between the `INLINE:START` / `INLINE:END` markers below
 * is dependency-free and is copied verbatim into the n8n "Plan Operations"
 * Code node by `scripts/deploy.ts` (and kept in sync inside the committed
 * workflow.json by `npm run sync`). That is why this region:
 *   - uses only plain functions and language built-ins (no require/import),
 *   - never references n8n globals ($input, $env, ...) — the thin glue in the
 *     Code node does that and calls these functions,
 *   - is also exported at the bottom for Node-based unit tests.
 *
 * Design decisions (see workflows/birthday-sync/README.md for the full
 * rationale):
 *   - REGULAR all-day events with `RRULE:FREQ=YEARLY`, NOT eventType=birthday,
 *     because only regular events support extendedProperties + secondary
 *     calendars reliably.
 *   - Idempotency key = the People API `resourceName`, stored in
 *     extendedProperties.private.contactId. A content signature (`sig`) stored
 *     alongside it lets us cheaply decide create / update / skip.
 */

// ==== INLINE:START (auto-synced into the workflow Code node — edit here only) ====

/**
 * Small, dependency-free FNV-1a hash -> 8-char hex string.
 * Used to build a stable content signature for change detection.
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (FNV prime), kept in 32-bit unsigned range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/**
 * Flatten People API `connections.list` response pages into normalized
 * contacts that actually have a usable birthday.
 * Returns: [{ resourceName, displayName, day, month, year|null }]
 * `year` is null when the birthday has no year (very common in Contacts).
 */
function normalizeContacts(pages) {
  const out = [];
  for (const page of pages || []) {
    const connections = (page && page.connections) || [];
    for (const person of connections) {
      const resourceName = person && person.resourceName;
      if (!resourceName) continue;

      // Pick the first birthday entry that carries a structured month + day.
      let date = null;
      for (const b of person.birthdays || []) {
        if (b && b.date && b.date.month && b.date.day) {
          date = b.date;
          break;
        }
      }
      if (!date) continue; // no usable birthday -> skip this contact

      const names = person.names || [];
      const primary = names.find((n) => n.metadata && n.metadata.primary) || names[0];
      const displayName =
        primary && primary.displayName ? String(primary.displayName).trim() : 'Unknown';

      out.push({
        resourceName,
        displayName: displayName || 'Unknown',
        day: date.day,
        month: date.month,
        year: date.year || null,
      });
    }
  }
  return out;
}

/**
 * Index existing managed events (Calendar `events.list` pages) by contactId,
 * so the planner can match a contact to its event in O(1).
 */
function indexExistingEvents(pages) {
  const map = {};
  for (const page of pages || []) {
    const items = (page && page.items) || [];
    for (const ev of items) {
      const priv = ev && ev.extendedProperties && ev.extendedProperties.private;
      if (priv && priv.contactId) map[priv.contactId] = ev;
    }
  }
  return map;
}

/**
 * Age the person turns on their NEXT birthday relative to `now`.
 * Returns null when the birth year is unknown.
 */
function ageOnNextBirthday(contact, now) {
  if (!contact.year) return null;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  const alreadyPassed = contact.month < m || (contact.month === m && contact.day < d);
  const nextYear = alreadyPassed ? y + 1 : y;
  return nextYear - contact.year;
}

/**
 * Build the event title. When SHOW_BIRTH_YEAR is on and a birth year exists,
 * append the age reached on the upcoming birthday, e.g. "🎂 Anna (turning 40)".
 * The daily sweep refreshes this so the age stays correct year to year.
 */
function buildSummary(contact, opts) {
  const base = '🎂 ' + contact.displayName;
  if (opts.showBirthYear && contact.year) {
    const age = ageOnNextBirthday(contact, opts.now);
    if (age !== null && age >= 0) return base + ' (turning ' + age + ')';
  }
  return base;
}

/**
 * Build the desired Google Calendar event resource for a contact.
 * Returns the event body plus an internal `_sig` used for change detection
 * (the caller strips `_sig` before sending it to the API).
 */
function buildDesiredEvent(contact, opts) {
  // Anchor year = birth year when known (series then literally starts at birth),
  // otherwise the current year. Feb 29 with an unknown year is anchored to a
  // known leap year so the start date is valid.
  let anchorYear = contact.year || opts.now.getUTCFullYear();
  if (!contact.year && contact.month === 2 && contact.day === 29) anchorYear = 2000;

  const startDate = anchorYear + '-' + pad2(contact.month) + '-' + pad2(contact.day);
  // All-day events use an exclusive end date -> the following day.
  const endObj = new Date(Date.UTC(anchorYear, contact.month - 1, contact.day + 1));
  const endDate =
    endObj.getUTCFullYear() +
    '-' +
    pad2(endObj.getUTCMonth() + 1) +
    '-' +
    pad2(endObj.getUTCDate());

  const summary = buildSummary(contact, opts);
  const sig = hashString(
    [contact.displayName, contact.month, contact.day, contact.year || '', summary].join('|')
  );

  return {
    summary,
    start: { date: startDate },
    end: { date: endDate },
    recurrence: ['RRULE:FREQ=YEARLY'],
    transparency: 'transparent', // do not block "busy" time
    reminders: { useDefault: true }, // inherit the target calendar's reminders
    extendedProperties: {
      private: {
        managedBy: 'birthday-sync',
        contactId: contact.resourceName,
        sig: sig,
      },
    },
    _sig: sig,
  };
}

/**
 * Decide create / update / skip for one contact given the existing event map.
 * Produces a ready-to-execute operation descriptor (method + url + body).
 */
function decideOperation(contact, existingMap, opts) {
  const desired = buildDesiredEvent(contact, opts);
  const sig = desired._sig;
  delete desired._sig;

  const enc = encodeURIComponent(opts.calendarId);
  const base = 'https://www.googleapis.com/calendar/v3/calendars/' + enc + '/events';
  const existing = existingMap[contact.resourceName];

  if (!existing) {
    return {
      action: 'create',
      method: 'POST',
      url: base,
      body: desired,
      contactId: contact.resourceName,
      summary: desired.summary,
    };
  }

  const existingSig =
    existing.extendedProperties && existing.extendedProperties.private
      ? existing.extendedProperties.private.sig
      : null;

  if (existingSig !== sig) {
    return {
      action: 'update',
      method: 'PATCH',
      url: base + '/' + encodeURIComponent(existing.id),
      body: desired,
      eventId: existing.id,
      contactId: contact.resourceName,
      summary: desired.summary,
    };
  }

  return {
    action: 'skip',
    contactId: contact.resourceName,
    summary: desired.summary,
    eventId: existing.id,
  };
}

/**
 * Plan operations for every contact. The caller typically filters out
 * `skip` operations before routing create/update to the Calendar API.
 */
function planOperations(contacts, existingMap, opts) {
  const ops = [];
  for (const c of contacts) ops.push(decideOperation(c, existingMap, opts));
  return ops;
}

// ==== INLINE:END ====

// ---- Node.js export (NOT injected into n8n; used by the unit tests) --------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    hashString,
    pad2,
    normalizeContacts,
    indexExistingEvents,
    ageOnNextBirthday,
    buildSummary,
    buildDesiredEvent,
    decideOperation,
    planOperations,
  };
}
