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
