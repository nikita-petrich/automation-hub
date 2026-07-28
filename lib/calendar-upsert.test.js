'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashString,
  normalizeContacts,
  indexExistingEvents,
  ageOnNextBirthday,
  buildDesiredEvent,
  decideOperation,
  planOperations,
} = require('./calendar-upsert.js');

// A fixed "now" so every age/anchor assertion is deterministic.
const NOW = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15
const CAL = 'cal@group.calendar.google.com';
const OPTS = { calendarId: CAL, showBirthYear: true, now: NOW };

test('hashString is stable and changes with input', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.match(hashString('abc'), /^[0-9a-f]{8}$/);
});

test('normalizeContacts keeps only contacts with a usable birthday', () => {
  const pages = [
    {
      connections: [
        {
          resourceName: 'people/c1',
          names: [{ displayName: 'Anna Schmidt', metadata: { primary: true } }],
          birthdays: [{ date: { year: 1986, month: 3, day: 15 } }],
        },
        {
          resourceName: 'people/c2',
          names: [{ displayName: 'No Birthday' }],
          birthdays: [],
        },
        {
          resourceName: 'people/c3',
          names: [{ displayName: 'Month Day Only' }],
          birthdays: [{ date: { month: 12, day: 1 } }], // no year
        },
        {
          // missing resourceName -> dropped
          names: [{ displayName: 'Ghost' }],
          birthdays: [{ date: { year: 1990, month: 1, day: 1 } }],
        },
      ],
    },
  ];
  const contacts = normalizeContacts(pages);
  assert.equal(contacts.length, 2);
  assert.deepEqual(contacts[0], {
    resourceName: 'people/c1',
    displayName: 'Anna Schmidt',
    day: 15,
    month: 3,
    year: 1986,
  });
  assert.equal(contacts[1].year, null);
});

test('ageOnNextBirthday accounts for whether the birthday already passed', () => {
  // Birthday March 15, now June 15 2026 -> next birthday 2027 -> turning 41.
  assert.equal(ageOnNextBirthday({ month: 3, day: 15, year: 1986 }, NOW), 41);
  // Birthday Dec 1, now June 15 2026 -> next birthday still 2026 -> turning 40.
  assert.equal(ageOnNextBirthday({ month: 12, day: 1, year: 1986 }, NOW), 40);
  // Unknown year -> null.
  assert.equal(ageOnNextBirthday({ month: 12, day: 1, year: null }, NOW), null);
});

test('buildDesiredEvent produces a yearly all-day event with dedup metadata', () => {
  const ev = buildDesiredEvent(
    { resourceName: 'people/c1', displayName: 'Anna', day: 15, month: 3, year: 1986 },
    OPTS
  );
  assert.equal(ev.start.date, '1986-03-15');
  assert.equal(ev.end.date, '1986-03-16'); // exclusive end
  assert.deepEqual(ev.recurrence, ['RRULE:FREQ=YEARLY']);
  assert.equal(ev.summary, '🎂 Anna (turning 41)');
  assert.equal(ev.extendedProperties.private.managedBy, 'birthday-sync');
  assert.equal(ev.extendedProperties.private.contactId, 'people/c1');
  assert.equal(ev.extendedProperties.private.sig, ev._sig);
});

test('buildDesiredEvent handles Feb 29 with an unknown year', () => {
  const ev = buildDesiredEvent(
    { resourceName: 'people/c9', displayName: 'Leap', day: 29, month: 2, year: null },
    OPTS
  );
  assert.equal(ev.start.date, '2000-02-29');
  assert.equal(ev.end.date, '2000-03-01');
  assert.equal(ev.summary, '🎂 Leap'); // no year -> no age suffix
});

test('buildDesiredEvent keeps a leap birth year as the anchor', () => {
  const ev = buildDesiredEvent(
    { resourceName: 'people/c10', displayName: 'Leap', day: 29, month: 2, year: 1988 },
    OPTS
  );
  assert.equal(ev.start.date, '1988-02-29');
  assert.equal(ev.end.date, '1988-03-01');
});

test('buildDesiredEvent rescues Feb 29 with a NON-leap birth year', () => {
  // Bad contact data (Feb 29 can only exist in a leap year). Anchoring to 1995
  // would emit 1995-02-29 and the Calendar API answers 400, failing the run.
  const ev = buildDesiredEvent(
    { resourceName: 'people/c11', displayName: 'Bad Data', day: 29, month: 2, year: 1995 },
    OPTS
  );
  assert.equal(ev.start.date, '2000-02-29');
  assert.equal(ev.end.date, '2000-03-01');
  // The age still comes from the real birth year (1995), not the 2000 anchor.
  // Feb has passed by the 2026-06-15 "now", so the next birthday is 2027.
  assert.equal(ev.summary, '🎂 Bad Data (turning 32)');
});

