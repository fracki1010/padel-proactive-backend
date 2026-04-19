const test = require("node:test");
const assert = require("node:assert/strict");

const { matchBookingsByClient } = require("../utils/identityNormalization");

test("matching prioriza canonicalClientId cuando existe", () => {
  const bookings = [
    {
      _id: "booking-canonical",
      canonicalClientId: "+5492610000000",
      clientPhone: "5492610000000",
      clientWhatsappId: "otro@c.us",
    },
    {
      _id: "booking-wa",
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

  assert.equal(result.strategy, "canonical_client_id");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "booking-canonical");
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

test("matching por QA chatId cuando no hay teléfono real", () => {
  const result = matchBookingsByClient({
    bookings: [
      {
        _id: "booking-qa",
        canonicalClientId: "qa-defensive-server:01:xyz@c.us",
        clientWhatsappId: "qa-defensive-server:01:xyz@c.us",
      },
    ],
    client: {
      chatId: "qa-defensive-server:01:xyz@c.us",
    },
  });

  assert.equal(result.strategy, "canonical_client_id");
  assert.equal(result.matchedBookings.length, 1);
  assert.equal(String(result.matchedBookings[0]._id), "booking-qa");
});
