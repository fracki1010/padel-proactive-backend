const {
  normalizeClientIdentity,
  normalizePhoneDigits,
  normalizeWhatsappId,
  toE164,
} = require("../whatsapp/domain/clientIdentity");
const { matchBookingsByClient: matchBookingsByIdentity } = require("../services/bookingMatching.service");

const normalizePhone = (value = "") => normalizePhoneDigits(value);

const normalizeWhatsappIdValue = (value = "") => normalizeWhatsappId(value);

const normalizeWhatsappIdKey = (value = "") => {
  const normalized = normalizeWhatsappId(value);
  if (!normalized) return "";
  const digits = normalizePhoneDigits(normalized);
  if (digits) return `phone:${digits}`;
  if (normalized.includes("@")) return `wa:${normalized.split("@")[0]}`;
  return `wa:${normalized}`;
};

const normalizeChatIdKey = (value = "") => normalizeWhatsappIdKey(value);

const normalizeCanonicalClientPhone = (...values) => {
  for (const value of values) {
    const digits = normalizePhoneDigits(value);
    if (digits) return digits;
  }
  return "";
};

const buildWhatsappKeys = (...values) => {
  const identity = normalizeClientIdentity({
    whatsappId: values[0] || "",
    chatId: values[1] || "",
    canonicalClientPhone: values[2] || "",
    phone: values[3] || "",
  });
  return identity.whatsappKeys;
};

const buildClientIdentity = (input = {}) => normalizeClientIdentity(input);

const matchClientIdentity = (left = {}, right = {}) => {
  const result = matchBookingsByIdentity(left, [{ ...right, _id: "compare" }]);
  const audit = result.audits[0] || {};
  return {
    matched: Boolean(audit.matched),
    byWhatsapp: Boolean(audit.byWhatsapp),
    byPhone: Boolean(audit.byPhone),
    reason: audit.reason || "no_match.identity_mismatch",
  };
};

const matchBookingsByClient = ({ bookings = [], client = {} } = {}) =>
  matchBookingsByIdentity(client, bookings);

const findMatchingBookingsWithAudit = (bookings = [], requestIdentity = {}) =>
  matchBookingsByIdentity(requestIdentity, bookings);

module.exports = {
  normalizePhone,
  toE164,
  normalizeWhatsappIdValue,
  normalizeWhatsappIdKey,
  normalizeChatIdKey,
  normalizeCanonicalClientPhone,
  normalizeClientIdentity,
  buildClientIdentity,
  buildWhatsappKeys,
  matchClientIdentity,
  matchBookingsByClient,
  findMatchingBookingsWithAudit,
};
