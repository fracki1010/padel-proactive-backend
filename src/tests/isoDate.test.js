'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { toIsoDateString } = require('../utils/isoDate');

// toIsoDateString is the shared helper used to compare closure ranges and
// booking days. It must always format in UTC so the stored calendar day is
// stable regardless of the process timezone.

test('toIsoDateString formats a valid Date as a UTC YYYY-MM-DD string', () => {
  assert.equal(toIsoDateString(new Date(Date.UTC(2099, 0, 10))), '2099-01-10');
});

test('toIsoDateString keeps the UTC day for the same instant in a non-UTC timezone', () => {
  // 2099-01-10T23:30:00-05:00 and 2099-01-11T04:30:00Z are the same instant.
  // Formatting in UTC must resolve both to the 11th, not the local 10th.
  const instant = new Date('2099-01-10T23:30:00-05:00');

  assert.equal(instant.toISOString(), '2099-01-11T04:30:00.000Z');
  assert.equal(toIsoDateString(instant), '2099-01-11');
  assert.equal(toIsoDateString('2099-01-10T23:30:00-05:00'), '2099-01-11');
});

test('toIsoDateString treats null/undefined as "no date" instead of the epoch', () => {
  // A missing date must never be confused with 1970-01-01.
  assert.equal(toIsoDateString(null), '');
  assert.equal(toIsoDateString(undefined), '');
  // An unparseable string is returned unchanged as the fallback value.
  assert.equal(toIsoDateString('not-a-date'), 'not-a-date');
});
