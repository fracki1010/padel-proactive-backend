'use strict';

// Per-company "pause bookings" switch (`bookings-pause` capability):
// the AppConfig model stores `bookingsPaused` (default false) and the service
// exposes a boolean read/write pair that mirrors the other per-company switches.
// Persistence runs against an in-memory fake model so the round-trip can be
// proven without a live MongoDB connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const AppConfig = require('../models/appConfig.model');
const {
  getBookingsPaused,
  setBookingsPaused,
} = require('../services/appConfig.service');

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

// ── In-memory fake model ─────────────────────────────────────────────────────

const createFakeConfigModel = () => {
  const calls = { findOne: [], findOneAndUpdate: [] };
  let doc = null;

  return {
    calls,
    setDoc(next) {
      doc = next;
    },
    async findOne(filter) {
      calls.findOne.push(filter);
      return doc;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.findOneAndUpdate.push({ filter, update, options });
      doc = { ...doc, ...update.$set };
      return doc;
    },
  };
};

// ── Model schema ─────────────────────────────────────────────────────────────

test('AppConfig exposes bookingsPaused defaulting to false', () => {
  const path = AppConfig.schema.path('bookingsPaused');
  assert.equal(path.instance, 'Boolean');
  assert.equal(path.defaultValue, false);
});

// ── Read ─────────────────────────────────────────────────────────────────────

test('getBookingsPaused returns false for an empty config', async () => {
  const model = createFakeConfigModel();

  const paused = await getBookingsPaused(COMPANY_A, { model });

  assert.equal(paused, false);
});

test('getBookingsPaused echoes a stored true', async () => {
  const model = createFakeConfigModel();
  model.setDoc({ bookingsPaused: true });

  const paused = await getBookingsPaused(COMPANY_A, { model });

  assert.equal(paused, true);
});

test('getBookingsPaused scopes the query by companyId', async () => {
  const model = createFakeConfigModel();

  await getBookingsPaused(COMPANY_B, { model });

  assert.equal(String(model.calls.findOne[0].companyId), COMPANY_B);
  assert.equal(model.calls.findOne[0].key, 'main');
});

// ── Write ────────────────────────────────────────────────────────────────────

test('setBookingsPaused persists the boolean with upsert', async () => {
  const model = createFakeConfigModel();

  await setBookingsPaused(true, COMPANY_A, { model });

  assert.equal(model.calls.findOneAndUpdate.length, 1);
  const { update, options } = model.calls.findOneAndUpdate[0];
  assert.deepEqual(update.$set, { bookingsPaused: true });
  assert.equal(options.upsert, true);
});

test('setBookingsPaused round-trips false (triangulation)', async () => {
  const model = createFakeConfigModel();
  model.setDoc({ bookingsPaused: true });

  await setBookingsPaused(false, COMPANY_A, { model });
  const paused = await getBookingsPaused(COMPANY_A, { model });

  assert.deepEqual(model.calls.findOneAndUpdate[0].update.$set, {
    bookingsPaused: false,
  });
  assert.equal(paused, false);
});
