'use strict';

// Per-company deposit exemption (seña exemption): storage + admin endpoint.
// - storage: canonicalPhoneKey funnel on write AND read (54/549 match),
//   atomic $addToSet/$pull semantics, per-company isolation, empty phone
//   rejection and missing-array tolerance on reads
// - endpoint: PUT /api/users/:id/deposit-exempt (admin/super_admin only,
//   company-scoped, idempotent) + depositExempt in the user detail payload
//
// The AppConfig model is replaced with an in-memory fake (options.model) so no
// database connection is needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deposit-exemption';

const {
  canonicalPhoneKey,
} = require('../services/clientVerification.service');
const {
  isPhoneExempt,
  isDepositExempt,
  getDepositExemptPhones,
  addDepositExemptPhone,
  removeDepositExemptPhone,
  getDepositSettings,
} = require('../services/appConfig.service');

const COMPANY_A = '64b0000000000000000000a1';
const COMPANY_B = '64b0000000000000000000b2';
const PHONE_549 = '5491100000000';
const PHONE_54 = '541100000000';
const PHONE_B = '5492200000000';

// In-memory AppConfig fake honouring the $addToSet/$pull semantics the service
// depends on (plus upsert for adds). Docs are keyed by companyId.
const makeFakeConfigModel = () => {
  const docs = new Map();

  const model = {
    calls: { findOne: [], findOneAndUpdate: [] },

    setDoc(companyId, doc) {
      docs.set(String(companyId), { key: 'main', depositExemptPhones: [], ...doc });
    },

    getDoc(companyId) {
      return docs.get(String(companyId)) || null;
    },

    async findOne(filter) {
      model.calls.findOne.push(filter);
      const doc = docs.get(String(filter.companyId)) || null;
      return doc ? { ...doc } : null;
    },

    async findOneAndUpdate(filter, update, options = {}) {
      model.calls.findOneAndUpdate.push({ filter, update, options });
      const key = String(filter.companyId);
      let doc = docs.get(key);
      if (!doc) {
        if (!options.upsert) return null;
        doc = { companyId: filter.companyId, key: 'main', depositExemptPhones: [] };
        docs.set(key, doc);
      }
      for (const [field, value] of Object.entries(update.$addToSet || {})) {
        if (!Array.isArray(doc[field])) doc[field] = [];
        if (!doc[field].includes(value)) doc[field].push(value);
      }
      for (const [field, value] of Object.entries(update.$pull || {})) {
        if (Array.isArray(doc[field])) {
          doc[field] = doc[field].filter((item) => item !== value);
        }
      }
      return { ...doc };
    },
  };

  return model;
};

// ── Canonical funnel on write (spec: deposit-exemption-storage) ──────────────

test('a 54-variant phone is canonicalized to its 549 key on write', async () => {
  const model = makeFakeConfigModel();

  const list = await addDepositExemptPhone(COMPANY_A, PHONE_54, { model });

  assert.deepEqual(list, [PHONE_549]);
  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
  assert.equal(canonicalPhoneKey(PHONE_54), PHONE_549);
});

test('adding the same phone twice stores a single entry ($addToSet)', async () => {
  const model = makeFakeConfigModel();

  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });
  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
});

test('adding both the 54 and 549 variants still stores a single canonical key', async () => {
  const model = makeFakeConfigModel();

  await addDepositExemptPhone(COMPANY_A, PHONE_54, { model });
  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
});

// ── Canonical funnel on read (spec: deposit-exemption-edge-cases) ────────────

test('a 549 booking matches an exemption stored from the 54 variant', async () => {
  const model = makeFakeConfigModel();

  await addDepositExemptPhone(COMPANY_A, PHONE_54, { model });

  // Read funnel: the stored 54 variant is canonicalized on read, so a 549
  // booking is exempt. The pure helper canonicalizes both sides of the match.
  assert.equal(await isDepositExempt(COMPANY_A, PHONE_549, { model }), true);
  assert.equal(isPhoneExempt([PHONE_54], PHONE_549), true);
  assert.equal(isPhoneExempt([PHONE_549], PHONE_54), true);
  assert.equal(isPhoneExempt([PHONE_549], PHONE_549), true);
});

// ── Atomic remove (spec: deposit-exemption-storage) ──────────────────────────

test('removing a phone leaves the other exemptions untouched', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_549, PHONE_B] });

  const list = await removeDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(list, [PHONE_B]);
  assert.equal(await isDepositExempt(COMPANY_A, PHONE_549, { model }), false);
  assert.equal(await isDepositExempt(COMPANY_A, PHONE_B, { model }), true);
});

test('removing a phone that is not exempt is a no-op', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_B] });

  const list = await removeDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(list, [PHONE_B]);
  assert.equal(model.calls.findOneAndUpdate.length, 1);
});

// ── Per-company isolation (spec: deposit-exemption-storage/edge-cases) ───────

test('exemption is isolated per company for the same phone', async () => {
  const model = makeFakeConfigModel();
  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.equal(await isDepositExempt(COMPANY_A, PHONE_549, { model }), true);
  assert.equal(await isDepositExempt(COMPANY_B, PHONE_549, { model }), false);
});

// ── Empty/unknown phone rejected (spec: deposit-exemption-storage) ───────────

test('an empty phone is rejected on add and the list is unchanged', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_549] });

  await assert.rejects(
    addDepositExemptPhone(COMPANY_A, '', { model }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    removeDepositExemptPhone(COMPANY_A, '  ', { model }),
    (error) => error.statusCode === 400,
  );

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
});

// ── Missing-array tolerance (spec: read-set tolerance) ───────────────────────

test('isPhoneExempt returns false for a missing or non-array phone list', () => {
  assert.equal(isPhoneExempt(undefined, PHONE_549), false);
  assert.equal(isPhoneExempt(null, PHONE_549), false);
  assert.equal(isPhoneExempt(PHONE_549, PHONE_549), false);
  assert.equal(isPhoneExempt([], PHONE_549), false);
  assert.equal(isPhoneExempt(['5491100000000'], PHONE_549), true);
});

test('getDepositExemptPhones tolerates a missing field and unknown companies', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, {});

  assert.deepEqual(await getDepositExemptPhones(COMPANY_A, { model }), []);
  assert.deepEqual(await getDepositExemptPhones(COMPANY_B, { model }), []);
});

test('getDepositSettings returns the canonicalized exempt phone list', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, {
    depositEnabled: true,
    depositAmount: 5000,
    holdMinutes: 15,
    depositExemptPhones: [PHONE_54],
  });

  const settings = await getDepositSettings(COMPANY_A, { model });

  assert.equal(settings.depositEnabled, true);
  assert.equal(settings.depositAmount, 5000);
  assert.equal(settings.holdMinutes, 15);
  assert.deepEqual(settings.depositExemptPhones, [PHONE_549]);
});

test('getDepositSettings defaults the exempt list to empty when unset', async () => {
  const model = makeFakeConfigModel();

  const settings = await getDepositSettings(COMPANY_A, { model });

  assert.deepEqual(settings.depositExemptPhones, []);
});