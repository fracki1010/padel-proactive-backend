'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReceiptKeys, claimReceipt, hashBuffer, releaseClaims } = require('../services/receiptLedger.service');

// In-memory stand-in with the same unique (companyId, key) contract.
const makeModel = () => {
  const rows = [];
  return {
    rows,
    async create(doc) {
      if (rows.some((r) => r.companyId === doc.companyId && r.key === doc.key)) {
        const err = new Error('duplicate');
        err.code = 11000;
        throw err;
      }
      rows.push({ ...doc });
      return doc;
    },
    async deleteMany({ companyId, key }) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].companyId === companyId && key.$in.includes(rows[i].key)) rows.splice(i, 1);
      }
      return { deletedCount: before - rows.length };
    },
  };
};

test('buildReceiptKeys uses the file hash and the operation id', () => {
  const keys = buildReceiptKeys({ buffer: Buffer.from('abc'), operationId: 'OP-1' });
  assert.equal(keys.length, 2);
  assert.ok(keys[0].startsWith('img:'));
  assert.equal(keys[1], 'op:OP-1');
});

test('hashBuffer is stable and ignores empty input', () => {
  assert.equal(hashBuffer(Buffer.from('abc')), hashBuffer(Buffer.from('abc')));
  assert.notEqual(hashBuffer(Buffer.from('abc')), hashBuffer(Buffer.from('abd')));
  assert.equal(hashBuffer(null), hashBuffer(Buffer.alloc(0)));
});

test('the same receipt cannot be claimed twice', async () => {
  const model = makeModel();
  const first = await claimReceipt(
    { companyId: 'c1', bookingId: 'b1', keys: ['img:x'] },
    { model },
  );
  assert.equal(first.ok, true);

  const second = await claimReceipt(
    { companyId: 'c1', bookingId: 'b2', keys: ['img:x'] },
    { model },
  );
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
});

test('claims are scoped per company', async () => {
  const model = makeModel();
  assert.equal((await claimReceipt({ companyId: 'c1', bookingId: 'b1', keys: ['img:x'] }, { model })).ok, true);
  assert.equal((await claimReceipt({ companyId: 'c2', bookingId: 'b2', keys: ['img:x'] }, { model })).ok, true);
});

test('releasing a claim lets the client retry', async () => {
  const model = makeModel();
  await claimReceipt({ companyId: 'c1', bookingId: 'b1', keys: ['img:x'] }, { model });
  await releaseClaims({ companyId: 'c1', keys: ['img:x'] }, { model });
  const retry = await claimReceipt({ companyId: 'c1', bookingId: 'b1', keys: ['img:x'] }, { model });
  assert.equal(retry.ok, true);
});
