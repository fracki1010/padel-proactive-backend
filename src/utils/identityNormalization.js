const TRANSPORT_PREFIX_REGEX = /^([a-z_-]+):(.*)$/i;

const normalizeRaw = (value = "") => String(value || "").trim().toLowerCase();

const isQaLikeValue = (value = "") => {
  const raw = normalizeRaw(value);
  if (!raw) return false;
  return raw.startsWith("qa-") || raw.startsWith("qa_") || raw.startsWith("qa:") || raw.includes("qa-defensive");
};

const unwrapTransportPrefix = (value = "") => {
  const raw = normalizeRaw(value);
  if (!raw) return "";

  const match = raw.match(TRANSPORT_PREFIX_REGEX);
  if (!match) return raw;

  const prefix = String(match[1] || "").trim();
  const rest = String(match[2] || "").trim();
  if (!rest) return raw;

  if (prefix && !/\d/.test(prefix) && !isQaLikeValue(raw)) {
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
  return `wa:${String(local || "").trim()}`;
};

const normalizeChatIdKey = (value = "") => normalizeWhatsappIdKey(value);

const normalizeCanonicalClientPhone = (...values) => {
  for (const value of values) {
    const normalized = normalizePhone(value);
    if (normalized) return normalized;
  }
  return "";
};

const normalizeQaChatId = (value = "") => {
  const raw = normalizeRaw(value);
  if (!raw) return "";
  return raw.replace(/\s+/g, "");
};

const pickQaPrimaryId = (...values) => {
  for (const value of values) {
    if (isQaLikeValue(value)) {
      const normalized = normalizeQaChatId(value);
      if (normalized) return normalized;
    }
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

    if (isQaLikeValue(rawValue)) {
      appendKey(keys, `qa:${normalizeQaChatId(rawValue)}`);
      continue;
    }

    const digitsAny = normalizePhone(raw);
    if (digitsAny) appendKey(keys, `phone:${digitsAny}`);

    if (normalizedId.includes("@")) {
      const [localPart, domainPart] = normalizedId.split("@");
      const local = String(localPart || "").trim();
      const domain = String(domainPart || "").trim();
      if (local && domain) {
        appendKey(keys, `wafull:${local}@${domain}`);
      }
      if (local) {
        appendKey(keys, `wa:${local}`);
        const localDigits = String(local).replace(/\D/g, "");
        if (localDigits) appendKey(keys, `phone:${localDigits}`);
      }
      continue;
    }

    appendKey(keys, `wa:${normalizedId}`);
    if (!digitsAny) appendKey(keys, `id:${normalizedId}`);
  }

  return [...keys];
};

const normalizeClientIdentity = (input = {}) => {
  const phone = input?.phone || "";
  const whatsappId = input?.whatsappId || "";
  const chatId = input?.chatId || "";
  const canonicalClientPhone = input?.canonicalClientPhone || "";
  const providedCanonicalClientId = String(input?.canonicalClientId || "").trim();

  const qaPrimaryId = pickQaPrimaryId(chatId, whatsappId, providedCanonicalClientId);

  const canonicalPhoneDigits = normalizeCanonicalClientPhone(
    canonicalClientPhone,
    phone,
    whatsappId,
    chatId,
  );

  const canonicalPhone = toE164(canonicalPhoneDigits);
  const normalizedWhatsappId = normalizeWhatsappIdValue(whatsappId || chatId || "");
  const canonicalClientId = providedCanonicalClientId || qaPrimaryId || canonicalPhone;

  const whatsappKeys = buildWhatsappKeys(
    whatsappId,
    chatId,
    canonicalPhoneDigits,
    phone,
    qaPrimaryId,
    canonicalClientId,
  );

  const identityKeys = new Set(whatsappKeys);
  if (canonicalClientId) appendKey(identityKeys, `cid:${canonicalClientId}`);
  if (qaPrimaryId) appendKey(identityKeys, `qa:${qaPrimaryId}`);
  if (canonicalPhoneDigits) appendKey(identityKeys, `phone:${canonicalPhoneDigits}`);

  return {
    canonicalClientId,
    canonicalPhone,
    canonicalPhoneDigits,
    whatsappId: normalizedWhatsappId,
    qaChatId: qaPrimaryId,
    whatsappKeys,
    identityKeys: [...identityKeys],
  };
};

const buildClientIdentity = (input = {}) => normalizeClientIdentity(input);

const intersectKeys = (left = [], right = []) => {
  const rightSet = new Set(right || []);
  return (left || []).filter((key) => rightSet.has(key));
};

const buildMismatchReason = ({
  hasCanonicalIdMismatch,
  hasWhatsappMismatch,
  hasPhoneMismatch,
  hasQaMismatch,
  hasComparableFields,
}) => {
  if (!hasComparableFields) return "request_identity_empty";
  if (hasCanonicalIdMismatch) return "canonical_client_id_mismatch";
  if (hasQaMismatch) return "qa_chat_id_mismatch";
  if (hasWhatsappMismatch && hasPhoneMismatch) return "whatsapp_mismatch+phone_mismatch";
  if (hasWhatsappMismatch) return "whatsapp_mismatch";
  if (hasPhoneMismatch) return "phone_mismatch";
  return "no_match.identity_mismatch";
};

const matchIdentityPair = (bookingIdentity = {}, requestIdentity = {}) => {
  const commonIdentityKeys = intersectKeys(
    bookingIdentity.identityKeys,
    requestIdentity.identityKeys,
  );

  const byCanonicalClientId =
    Boolean(bookingIdentity.canonicalClientId) &&
    Boolean(requestIdentity.canonicalClientId) &&
    bookingIdentity.canonicalClientId === requestIdentity.canonicalClientId;

  const byQaChatId =
    Boolean(bookingIdentity.qaChatId) &&
    Boolean(requestIdentity.qaChatId) &&
    bookingIdentity.qaChatId === requestIdentity.qaChatId;

  const byWhatsapp = commonIdentityKeys.some((key) => key.startsWith("wa:") || key.startsWith("wafull:"));
  const byPhone =
    Boolean(bookingIdentity.canonicalPhoneDigits) &&
    Boolean(requestIdentity.canonicalPhoneDigits) &&
    bookingIdentity.canonicalPhoneDigits === requestIdentity.canonicalPhoneDigits;

  const matched = byCanonicalClientId || byQaChatId || byWhatsapp || byPhone;

  const hasComparableCanonical =
    Boolean(bookingIdentity.canonicalClientId) && Boolean(requestIdentity.canonicalClientId);
  const hasComparableQa = Boolean(bookingIdentity.qaChatId) && Boolean(requestIdentity.qaChatId);
  const hasComparableWhatsapp =
    (bookingIdentity.whatsappKeys || []).length > 0 &&
    (requestIdentity.whatsappKeys || []).length > 0;
  const hasComparablePhone =
    Boolean(bookingIdentity.canonicalPhoneDigits) &&
    Boolean(requestIdentity.canonicalPhoneDigits);

  const reason = matched
    ? byCanonicalClientId
      ? "match.canonical_client_id"
      : byQaChatId
        ? "match.qa_chat_id"
        : byWhatsapp
          ? "match.whatsapp"
          : "match.phone"
    : buildMismatchReason({
        hasCanonicalIdMismatch: hasComparableCanonical && !byCanonicalClientId,
        hasWhatsappMismatch: hasComparableWhatsapp && !byWhatsapp,
        hasPhoneMismatch: hasComparablePhone && !byPhone,
        hasQaMismatch: hasComparableQa && !byQaChatId,
        hasComparableFields:
          hasComparableCanonical || hasComparableWhatsapp || hasComparablePhone || hasComparableQa,
      });

  return {
    matched,
    byCanonicalClientId,
    byQaChatId,
    byWhatsapp,
    byPhone,
    reason,
    compared: {
      requestCanonicalClientId: requestIdentity.canonicalClientId,
      bookingCanonicalClientId: bookingIdentity.canonicalClientId,
      requestQaChatId: requestIdentity.qaChatId,
      bookingQaChatId: bookingIdentity.qaChatId,
      requestPhone: requestIdentity.canonicalPhone,
      bookingPhone: bookingIdentity.canonicalPhone,
      requestWhatsappKeys: requestIdentity.whatsappKeys || [],
      bookingWhatsappKeys: bookingIdentity.whatsappKeys || [],
      commonIdentityKeys,
    },
  };
};

const matchBookingsByClient = ({ bookings = [], client = {} } = {}) => {
  const requestIdentity = normalizeClientIdentity(client);

  const audits = bookings.map((booking) => {
    const bookingIdentity = normalizeClientIdentity({
      canonicalClientId: booking?.canonicalClientId || "",
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
      byCanonicalClientId: pairMatch.byCanonicalClientId,
      byQaChatId: pairMatch.byQaChatId,
      byWhatsapp: pairMatch.byWhatsapp,
      byPhone: pairMatch.byPhone,
      reason: pairMatch.reason,
      compared: pairMatch.compared,
    };
  });

  const byCanonicalClientId = audits
    .filter((item) => item.byCanonicalClientId)
    .map((item) => item.booking);
  const byQaChatId = audits.filter((item) => item.byQaChatId).map((item) => item.booking);
  const byWhatsapp = audits.filter((item) => item.byWhatsapp).map((item) => item.booking);
  const byPhone = audits.filter((item) => item.byPhone).map((item) => item.booking);

  let strategy = "no_match";
  let matchedBookings = [];

  if (byCanonicalClientId.length) {
    strategy = "canonical_client_id";
    matchedBookings = byCanonicalClientId;
  } else if (byQaChatId.length) {
    strategy = "qa_chat_id";
    matchedBookings = byQaChatId;
  } else if (byWhatsapp.length) {
    strategy = "whatsapp";
    matchedBookings = byWhatsapp;
  } else if (byPhone.length) {
    strategy = "phone";
    matchedBookings = byPhone;
  }

  return {
    requestIdentity,
    audits,
    strategy,
    matchedBookings,
  };
};

const matchClientIdentity = (left = {}, right = {}) => {
  const pair = matchIdentityPair(left, right);
  return {
    matched: pair.matched,
    byCanonicalClientId: pair.byCanonicalClientId,
    byQaChatId: pair.byQaChatId,
    byWhatsapp: pair.byWhatsapp,
    byPhone: pair.byPhone,
    reason: pair.reason,
  };
};

const findMatchingBookingsWithAudit = (bookings = [], requestIdentity = {}) => {
  const normalizedRequestIdentity =
    requestIdentity && Array.isArray(requestIdentity.identityKeys)
      ? {
          canonicalClientId: requestIdentity.canonicalClientId || "",
          canonicalPhone: requestIdentity.canonicalPhone || "",
          canonicalPhoneDigits: requestIdentity.canonicalPhoneDigits || "",
          whatsappId: requestIdentity.whatsappId || "",
          qaChatId: requestIdentity.qaChatId || "",
          whatsappKeys: requestIdentity.whatsappKeys || [],
          identityKeys: requestIdentity.identityKeys || [],
        }
      : normalizeClientIdentity(requestIdentity || {});

  const audits = bookings.map((booking) => {
    const bookingIdentity = normalizeClientIdentity({
      canonicalClientId: booking?.canonicalClientId || "",
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
      byCanonicalClientId: pairMatch.byCanonicalClientId,
      byQaChatId: pairMatch.byQaChatId,
      byWhatsapp: pairMatch.byWhatsapp,
      byPhone: pairMatch.byPhone,
      reason: pairMatch.reason,
      compared: pairMatch.compared,
    };
  });

  const byCanonicalClientId = audits
    .filter((item) => item.byCanonicalClientId)
    .map((item) => item.booking);
  const byQaChatId = audits.filter((item) => item.byQaChatId).map((item) => item.booking);
  const byWhatsapp = audits.filter((item) => item.byWhatsapp).map((item) => item.booking);
  const byPhone = audits.filter((item) => item.byPhone).map((item) => item.booking);

  return {
    requestIdentity: normalizedRequestIdentity,
    audits,
    strategy: byCanonicalClientId.length
      ? "canonical_client_id"
      : byQaChatId.length
        ? "qa_chat_id"
        : byWhatsapp.length
          ? "whatsapp"
          : byPhone.length
            ? "phone"
            : "no_match",
    matchedBookings: byCanonicalClientId.length
      ? byCanonicalClientId
      : byQaChatId.length
        ? byQaChatId
        : byWhatsapp.length
          ? byWhatsapp
          : byPhone,
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
