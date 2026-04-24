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

// Country codes sorted longest-first to avoid partial matches (e.g. "598" before "56").
const COUNTRY_CODES = ["598", "595", "591", "54", "56", "55", "52", "34", "1"];

// Strips country code and leading mobile "9" for displaying admin phone to clients.
// "5492622517447" → "2622517447", "569XXXXXXXX" → "XXXXXXXX"
const stripPhoneForClientDisplay = (rawPhone = "") => {
  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (!digits) return "";
  for (const code of COUNTRY_CODES) {
    if (digits.startsWith(code)) {
      const local = digits.slice(code.length);
      return local.startsWith("9") ? local.slice(1) : local;
    }
  }
  return digits;
};

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
  stripPhoneForClientDisplay,
};
