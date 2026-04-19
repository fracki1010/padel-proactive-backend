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
  return String(local || "").replace(/\D/g, "");
};

const toE164 = (digits = "") => {
  const clean = String(digits || "").replace(/\D/g, "");
  if (!clean) return "";
  return `+${clean}`;
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
  if (digits) return `phone:${digits}`;
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

const appendKey = (set, key) => {
  const clean = String(key || "").trim();
  if (clean) set.add(clean);
};

const buildWhatsappKeys = (...values) => {
  const keys = new Set();

  for (const rawValue of values) {
    const raw = unwrapTransportPrefix(rawValue);
    if (!raw) continue;

    const normalizedId = normalizeWhatsappIdValue(raw);
    if (!normalizedId) continue;

    const digitsAny = normalizePhone(raw);
    if (digitsAny) appendKey(keys, `phone:${digitsAny}`);

    if (normalizedId.includes("@")) {
      const [localPart, domainPart] = normalizedId.split("@");
      const local = String(localPart || "").trim();
      const domain = String(domainPart || "").trim();
      if (local && domain) {
        appendKey(keys, `wid:${local}@${domain}`);
      }
      if (local) {
        appendKey(keys, `local:${local}`);
        const localDigits = String(local).replace(/\D/g, "");
        if (localDigits) {
          appendKey(keys, `phone:${localDigits}`);
        }
      }
      continue;
    }

    appendKey(keys, `local:${normalizedId}`);
    if (!digitsAny) {
      appendKey(keys, `id:${normalizedId}`);
    }
  }

  return [...keys];
};

const normalizeClientIdentity = (input = {}) => {
  const phone = input?.phone || "";
  const whatsappId = input?.whatsappId || "";
  const chatId = input?.chatId || "";
  const canonicalClientPhone = input?.canonicalClientPhone || "";

  const canonicalPhoneDigits = normalizeCanonicalClientPhone(
    canonicalClientPhone,
    phone,
    whatsappId,
    chatId,
  );

  const normalizedWhatsappId = normalizeWhatsappIdValue(whatsappId || chatId || "");
  const whatsappKeys = buildWhatsappKeys(whatsappId, chatId, canonicalPhoneDigits, phone);

  return {
    canonicalPhone: toE164(canonicalPhoneDigits),
    canonicalPhoneDigits,
    whatsappId: normalizedWhatsappId,
    whatsappKeys,
  };
};

const buildClientIdentity = (input = {}) => normalizeClientIdentity(input);

const intersectKeys = (left = [], right = []) => {
  const rightSet = new Set(right || []);
  return (left || []).filter((key) => rightSet.has(key));
};

const buildMismatchReason = ({ hasWhatsappMismatch, hasPhoneMismatch, hasComparableFields }) => {
  if (!hasComparableFields) return "request_identity_empty";
  if (hasWhatsappMismatch && hasPhoneMismatch) return "whatsapp_mismatch+phone_mismatch";
  if (hasWhatsappMismatch) return "whatsapp_mismatch";
  if (hasPhoneMismatch) return "phone_mismatch";
  return "no_match.identity_mismatch";
};

const matchIdentityPair = (bookingIdentity = {}, requestIdentity = {}) => {
  const commonWhatsappKeys = intersectKeys(
    bookingIdentity.whatsappKeys,
    requestIdentity.whatsappKeys,
  );

  const byWhatsapp = commonWhatsappKeys.length > 0;
  const byPhone =
    Boolean(bookingIdentity.canonicalPhoneDigits) &&
    Boolean(requestIdentity.canonicalPhoneDigits) &&
    bookingIdentity.canonicalPhoneDigits === requestIdentity.canonicalPhoneDigits;
  const matched = byWhatsapp || byPhone;

  const hasComparableWhatsapp =
    (bookingIdentity.whatsappKeys || []).length > 0 &&
    (requestIdentity.whatsappKeys || []).length > 0;
  const hasComparablePhone =
    Boolean(bookingIdentity.canonicalPhoneDigits) &&
    Boolean(requestIdentity.canonicalPhoneDigits);

  const reason = matched
    ? byWhatsapp
      ? "match.whatsapp"
      : "match.phone"
    : buildMismatchReason({
        hasWhatsappMismatch: hasComparableWhatsapp && !byWhatsapp,
        hasPhoneMismatch: hasComparablePhone && !byPhone,
        hasComparableFields: hasComparableWhatsapp || hasComparablePhone,
      });

  return {
    matched,
    byWhatsapp,
    byPhone,
    reason,
    compared: {
      requestPhone: requestIdentity.canonicalPhone,
      bookingPhone: bookingIdentity.canonicalPhone,
      requestWhatsappKeys: requestIdentity.whatsappKeys || [],
      bookingWhatsappKeys: bookingIdentity.whatsappKeys || [],
      commonWhatsappKeys,
    },
  };
};

const matchBookingsByClient = ({ bookings = [], client = {} } = {}) => {
  const requestIdentity = normalizeClientIdentity(client);

  const audits = bookings.map((booking) => {
    const bookingIdentity = normalizeClientIdentity({
      phone: booking?.clientPhone || "",
      whatsappId: booking?.clientWhatsappId || "",
      chatId: booking?.clientWhatsappId || "",
      canonicalClientPhone: booking?.clientPhone || "",
    });

    const pairMatch = matchIdentityPair(bookingIdentity, requestIdentity);

    return {
      booking,
      bookingIdentity,
      requestIdentity,
      matched: pairMatch.matched,
      byWhatsapp: pairMatch.byWhatsapp,
      byPhone: pairMatch.byPhone,
      reason: pairMatch.reason,
      compared: pairMatch.compared,
    };
  });

  const byWhatsapp = audits.filter((item) => item.byWhatsapp).map((item) => item.booking);
  const byPhone = audits.filter((item) => item.byPhone).map((item) => item.booking);

  const strategy = byWhatsapp.length
    ? "whatsapp"
    : byPhone.length
      ? "phone"
      : "no_match";

  return {
    requestIdentity,
    audits,
    strategy,
    matchedBookings: byWhatsapp.length ? byWhatsapp : byPhone,
  };
};

const matchClientIdentity = (left = {}, right = {}) => {
  const pair = matchIdentityPair(left, right);
  return {
    matched: pair.matched,
    byWhatsapp: pair.byWhatsapp,
    byPhone: pair.byPhone,
    reason: pair.reason,
  };
};

const findMatchingBookingsWithAudit = (bookings = [], requestIdentity = {}) => {
  const normalizedRequestIdentity =
    requestIdentity && Array.isArray(requestIdentity.whatsappKeys)
      ? {
          canonicalPhone: requestIdentity.canonicalPhone || "",
          canonicalPhoneDigits: requestIdentity.canonicalPhoneDigits || "",
          whatsappId: requestIdentity.whatsappId || "",
          whatsappKeys: requestIdentity.whatsappKeys || [],
        }
      : normalizeClientIdentity(requestIdentity || {});

  const audits = bookings.map((booking) => {
    const bookingIdentity = normalizeClientIdentity({
      phone: booking?.clientPhone || "",
      whatsappId: booking?.clientWhatsappId || "",
      chatId: booking?.clientWhatsappId || "",
      canonicalClientPhone: booking?.clientPhone || "",
    });
    const pairMatch = matchIdentityPair(bookingIdentity, normalizedRequestIdentity);
    return {
      booking,
      bookingIdentity,
      requestIdentity: normalizedRequestIdentity,
      matched: pairMatch.matched,
      byWhatsapp: pairMatch.byWhatsapp,
      byPhone: pairMatch.byPhone,
      reason: pairMatch.reason,
      compared: pairMatch.compared,
    };
  });

  const byWhatsapp = audits.filter((item) => item.byWhatsapp).map((item) => item.booking);
  const byPhone = audits.filter((item) => item.byPhone).map((item) => item.booking);

  return {
    requestIdentity: normalizedRequestIdentity,
    audits,
    strategy: byWhatsapp.length ? "whatsapp" : byPhone.length ? "phone" : "no_match",
    matchedBookings: byWhatsapp.length ? byWhatsapp : byPhone,
  };
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
};
