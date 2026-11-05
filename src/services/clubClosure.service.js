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

  // Fail open when the DB is down and no double replaced the model: every other
  // read on the request buffers too, and the write paths already refuse first.
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

module.exports = { CLOSURE_DEFAULT_REASON, isClubClosedForDate };
