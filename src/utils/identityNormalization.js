const TRANSPORT_PREFIX_REGEX = /^([a-z_-]+):(.*)$/i;

const normalizeRaw = (value = "") => String(value || "").trim().toLowerCase();

const unwrapTransportPrefix = (value = "") => {
  const raw = normalizeRaw(value);
  if (!raw) return "";

  const match = raw.match(TRANSPORT_PREFIX_REGEX);
  if (!match) return raw;

  const prefix = String(match[1] || "").trim();
  const rest = String(match[2] || "").trim();
  if (!rest) return raw;

  // Prefijos de entorno QA / transporte interno (ej: qa-defensive-server:...)
  if (prefix && !/\d/.test(prefix)) {
    return rest;
  }

  return raw;
};

const stripWhatsappDomain = (value = "") => {
  const raw = unwrapTransportPrefix(value);
  if (!raw) return "";
  const atIndex = raw.indexOf("@");
  if (atIndex < 0) return raw;
  return raw.slice(0, atIndex);
};

const normalizePhone = (value = "") => {
  const local = stripWhatsappDomain(value);
  const digits = String(local || "").replace(/\D/g, "");
  return digits;
};

const normalizeWhatsappIdValue = (value = "") => {
  const raw = unwrapTransportPrefix(value);
  if (!raw) return "";

  if (!raw.includes("@")) {
    const digits = normalizePhone(raw);
    return digits || raw.replace(/\s+/g, "");
  }

  const [localPart, domainPart] = raw.split("@");
  const local = String(localPart || "").trim();
  const domain = String(domainPart || "").trim();
  if (!local) return "";
  if (!domain) return local;
  return `${local}@${domain}`;
};

const normalizeWhatsappIdKey = (value = "") => {
  const normalizedValue = normalizeWhatsappIdValue(value);
  if (!normalizedValue) return "";

  const local = stripWhatsappDomain(normalizedValue);
  const digits = String(local || "").replace(/\D/g, "");
  if (digits) return `num:${digits}`;
  return `id:${String(local || "").trim()}`;
};

const normalizeChatIdKey = (value = "") => normalizeWhatsappIdKey(value);

const normalizeCanonicalClientPhone = (...values) => {
  for (const value of values) {
    const normalized = normalizePhone(value);
    if (normalized) return normalized;
  }
  return "";
};

const buildClientIdentity = ({
  phone = "",
  whatsappId = "",
  chatId = "",
  canonicalClientPhone = "",
} = {}) => {
  const whatsappSource = whatsappId || chatId || "";
  const whatsappKey = normalizeWhatsappIdKey(whatsappSource);
  const normalizedWhatsappValue = normalizeWhatsappIdValue(whatsappSource);
  const canonicalPhone = normalizeCanonicalClientPhone(
    canonicalClientPhone,
    phone,
    chatId,
    whatsappId,
  );

  return {
    canonicalPhone,
    whatsappKey,
    whatsappValue: normalizedWhatsappValue,
  };
};

const matchClientIdentity = (left = {}, right = {}) => {
  const byWhatsapp =
    Boolean(left.whatsappKey) &&
    Boolean(right.whatsappKey) &&
    left.whatsappKey === right.whatsappKey;
  const byPhone =
    Boolean(left.canonicalPhone) &&
    Boolean(right.canonicalPhone) &&
    left.canonicalPhone === right.canonicalPhone;
  const matched = byWhatsapp || byPhone;

  return {
    matched,
    byWhatsapp,
    byPhone,
    reason: matched
      ? byWhatsapp
        ? "match.whatsappId"
        : "match.canonicalPhone"
      : "no_match.identity_mismatch",
  };
};

const findMatchingBookingsWithAudit = (bookings = [], requestIdentity = {}) => {
  const audits = bookings.map((booking) => {
    const bookingIdentity = buildClientIdentity({
      phone: booking?.clientPhone || "",
      whatsappId: booking?.clientWhatsappId || "",
      chatId: booking?.clientWhatsappId || "",
      canonicalClientPhone: booking?.clientPhone || "",
    });
    const match = matchClientIdentity(bookingIdentity, requestIdentity);
    return {
      booking,
      bookingIdentity,
      ...match,
    };
  });

  const byWhatsapp = audits.filter((item) => item.byWhatsapp);
  if (byWhatsapp.length) {
    return {
      matchedBookings: byWhatsapp.map((item) => item.booking),
      audits,
      strategy: "whatsappId",
    };
  }

  const byPhone = audits.filter((item) => item.byPhone);
  if (byPhone.length) {
    return {
      matchedBookings: byPhone.map((item) => item.booking),
      audits,
      strategy: "canonicalPhone",
    };
  }

  return {
    matchedBookings: [],
    audits,
    strategy: "no_match",
  };
};

module.exports = {
  normalizePhone,
  normalizeWhatsappIdValue,
  normalizeWhatsappIdKey,
  normalizeChatIdKey,
  normalizeCanonicalClientPhone,
  buildClientIdentity,
  matchClientIdentity,
  findMatchingBookingsWithAudit,
};
