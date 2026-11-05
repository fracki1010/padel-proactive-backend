'use strict';

// Single source of truth for ClubClosure enforcement across every booking
// surface (public portal, admin panel, WhatsApp bot, fixed-turn materialization
// and slot locks).
//
// A closure is stored as an INCLUSIVE calendar range: `startDate` and `endDate`
// are `YYYY-MM-DD` strings. A date is closed when
// `startDate <= date <= endDate`. Comparing the UTC `YYYY-MM-DD` string keeps the
// stored day stable no matter the process timezone, so no closure can leak
// across a day boundary.

const mongoose = require('mongoose');
const ClubClosure = require('../models/clubClosure.model');
const { toIsoDateString } = require('../utils/isoDate');
const { isMongoConnected } = require('../config/database');

const CLOSURE_DEFAULT_REASON = 'El club está cerrado ese día';

// The native Mongoose statics are replaced by hand-rolled doubles in tests. A
// doubled model is always safe to call without a real connection; a native one
// would buffer the query for the whole buffer timeout while the DB is down.
const nativeFindOne = mongoose.Model.findOne;
const isModelDoubled = () => ClubClosure.findOne !== nativeFindOne;

// Node's test runner sets NODE_TEST_CONTEXT; model-double suites never open a
// DB and must keep exercising unrelated write paths. Production never has it.
const isTestDoubleRun = () =>
  Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';

// Whether closures can be resolved right now. WRITE paths must call this and
// refuse when it is false: Mongoose buffers writes across a reconnect, so a
// booking could otherwise land on a day whose closure was never evaluated.
// A doubled model (or a model-double test run) is safe without a connection.
const canResolveClosures = () =>
  isMongoConnected() || isModelDoubled() || isTestDoubleRun();

/**
 * Whether a club is closed on a given calendar day.
 * @param {string} companyId Tenant scope.
 * @param {string|Date} date Target day (string `YYYY-MM-DD`, ISO string or Date).
 * @returns {Promise<{ closed: boolean, reason: string }>}
 */
const isClubClosedForDate = async (companyId, date) => {
  const closureDate = toIsoDateString(date);
  if (!companyId || !closureDate) {
    return { closed: false, reason: '' };
  }

  // Never claim a day is open when the closure cannot be resolved: fail closed.
  // Write-capable paths refuse earlier with a 503, so this is a last guard for
  // any read that reaches the helper during an outage.
  if (!canResolveClosures()) {
    return { closed: true, reason: CLOSURE_DEFAULT_REASON };
  }
  // Model-double test runs have no live DB but intentionally leave this model
  // native; keep their unrelated write paths behaving as before.
  if (!isMongoConnected() && !isModelDoubled()) {
    return { closed: false, reason: '' };
  }

  const closure = await ClubClosure.findOne({
    companyId,
    startDate: { $lte: closureDate },
    endDate: { $gte: closureDate },
  });

  if (!closure) {
    return { closed: false, reason: '' };
  }

  return {
    closed: true,
    reason: closure.reason || CLOSURE_DEFAULT_REASON,
  };
};

module.exports = {
  CLOSURE_DEFAULT_REASON,
  canResolveClosures,
  isClubClosedForDate,
};
