'use strict';

// Deposit expiry sweeper. Mirrors attendanceConfirmation.service: a periodic,
// per-company, idempotent interval job. It cancels unpaid `pendiente_seña`
// bookings whose deadline passed, which frees the court through the existing
// non-cancelled unique index. Each transition goes through the atomic
// `expireDeposit` guard, so running the sweep repeatedly (or concurrently with
// the webhook) is safe.

const AppConfig = require('../models/appConfig.model');
const Booking = require('../models/booking.model');
const { isMongoConnected } = require('../config/database');
const { BOOKING_STATUS, DEPOSIT_STATUS, expireDeposit } = require('./deposit.service');

const CONFIG_KEY = 'main';
const CHECK_INTERVAL_MS = Number(
  process.env.DEPOSIT_EXPIRY_INTERVAL_MS || 60 * 1000,
);

let timer = null;
let isRunning = false;

// Lazily required so this module can be tested (and loaded) before the
// notification wiring exists.
const defaultNotifyExpired = async (payload) => {
  const { notifyDepositExpired } = require('./depositNotification.service');
  return notifyDepositExpired(payload);
};

const getEnabledCompanyIds = async (configModel = AppConfig) => {
  const query = configModel.find({ key: CONFIG_KEY, depositEnabled: true });
  const configs =
    query && typeof query.select === 'function'
      ? await query.select('companyId')
      : await query;
  return (configs || []).map((config) => config.companyId || null);
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
  const configModel = options.configModel || AppConfig;
  const now = options.now || new Date();
  const notifyExpired = options.notifyExpired || defaultNotifyExpired;
  const expiredIds = [];

  try {
    const companyIds = await getEnabledCompanyIds(configModel);
    for (const companyId of companyIds) {
      const candidates = await bookingModel.find({
        companyId,
        status: BOOKING_STATUS.PENDING_DEPOSIT,
        'deposit.status': DEPOSIT_STATUS.PENDING,
        'deposit.expiresAt': { $lt: now },
      });

      for (const candidate of candidates || []) {
        const result = await expireDeposit(
          { bookingId: candidate._id, companyId, now },
          { model: bookingModel },
        );
        if (!result.expired) continue;

        expiredIds.push(String(candidate._id));
        try {
          await notifyExpired({ booking: result.booking, companyId });
        } catch (error) {
          console.error(
            `[DepositExpiry][${companyId || 'global'}] Error notificando expiración:`,
            error?.message || error,
          );
        }
      }
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
  getEnabledCompanyIds,
  runDepositExpirySweep,
  startDepositExpiryMonitor,
};
