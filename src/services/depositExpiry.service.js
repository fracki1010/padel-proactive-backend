'use strict';

// Deposit expiry sweeper. Mirrors attendanceConfirmation.service: a periodic,
// idempotent interval job. It cancels unpaid `pendiente_seña` bookings whose
// deadline passed, which frees the court through the existing non-cancelled
// unique index. Each transition goes through the atomic `expireDeposit` guard,
// so running the sweep repeatedly (or concurrently with the webhook) is safe.
//
// The scan is GLOBAL (not filtered by the company's current `depositEnabled`):
// a club that disables deposits must not leave outstanding holds holding courts
// forever. Each expiry is still scoped by the booking's own `companyId`.

const Booking = require('../models/booking.model');
const { isMongoConnected } = require('../config/database');
const { BOOKING_STATUS, DEPOSIT_STATUS, expireDeposit } = require('./deposit.service');

const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_BATCH_LIMIT = Number(process.env.DEPOSIT_EXPIRY_BATCH_LIMIT || 200);
const DEFAULT_NOTIFY_TIMEOUT_MS = Number(
  process.env.DEPOSIT_EXPIRY_NOTIFY_TIMEOUT_MS || 5000,
);

// Rejects NaN/zero/negative intervals instead of producing a busy loop.
const resolveCheckInterval = (raw) => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHECK_INTERVAL_MS;
};

const CHECK_INTERVAL_MS = resolveCheckInterval(process.env.DEPOSIT_EXPIRY_INTERVAL_MS);

let timer = null;
let isRunning = false;

// Lazily required so this module can be tested (and loaded) before the
// notification wiring exists.
const defaultNotifyExpired = async (payload) => {
  const { notifyDepositExpired } = require('./depositNotification.service');
  return notifyDepositExpired(payload);
};

// Bounds any single notification so a hung WhatsApp/DB call cannot leave the
// sweeper's `isRunning` flag set forever.
const withTimeout = (promise, ms) => {
  let timeoutTimer;
  const timeout = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error('notify_timeout')), ms);
    if (timeoutTimer && typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutTimer));
};

const notifyExpiredSafely = async (notifyExpired, payload, timeoutMs) => {
  try {
    await withTimeout(Promise.resolve().then(() => notifyExpired(payload)), timeoutMs);
  } catch (error) {
    console.error(
      `[DepositExpiry][${payload?.companyId || 'global'}] Error notificando expiración:`,
      error?.message || error,
    );
  }
};

const runDepositExpirySweep = async (options = {}) => {
  const connected = options.isMongoConnected
    ? options.isMongoConnected()
    : isMongoConnected();
  if (!connected) {
    console.warn('[DepositExpiry] Barrido omitido: MongoDB no está conectado.');
    return { skipped: true, reason: 'mongo_disconnected', expiredCount: 0, expiredIds: [] };
  }
  if (isRunning) {
    return { skipped: true, reason: 'already_running', expiredCount: 0, expiredIds: [] };
  }

  isRunning = true;
  const bookingModel = options.bookingModel || Booking;
  const now = options.now || new Date();
  const notifyExpired = options.notifyExpired || defaultNotifyExpired;
  const notifyTimeoutMs =
    Number.isInteger(options.notifyTimeoutMs) && options.notifyTimeoutMs > 0
      ? options.notifyTimeoutMs
      : DEFAULT_NOTIFY_TIMEOUT_MS;
  const batchLimit =
    Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : DEFAULT_BATCH_LIMIT;
  const expiredIds = [];

  try {
    let query = bookingModel.find({
      status: BOOKING_STATUS.PENDING_DEPOSIT,
      'deposit.status': DEPOSIT_STATUS.PENDING,
      'deposit.expiresAt': { $lt: now },
    });
    if (query && typeof query.limit === 'function') {
      query = query.limit(batchLimit);
    }
    const candidates = await query;

    for (const candidate of candidates || []) {
      const companyId = candidate.companyId || null;
      const result = await expireDeposit(
        { bookingId: candidate._id, companyId, now },
        { model: bookingModel },
      );
      if (!result.expired) continue;

      expiredIds.push(String(candidate._id));
      await notifyExpiredSafely(notifyExpired, { booking: result.booking, companyId }, notifyTimeoutMs);
    }

    return { skipped: false, expiredCount: expiredIds.length, expiredIds };
  } catch (error) {
    console.error('[DepositExpiry] Error en barrido:', error?.message || error);
    return {
      skipped: false,
      error: error?.message || String(error),
      expiredCount: expiredIds.length,
      expiredIds,
    };
  } finally {
    isRunning = false;
  }
};

const startDepositExpiryMonitor = () => {
  if (timer) return;
  timer = setInterval(runDepositExpirySweep, CHECK_INTERVAL_MS);
  runDepositExpirySweep().catch(() => {});
};

module.exports = {
  CHECK_INTERVAL_MS,
  DEFAULT_CHECK_INTERVAL_MS,
  resolveCheckInterval,
  runDepositExpirySweep,
  startDepositExpiryMonitor,
};
