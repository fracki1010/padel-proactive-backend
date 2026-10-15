'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { phoneCandidates, isQaUser, phoneLooseRegex } = require('../utils/phoneMatch');

test('phoneCandidates covers the 549 / 54 / local shapes', () => {
  const c = phoneCandidates('5492622517447');
  assert.ok(c.includes('5492622517447'));
  assert.ok(c.includes('542622517447'));
  assert.ok(c.includes('2622517447'));
});

test('phoneCandidates from a local number builds the country-code forms', () => {
  const c = phoneCandidates('2622517447');
  assert.ok(c.includes('2622517447'));
  assert.ok(c.includes('5492622517447'));
  assert.ok(c.includes('542622517447'));
});

test('phoneCandidates ignores separators and the plus sign', () => {
  const c = phoneCandidates('+54 9 262 251-7447');
  assert.deepEqual(c.sort(), ['2622517447', '542622517447', '5492622517447'].sort());
});

test('phoneCandidates returns empty for junk', () => {
  assert.deepEqual(phoneCandidates(''), []);
  assert.deepEqual(phoneCandidates('abc'), []);
});

test('isQaUser flags qa- tagged whatsapp ids only', () => {
  assert.equal(isQaUser({ whatsappId: 'qa-suite:12:FL-01:1777298790517' }), true);
  assert.equal(isQaUser({ whatsappId: 'qa-defensive-server:15:1:0' }), true);
  assert.equal(isQaUser({ whatsappId: '5492622517447@c.us' }), false);
  assert.equal(isQaUser({ whatsappId: '' }), false);
  assert.equal(isQaUser({}), false);
});

test('phoneLooseRegex matches the same number with separators', () => {
  const re = phoneLooseRegex('5492622517447');
  assert.ok(re.test('5492622517447'));
  assert.ok(re.test('+54 9 262 251 7447'));
  assert.ok(re.test('2622517447'));
  assert.equal(re.test('5492622510000'), false);
});
