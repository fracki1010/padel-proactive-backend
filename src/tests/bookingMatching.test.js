const test = require("node:test");
const assert = require("node:assert/strict");

const {
  matchBookingsByClient,
} = require("../utils/identityNormalization");

test("matching strategy prioriza whatsappId antes que teléfono", () => {
  const bookings = [
    {
      _id: "booking-a",
      clientPhone: "5492610000000",
      clientWhatsappId: "otro-cliente@c.us",
    },
    {
      _id: "booking-b",
      clientPhone: "000000",
      clientWhatsappId: "5492610000000@lid",
    },
  ];

  const result = matchBookingsByClient({
    bookings,
    client: {
      chatId: "5492610000000@c.us",
      canonicalClientPhone: "5492610000000",
    },
  });

  assert.equal(result.strategy, "whatsapp");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "booking-b");
});

test("matching cae a teléfono canónico si no hay match por whatsappId", () => {
  const bookings = [
    {
      _id: "booking-phone",
      clientPhone: "5492611111111",
      clientWhatsappId: "otro-id@c.us",
    },
  ];

  const result = matchBookingsByClient({
    bookings,
    client: {
      chatId: "qa-defensive-server:sin-digitos@lid",
      canonicalClientPhone: "5492611111111",
    },
  });

  assert.equal(result.strategy, "phone");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "booking-phone");
});

test("matching devuelve auditoría clara cuando no encuentra reservas", () => {
  const bookings = [
    {
      _id: "booking-no-match",
      clientPhone: "5492613333333",
      clientWhatsappId: "5492613333333@c.us",
    },
  ];

  const result = matchBookingsByClient({
    bookings,
    client: {
      chatId: "5492612222222@c.us",
      canonicalClientPhone: "5492612222222",
    },
  });

  assert.equal(result.strategy, "no_match");
  assert.equal(result.matchedBookings.length, 0);
  assert.equal(result.audits.length, 1);
  assert.equal(result.audits[0].reason, "whatsapp_mismatch+phone_mismatch");
});
