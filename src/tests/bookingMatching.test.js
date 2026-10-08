const test = require("node:test");
const assert = require("node:assert/strict");

const { matchBookingsByClient } = require("../services/bookingMatching.service");

test("matching por whatsapp key", () => {
  const bookings = [
    {
      _id: "booking-wa",
      clientPhone: "000000",
      clientWhatsappId: "5492610000000@lid",
    },
  ];

  const result = matchBookingsByClient(
    {
      chatId: "5492610000000@c.us",
      canonicalClientPhone: "5492610000000",
    },
    bookings,
  );

  assert.equal(result.strategy, "whatsapp");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "booking-wa");
});

test("matching cae a phone si no hay whatsapp", () => {
  const bookings = [
    {
      _id: "booking-phone",
      clientPhone: "5492611111111",
      clientWhatsappId: "otro-id@c.us",
    },
  ];

  const result = matchBookingsByClient(
    {
      chatId: "qa-defensive-server:sin-digitos@lid",
      canonicalClientPhone: "5492611111111",
    },
    bookings,
  );

  assert.equal(result.strategy, "phone");
  assert.equal(result.matchedBookings.length, 1);
});

test("matching devuelve no_match cuando no coincide", () => {
  const result = matchBookingsByClient(
    {
      chatId: "5492612222222@c.us",
      canonicalClientPhone: "5492612222222",
    },
    [
      {
        _id: "booking-no-match",
        clientPhone: "5492613333333",
        clientWhatsappId: "5492613333333@c.us",
      },
    ],
  );

  assert.equal(result.strategy, "no_match");
  assert.equal(result.matchedBookings.length, 0);
});

// ── Regression: @lid resolved to the real phone (web booking) ───────────────

test("@lid resuelto al PN real matchea una reserva web guardada como 549…", () => {
  const bookings = [
    { _id: "web-booking", clientPhone: "5492622345473", clientWhatsappId: "" },
  ];

  const result = matchBookingsByClient(
    {
      // The handler passes the resolved PN as canonicalClientPhone while the
      // chatId stays the raw @lid alias.
      chatId: "38552364683267@lid",
      canonicalClientPhone: "5492622345473",
    },
    bookings,
  );

  assert.equal(result.strategy, "phone");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "web-booking");
});

test("@lid sin resolver NO fabrica un phone con los dígitos del LID", () => {
  const bookings = [
    { _id: "web-booking", clientPhone: "5492622345473", clientWhatsappId: "" },
  ];

  const result = matchBookingsByClient(
    {
      chatId: "38552364683267@lid",
      canonicalClientPhone: "",
    },
    bookings,
  );

  assert.equal(result.strategy, "no_match");
  assert.equal(result.matchedBookings.length, 0);
  assert.equal(result.requestIdentity.canonicalPhoneDigits, "");
  // The LID digits must never appear as a phone key.
  assert.ok(
    !result.requestIdentity.whatsappKeys.some(
      (k) => k.startsWith("phone:") && k.includes("38552364683267"),
    ),
    `Keys: ${JSON.stringify(result.requestIdentity.whatsappKeys)}`,
  );
});

// ── Regression: phone-only matching must NOT collapse AR mobile/landline ────

test("móvil vs fijo con los mismos dígitos de abonado NO matchean (sin wa-key)", () => {
  // 5492622345473 (mobile) and 542622345473 (landline, same subscriber digits)
  // must stay distinct identities: collapsing them leaks/cancels another client.
  const mobile = "5492622345473";
  const landline = "542622345473";

  const forward = matchBookingsByClient(
    { chatId: `${mobile}@c.us`, canonicalClientPhone: mobile },
    [{ _id: "landline-booking", clientPhone: landline, clientWhatsappId: "" }],
  );
  assert.equal(forward.strategy, "no_match", "mobile solicitado vs fijo guardado");
  assert.equal(forward.matchedBookings.length, 0);

  const backward = matchBookingsByClient(
    { chatId: `${landline}@c.us`, canonicalClientPhone: landline },
    [{ _id: "mobile-booking", clientPhone: mobile, clientWhatsappId: "" }],
  );
  assert.equal(backward.strategy, "no_match", "fijo solicitado vs móvil guardado");
  assert.equal(backward.matchedBookings.length, 0);
});

test("distinto abonado NO matchea (sin wa-key)", () => {
  const result = matchBookingsByClient(
    { chatId: "5492622345473@c.us", canonicalClientPhone: "5492622345473" },
    [{ _id: "other-booking", clientPhone: "5492622345999", clientWhatsappId: "" }],
  );

  assert.equal(result.strategy, "no_match");
  assert.equal(result.matchedBookings.length, 0);
});

test("phone-only exacto: mismo número completo SÍ matchea", () => {
  const result = matchBookingsByClient(
    { chatId: "5492622345473@c.us", canonicalClientPhone: "5492622345473" },
    [{ _id: "exact-booking", clientPhone: "5492622345473", clientWhatsappId: "" }],
  );

  assert.equal(result.strategy, "phone");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "exact-booking");
});

