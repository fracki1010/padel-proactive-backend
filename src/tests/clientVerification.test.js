'use strict';

// Unit tests for the verified-client domain helpers. A client is "verified"
// when a ClientAccount is linked to its User (linkedUserId -> User._id). These
// helpers are pure so the phone-lock decision can be exercised without a live
// MongoDB connection.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVerifiedUserIdSet,
  isUserVerified,
  canonicalPhoneKey,
  isPhoneChangeRequested,
  shouldBlockVerifiedPhoneEdit,
} = require('../services/clientVerification.service');

// ── buildVerifiedUserIdSet / isUserVerified ─────────────────────────────────

test('buildVerifiedUserIdSet ignora cuentas sin linkedUserId y normaliza ids', () => {
  const accounts = [
    { _id: 'acc-1', linkedUserId: 'u-1' },
    { _id: 'acc-2', linkedUserId: null },
    { _id: 'acc-3' },
    { _id: 'acc-4', linkedUserId: 'u-2' },
  ];

  const verifiedIds = buildVerifiedUserIdSet(accounts);

  assert.equal(verifiedIds.has('u-1'), true);
  assert.equal(verifiedIds.has('u-2'), true);
  assert.equal(verifiedIds.has('acc-3'), false);
  assert.equal(verifiedIds.size, 2);
});

test('buildVerifiedUserIdSet acepta ObjectIds y strings indistintamente', () => {
  const objectIdLike = { toString: () => 'u-9' };
  const verifiedIds = buildVerifiedUserIdSet([{ linkedUserId: objectIdLike }]);

  assert.equal(verifiedIds.has('u-9'), true);
});

test('isUserVerified distingue socios vinculados de no vinculados', () => {
  const verifiedIds = buildVerifiedUserIdSet([{ linkedUserId: 'u-1' }]);

  assert.equal(isUserVerified({ _id: 'u-1', name: 'Ana' }, verifiedIds), true);
  assert.equal(isUserVerified({ _id: 'u-2', name: 'Bruno' }, verifiedIds), false);
});

test('isUserVerified devuelve false sin id o sin set', () => {
  assert.equal(isUserVerified(null, buildVerifiedUserIdSet([])), false);
  assert.equal(isUserVerified({ name: 'Sin id' }, buildVerifiedUserIdSet([])), false);
});

// ── canonicalPhoneKey ───────────────────────────────────────────────────────

test('canonicalPhoneKey unifica formatos y el 9 argentino', () => {
  assert.equal(canonicalPhoneKey('5492622517447'), '5492622517447');
  assert.equal(canonicalPhoneKey('5492622517447@c.us'), '5492622517447');
  assert.equal(canonicalPhoneKey('542622517447'), '5492622517447');
  assert.equal(canonicalPhoneKey('+54 9 262 251 7447'), '5492622517447');
  assert.equal(canonicalPhoneKey('59891234567'), '59891234567');
});

// ── isPhoneChangeRequested ──────────────────────────────────────────────────

test('isPhoneChangeRequested no marca cambio cuando el teléfono es equivalente', () => {
  assert.equal(isPhoneChangeRequested('5492622517447', '5492622517447'), false);
  assert.equal(isPhoneChangeRequested('5492622517447', '542622517447'), false);
  assert.equal(isPhoneChangeRequested('5492622517447', undefined), false);
  assert.equal(isPhoneChangeRequested('5492622517447', null), false);
});

test('isPhoneChangeRequested marca cambio cuando el teléfono difiere', () => {
  assert.equal(isPhoneChangeRequested('5492622517447', '5491111222333'), true);
  assert.equal(isPhoneChangeRequested('5492622517447', ''), true);
});

// ── shouldBlockVerifiedPhoneEdit ────────────────────────────────────────────

test('shouldBlockVerifiedPhoneEdit bloquea solo a verificados con cambio real', () => {
  assert.equal(
    shouldBlockVerifiedPhoneEdit({
      isVerified: true,
      currentPhone: '5492622517447',
      nextPhone: '5491111222333',
    }),
    true,
  );
  assert.equal(
    shouldBlockVerifiedPhoneEdit({
      isVerified: true,
      currentPhone: '5492622517447',
      nextPhone: '542622517447',
    }),
    false,
  );
  assert.equal(
    shouldBlockVerifiedPhoneEdit({
      isVerified: true,
      currentPhone: '5492622517447',
      nextPhone: undefined,
    }),
    false,
  );
  assert.equal(
    shouldBlockVerifiedPhoneEdit({
      isVerified: false,
      currentPhone: '5492622517447',
      nextPhone: '5491111222333',
    }),
    false,
  );
});
