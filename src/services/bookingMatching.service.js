const { normalizeClientIdentity } = require("../whatsapp/domain/clientIdentity");

const intersect = (left = [], right = []) => {
  const rightSet = new Set(right || []);
  return (left || []).filter((item) => rightSet.has(item));
};

const matchSingleBooking = (requestIdentity, booking = {}) => {
  const bookingIdentity = normalizeClientIdentity({
    phone: booking.clientPhone || "",
    whatsappId: booking.clientWhatsappId || "",
    chatId: booking.clientWhatsappId || "",
    canonicalClientPhone: booking.clientPhone || "",
  });

  const commonKeys = intersect(requestIdentity.whatsappKeys, bookingIdentity.whatsappKeys);

  // byWhatsapp: solo cuenta keys de canal WhatsApp/QA (wa:, wafull:, qa:)
  // phone: es un fallback de identidad, no confirma que el canal sea WhatsApp
  const waCommonKeys = commonKeys.filter(
    (k) => k.startsWith("wa:") || k.startsWith("wafull:") || k.startsWith("qa:"),
  );

  const byPhone =
    Boolean(requestIdentity.canonicalPhoneDigits) &&
    Boolean(bookingIdentity.canonicalPhoneDigits) &&
    requestIdentity.canonicalPhoneDigits === bookingIdentity.canonicalPhoneDigits;

  const byWhatsapp = waCommonKeys.length > 0;
  const matched = byPhone || byWhatsapp;

  return {
    booking,
    bookingIdentity,
    matched,
    byPhone,
    byWhatsapp,
    reason: matched
      ? byWhatsapp
        ? "match.whatsapp"
        : "match.phone"
      : "no_match.identity_mismatch",
    compared: {
      requestPhone: requestIdentity.canonicalPhone,
      bookingPhone: bookingIdentity.canonicalPhone,
      requestWhatsappKeys: requestIdentity.whatsappKeys,
      bookingWhatsappKeys: bookingIdentity.whatsappKeys,
      commonKeys,
      waCommonKeys,
    },
  };
};

const matchBookingsByClient = (requestIdentityInput, bookings = []) => {
  const requestIdentity =
    requestIdentityInput && Array.isArray(requestIdentityInput.whatsappKeys)
      ? requestIdentityInput
      : normalizeClientIdentity(requestIdentityInput || {});

  const audits = (bookings || []).map((booking) => matchSingleBooking(requestIdentity, booking));

  const byWhatsapp = audits.filter((a) => a.byWhatsapp).map((a) => a.booking);
  const byPhone = audits.filter((a) => a.byPhone).map((a) => a.booking);

  return {
    requestIdentity,
    matchedBookings: byWhatsapp.length ? byWhatsapp : byPhone,
    strategy: byWhatsapp.length ? "whatsapp" : byPhone.length ? "phone" : "no_match",
    audits,
  };
};

module.exports = {
  matchBookingsByClient,
};
