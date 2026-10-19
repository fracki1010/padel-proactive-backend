'use strict';

// Anti-reuse ledger for payment receipts.
//
// A receipt is identified by one or more keys: the SHA-256 of the uploaded file
// and (when the reader extracts it) the bank's operation id. Claiming inserts one
// row per key under a UNIQUE (companyId, key) index, so:
//   - the same file (or the same operation) can never confirm two bookings;
//   - concurrent duplicates are resolved atomically by the database.
//
// If the confirmation fails after claiming, `releaseClaims` removes the rows so a
// legitimate retry is not blocked.

const crypto = require('crypto');
const ReceiptClaim = require('../models/receiptClaim.model');
const { isMongoConnected } = require('../config/database');

const hashBuffer = (buffer) =>
  crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex');

// Builds the claim keys for a receipt. `operationId` is optional.
const buildReceiptKeys = ({ buffer, operationId } = {}) => {
  const keys = [];
  if (buffer && buffer.length) keys.push(`img:${hashBuffer(buffer)}`);
  const op = String(operationId || '').trim();
  if (op) keys.push(`op:${op}`);
  return keys;
};

const isDuplicateKeyError = (error) =>
  Boolean(error) && (error.code === 11000 || error.code === 11001);

// Claims every key. Returns { ok:true, keys } or { ok:false, duplicate, keys }.
// On a duplicate (or any failure) everything inserted in this call is rolled back.
const claimReceipt = async ({ companyId, bookingId, keys = [] } = {}, options = {}) => {
  const model = (options && options.model) || ReceiptClaim;
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (!uniqueKeys.length) return { ok: true, keys: [] };
  // Sin Mongo (tests / base caída) no se puede reclamar: no bloquear el flujo.
  if (!(options && options.model) && !isMongoConnected()) {
    return { ok: true, keys: uniqueKeys, skipped: true };
  }

  const inserted = [];
  try {
    for (const key of uniqueKeys) {
      await model.create({ companyId, bookingId, key });
      inserted.push(key);
    }
    return { ok: true, keys: uniqueKeys };
  } catch (error) {
    await releaseClaims({ companyId, keys: inserted }, options).catch(() => {});
    if (isDuplicateKeyError(error)) {
      return { ok: false, duplicate: true, keys: uniqueKeys };
    }
    return { ok: false, duplicate: false, error, keys: uniqueKeys };
  }
};

const releaseClaims = async ({ companyId, keys = [] } = {}, options = {}) => {
  const model = (options && options.model) || ReceiptClaim;
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (!uniqueKeys.length) return { released: 0 };
  if (!(options && options.model) && !isMongoConnected()) return { released: 0, skipped: true };
  const result = await model.deleteMany({ companyId, key: { $in: uniqueKeys } });
  return { released: Number(result?.deletedCount || 0) };
};

module.exports = {
  buildReceiptKeys,
  claimReceipt,
  hashBuffer,
  releaseClaims,
};
