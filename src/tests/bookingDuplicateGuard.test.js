const test = require("node:test");
const assert = require("node:assert/strict");

const { matchBookingsByClient } = require("../utils/identityNormalization");

test("evita doble CREATE_BOOKING detectando reserva existente por whatsapp normalizado", () => {
  const result = matchBookingsByClient({
    client: {
      chatId: "5492611234567@c.us",
      canonicalClientPhone: "5492611234567",
    },
    bookings: [
      {
        _id: "existing-booking",
        clientPhone: "000",
        clientWhatsappId: "qa-defensive-server:5492611234567@lid",
      },
    ],
  });

  assert.equal(result.matchedBookings.length, 1);
  assert.equal(result.strategy, "whatsapp");
  assert.equal(String(result.matchedBookings[0]._id), "existing-booking");
});
