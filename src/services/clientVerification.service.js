'use strict';

// Verified-client domain helpers.
//
// A client counts as "verified" when a ClientAccount is linked to its User
// (ClientAccount.linkedUserId -> User._id). These helpers stay pure so the
// phone-lock decision can be unit-tested without a live MongoDB connection.

const {
  normalizeCanonicalClientPhone,
} = require("../utils/identityNormalization");
const { canonicalizePhone } = require("./clientAuth.service");

const toIdString = (value) => (value == null ? "" : String(value));

// Builds the set of User ids that have at least one linked ClientAccount.
const buildVerifiedUserIdSet = (accounts = []) => {
  const verifiedIds = new Set();
  for (const account of accounts) {
    const linkedUserId = account && account.linkedUserId;
    if (linkedUserId == null) continue;
    const id = toIdString(linkedUserId);
    if (id) verifiedIds.add(id);
  }
  return verifiedIds;
};

const isUserVerified = (user, verifiedIds) => {
  if (!(verifiedIds instanceof Set)) return false;
  const id = toIdString(user && user._id);
  return Boolean(id) && verifiedIds.has(id);
};

// Canonical key used to compare two phone representations. Applies the shared
// digit normalization plus the Argentine mobile "9" canonicalization.
const canonicalPhoneKey = (phone = "") =>
  canonicalizePhone(normalizeCanonicalClientPhone(phone));

// Returns true only when a phone field is present and resolves to a different
// number than the current one. `undefined`/`null` mean "not provided".
const isPhoneChangeRequested = (currentPhone = "", nextPhone) => {
  if (nextPhone === undefined || nextPhone === null) return false;
  return canonicalPhoneKey(currentPhone) !== canonicalPhoneKey(nextPhone);
};

const shouldBlockVerifiedPhoneEdit = ({
  isVerified,
  currentPhone,
  nextPhone,
} = {}) => Boolean(isVerified) && isPhoneChangeRequested(currentPhone, nextPhone);

module.exports = {
  toIdString,
  buildVerifiedUserIdSet,
  isUserVerified,
  canonicalPhoneKey,
  isPhoneChangeRequested,
  shouldBlockVerifiedPhoneEdit,
};
