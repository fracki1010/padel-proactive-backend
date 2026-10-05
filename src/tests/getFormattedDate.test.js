'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getFormattedDate } = require('../utils/getFormattedDate');

// Contract for client-facing WhatsApp messages: ISO dates must render as
// readable Spanish "weekday day month" text (e.g. "martes 6 de octubre")
// instead of raw numeric formats like 06/10/2026.
test('getFormattedDate renders "weekday day month" in Spanish for an ISO date', () => {
  assert.strictEqual(getFormattedDate('2026-10-06'), 'martes 6 de octubre');
});

test('getFormattedDate renders a different date correctly (triangulation)', () => {
  assert.strictEqual(getFormattedDate('2026-12-25'), 'viernes 25 de diciembre');
});

test('getFormattedDate falls back to the raw input for invalid dates', () => {
  assert.strictEqual(getFormattedDate('06/10/2026'), '06/10/2026');
  assert.strictEqual(getFormattedDate(''), '');
});