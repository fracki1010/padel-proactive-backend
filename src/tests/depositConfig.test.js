'use strict';

// Unit tests for the per-company deposit settings (`deposit-config` capability):
// defaults, validation bounds and additive persistence. Persistence runs against
// an in-memory fake model so validation and "nothing persisted on invalid input"
// can be proven without a live MongoDB connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const AppConfig = require('../models/appConfig.model');
const {
  DEFAULT_DEPOSIT_ENABLED,
  DEFAULT_DEPOSIT_AMOUNT,
  DEFAULT_HOLD_MINUTES,
  validateDepositSettings,
  getDepositSettings,
  setDepositSettings,
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

// ── Validation ───────────────────────────────────────────────────────────────

test('validateDepositSettings accepts a valid enabled config', () => {
  const result = validateDepositSettings({
    depositEnabled: true,
    depositAmount: 5000,
    holdMinutes: 15,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.value, {
    depositEnabled: true,
    depositAmount: 5000,
    holdMinutes: 15,
  });
});

test('validateDepositSettings defaults holdMinutes to 15 when absent', () => {
  const result = validateDepositSettings({
    depositEnabled: true,
    depositAmount: 3000,
  });

  assert.equal(result.valid, true);
  assert.equal(result.value.holdMinutes, DEFAULT_HOLD_MINUTES);
  assert.equal(result.value.holdMinutes, 15);
});

test('validateDepositSettings rejects a zero amount when enabled', () => {
  const result = validateDepositSettings({
    depositEnabled: true,
    depositAmount: 0,
  });
  assert.equal(result.valid, false);
});

test('validateDepositSettings rejects a negative amount when enabled', () => {
  const result = validateDepositSettings({
    depositEnabled: true,
    depositAmount: -100,
  });
  assert.equal(result.valid, false);
});

test('validateDepositSettings rejects holdMinutes below 1', () => {
  assert.equal(
    validateDepositSettings({
      depositEnabled: true,
      depositAmount: 1000,
      holdMinutes: 0,
    }).valid,
    false,
  );
  assert.equal(
    validateDepositSettings({
      depositEnabled: true,
      depositAmount: 1000,
      holdMinutes: -5,
    }).valid,
    false,
  );
  assert.equal(
    validateDepositSettings({
      depositEnabled: true,
      depositAmount: 1000,
      holdMinutes: 2.5,
    }).valid,
    false,
  );
});

test('validateDepositSettings allows a disabled config with default amount', () => {
  const result = validateDepositSettings({ depositEnabled: false });

  assert.equal(result.valid, true);
  assert.equal(result.value.depositAmount, DEFAULT_DEPOSIT_AMOUNT);
  assert.equal(result.value.depositAmount, 0);
  assert.equal(result.value.holdMinutes, 15);
});

test('validateDepositSettings coerces numeric strings (triangulation)', () => {
  const result = validateDepositSettings({
    depositEnabled: true,
    depositAmount: '5000',
    holdMinutes: '20',
  });

  assert.equal(result.valid, true);
  assert.equal(result.value.depositAmount, 5000);
  assert.equal(result.value.holdMinutes, 20);
});

// ── Persistence ──────────────────────────────────────────────────────────────

test('setDepositSettings rejects an invalid amount without persisting', async () => {
  const model = createFakeConfigModel();

  await assert.rejects(
    setDepositSettings(
      { depositEnabled: true, depositAmount: 0 },
      COMPANY_A,
      { model },
    ),
    (error) => error.statusCode === 400,
  );

  assert.equal(model.calls.findOneAndUpdate.length, 0);
});

test('setDepositSettings persists only deposit fields (additive, no retroactivity)', async () => {
  const model = createFakeConfigModel();

  await setDepositSettings(
    { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 },
    COMPANY_A,
    { model },
  );

  assert.equal(model.calls.findOneAndUpdate.length, 1);
  const { update } = model.calls.findOneAndUpdate[0];
  assert.deepEqual(Object.keys(update.$set).sort(), [
    'depositAmount',
    'depositEnabled',
    'holdMinutes',
  ]);
});

test('getDepositSettings returns defaults for an empty config', async () => {
  const model = createFakeConfigModel();
  const settings = await getDepositSettings(COMPANY_A, { model });

  assert.deepEqual(settings, {
    depositEnabled: false,
    depositAmount: 0,
    holdMinutes: 15,
  });
});

test('getDepositSettings echoes stored values', async () => {
  const model = createFakeConfigModel();
  model.setDoc({ depositEnabled: true, depositAmount: 8000, holdMinutes: 30 });

  const settings = await getDepositSettings(COMPANY_A, { model });

  assert.deepEqual(settings, {
    depositEnabled: true,
    depositAmount: 8000,
    holdMinutes: 30,
  });
});

test('getDepositSettings scopes the query by companyId', async () => {
  const model = createFakeConfigModel();

  await getDepositSettings(COMPANY_B, { model });

  assert.equal(String(model.calls.findOne[0].companyId), COMPANY_B);
  assert.equal(model.calls.findOne[0].key, 'main');
});

// ── Model schema ─────────────────────────────────────────────────────────────

test('AppConfig exposes the deposit fields with safe defaults', () => {
  assert.equal(AppConfig.schema.path('depositEnabled').defaultValue, false);
  assert.equal(AppConfig.schema.path('depositAmount').defaultValue, 0);
  assert.equal(AppConfig.schema.path('holdMinutes').defaultValue, 15);
});