test('normalizeContacts drops impossible month/day combinations', () => {
  const pages = [
    {
      connections: [
        {
          resourceName: 'people/bad1',
          names: [{ displayName: 'Month 13' }],
          birthdays: [{ date: { month: 13, day: 1 } }],
        },
        {
          resourceName: 'people/bad2',
          names: [{ displayName: 'April 31' }],
          birthdays: [{ date: { month: 4, day: 31 } }],
        },
        {
          resourceName: 'people/bad3',
          names: [{ displayName: 'Feb 30' }],
          birthdays: [{ date: { month: 2, day: 30 } }],
        },
        {
          resourceName: 'people/ok',
          names: [{ displayName: 'Feb 29' }],
          birthdays: [{ date: { month: 2, day: 29 } }], // valid in a leap year
        },
      ],
    },
  ];
  const contacts = normalizeContacts(pages);
  assert.deepEqual(
    contacts.map((c) => c.resourceName),
    ['people/ok']
  );
});

test('normalizeContacts de-duplicates a contact seen more than once', () => {
  // n8n runs a node once per input item, so the same contact page can arrive
  // several times. Without dedup each copy plans its own `create` — duplicate
  // calendar events, because the idempotency check looks at the calendar only.
  const page = {
    connections: [
      {
        resourceName: 'people/c1',
        names: [{ displayName: 'Anna' }],
        birthdays: [{ date: { year: 1986, month: 3, day: 15 } }],
      },
    ],
  };
  const contacts = normalizeContacts([page, page, page]);
  assert.equal(contacts.length, 1);

  const ops = planOperations(contacts, {}, OPTS);
  assert.equal(ops.filter((o) => o.action === 'create').length, 1);
});

test('SHOW_BIRTH_YEAR=false omits the age suffix', () => {
  const ev = buildDesiredEvent(
    { resourceName: 'people/c1', displayName: 'Anna', day: 15, month: 3, year: 1986 },
    { ...OPTS, showBirthYear: false }
  );
  assert.equal(ev.summary, '🎂 Anna');
});

test('decideOperation: create when no existing event', () => {
  const op = decideOperation(
    { resourceName: 'people/c1', displayName: 'Anna', day: 15, month: 3, year: 1986 },
    {},
    OPTS
  );
  assert.equal(op.action, 'create');
  assert.equal(op.method, 'POST');
  assert.ok(op.url.endsWith('/events'));
  assert.ok(op.url.includes(encodeURIComponent(CAL)));
  assert.equal(op.body.extendedProperties.private.sig !== undefined, true);
  assert.equal(op.body._sig, undefined); // internal field stripped
});

test('decideOperation: skip when signature matches, update when it differs', () => {
  const contact = { resourceName: 'people/c1', displayName: 'Anna', day: 15, month: 3, year: 1986 };
  const desired = buildDesiredEvent(contact, OPTS);

  const existingMatch = {
    'people/c1': {
      id: 'evt123',
      extendedProperties: { private: { contactId: 'people/c1', sig: desired._sig } },
    },
  };
  assert.equal(decideOperation(contact, existingMatch, OPTS).action, 'skip');

  const existingStale = {
    'people/c1': {
      id: 'evt123',
      extendedProperties: { private: { contactId: 'people/c1', sig: 'deadbeef' } },
    },
  };
  const op = decideOperation(contact, existingStale, OPTS);
  assert.equal(op.action, 'update');
  assert.equal(op.method, 'PATCH');
  assert.equal(op.eventId, 'evt123');
  assert.ok(op.url.endsWith('/events/evt123'));
});

test('name or date change flips a skip into an update (via signature)', () => {
  const before = { resourceName: 'people/c1', displayName: 'Anna', day: 15, month: 3, year: 1986 };
  const renamed = { resourceName: 'people/c1', displayName: 'Anna Schmidt', day: 15, month: 3, year: 1986 };
  const sigBefore = buildDesiredEvent(before, OPTS)._sig;
  const existing = {
    'people/c1': {
      id: 'e1',
      extendedProperties: { private: { contactId: 'people/c1', sig: sigBefore } },
    },
  };
  assert.equal(decideOperation(before, existing, OPTS).action, 'skip');
  assert.equal(decideOperation(renamed, existing, OPTS).action, 'update');
});

test('indexExistingEvents maps by contactId and ignores unmanaged events', () => {
  const map = indexExistingEvents([
    {
      items: [
        { id: 'e1', extendedProperties: { private: { contactId: 'people/c1', sig: 'x' } } },
        { id: 'e2', summary: 'unrelated meeting' },
      ],
    },
  ]);
  assert.equal(Object.keys(map).length, 1);
  assert.equal(map['people/c1'].id, 'e1');
});

test('planOperations returns one operation per contact', () => {
  const contacts = normalizeContacts([
    {
      connections: [
        { resourceName: 'people/c1', names: [{ displayName: 'A' }], birthdays: [{ date: { year: 1990, month: 1, day: 2 } }] },
        { resourceName: 'people/c2', names: [{ displayName: 'B' }], birthdays: [{ date: { month: 5, day: 6 } }] },
      ],
    },
  ]);
  const ops = planOperations(contacts, {}, OPTS);
  assert.equal(ops.length, 2);
  assert.ok(ops.every((o) => o.action === 'create'));
});
