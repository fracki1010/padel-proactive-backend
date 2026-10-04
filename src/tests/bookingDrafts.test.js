'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  toDraftLabelByIndex,
  buildDraftFromRaw,
  extractRequestedCourtsCount,
  parseStrictDraftConfirmation,
  extractBookingDraftsFromMessage,
} = require('../whatsapp/domain/bookingDrafts');

test('toDraftLabelByIndex maps indexes to letters A, B, C...', () => {
  assert.strictEqual(toDraftLabelByIndex(0), 'A');
  assert.strictEqual(toDraftLabelByIndex(1), 'B');
  assert.strictEqual(toDraftLabelByIndex(2), 'C');
});

test('buildDraftFromRaw normalizes court name and assigns a letter id', () => {
  assert.deepStrictEqual(
    buildDraftFromRaw(
      { courtName: 'Cancha 1', dateStr: '2026-04-07', timeStr: '20:00' },
      0,
    ),
    { id: 'A', courtName: 'Cancha 1', dateStr: '2026-04-07', timeStr: '20:00' },
  );
  assert.strictEqual(buildDraftFromRaw({}, 1).courtName, 'INDIFERENTE');
});

test('extractRequestedCourtsCount reads numeric and word counts', () => {
  assert.strictEqual(extractRequestedCourtsCount('quiero 2 canchas'), 2);
  assert.strictEqual(extractRequestedCourtsCount('dos turnos'), 2);
  assert.strictEqual(extractRequestedCourtsCount('quiero reservar'), 1);
  assert.strictEqual(extractRequestedCourtsCount('x 4 canchas'), 4);
});

test('parseStrictDraftConfirmation parses confirm-all, confirm-letter and rejects bad letters', () => {
  assert.deepStrictEqual(parseStrictDraftConfirmation('confirmar todo', 3), { type: 'ALL' });
  assert.deepStrictEqual(parseStrictDraftConfirmation('confirmar b', 3), { type: 'ONE', index: 1 });
  assert.strictEqual(parseStrictDraftConfirmation('confirmar x', 2), null);
});

test('extractBookingDraftsFromMessage builds one draft per segment', () => {
  const drafts = extractBookingDraftsFromMessage('hoy 20:00 y mañana 21:00', 'INDIFERENTE');
  assert.strictEqual(drafts.length, 2);
  assert.deepStrictEqual(
    drafts.map((d) => [d.id, d.timeStr, d.courtName]),
    [
      ['A', '20:00', 'INDIFERENTE'],
      ['B', '21:00', 'INDIFERENTE'],
    ],
  );
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(drafts[0].dateStr));
});

test('extractBookingDraftsFromMessage multiplies a single draft when courts requested', () => {
  const drafts = extractBookingDraftsFromMessage('2 canchas hoy 20:00', 'INDIFERENTE');
  assert.strictEqual(drafts.length, 2);
  assert.deepStrictEqual(drafts.map((d) => d.id), ['A', 'B']);
  assert.strictEqual(drafts[1].timeStr, '20:00');
});

test('extractBookingDraftsFromMessage returns empty for unrelated input', () => {
  assert.deepStrictEqual(extractBookingDraftsFromMessage('hola', 'INDIFERENTE'), []);
});