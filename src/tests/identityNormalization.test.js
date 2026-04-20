const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeClientIdentity,
  normalizePhone,
  normalizeWhatsappIdValue,
  normalizeWhatsappIdKey,
  normalizeCanonicalClientPhone,
  matchBookingsByClient,
} = require("../utils/identityNormalization");

test("normalizePhone unifica phone/chatId/qa-prefix", () => {
  assert.equal(normalizePhone("5492611234567"), "5492611234567");
  assert.equal(normalizePhone("5492611234567@c.us"), "5492611234567");
  assert.equal(normalizePhone("qa-defensive-server:5492611234567@c.us"), "5492611234567");
});

test("normalizeClientIdentity produce capa única", () => {
  const identity = normalizeClientIdentity({
    phone: "5492611234567",
    chatId: "5492611234567@c.us",
  });

  assert.equal(identity.canonicalPhone, "+5492611234567");
  assert.equal(identity.canonicalPhoneDigits, "5492611234567");
  assert.ok(Array.isArray(identity.whatsappKeys));
  assert.equal(identity.channelType, "whatsapp");
  assert.equal(identity.isQaSession, false);
});

test("normalizeWhatsappIdValue conserva QA y normaliza WA", () => {
  assert.equal(
    normalizeWhatsappIdValue("qa-defensive-server:01:abc@c.us"),
    "qa-defensive-server:01:abc@c.us",
  );
  assert.equal(normalizeWhatsappIdValue("5492611234567@lid"), "5492611234567@lid");
});

test("normalizeWhatsappIdKey colapsa dominios por número", () => {
  const fromCus = normalizeWhatsappIdKey("5492611234567@c.us");
  const fromLid = normalizeWhatsappIdKey("5492611234567@lid");
  assert.equal(fromCus, "phone:5492611234567");
  assert.equal(fromLid, "phone:5492611234567");
});

test("matchBookingsByClient retorna match por phone fallback", () => {
  const result = matchBookingsByClient({
    client: {
      chatId: "qa-defensive-server:sin-digitos@lid",
      canonicalClientPhone: "5492611111111",
    },
    bookings: [
      {
        _id: "booking-phone",
        clientPhone: "5492611111111",
        clientWhatsappId: "otro-id@c.us",
      },
    ],
  });

  assert.equal(result.strategy, "phone");
  assert.equal(result.matchedBookings.length, 1);
});

test("normalizeCanonicalClientPhone resuelve el primer valor usable", () => {
  assert.equal(
    normalizeCanonicalClientPhone("", "qa-defensive-server:5492611234567@c.us"),
    "5492611234567",
  );
});
