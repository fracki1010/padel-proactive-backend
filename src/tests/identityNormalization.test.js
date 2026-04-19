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
  assert.equal(normalizePhone("5492611234567@lid"), "5492611234567");
  assert.equal(
    normalizePhone("qa-defensive-server:5492611234567@c.us"),
    "5492611234567",
  );
});

test("normalizeWhatsappIdValue limpia prefijo de transporte y conserva id base", () => {
  assert.equal(
    normalizeWhatsappIdValue("qa-defensive-server:5492611234567@c.us"),
    "5492611234567@c.us",
  );
  assert.equal(normalizeWhatsappIdValue("5492611234567@lid"), "5492611234567@lid");
});

test("normalizeWhatsappIdKey colapsa @c.us y @lid al mismo identificador canónico", () => {
  const fromCus = normalizeWhatsappIdKey("5492611234567@c.us");
  const fromLid = normalizeWhatsappIdKey("5492611234567@lid");
  const fromPhone = normalizeWhatsappIdKey("5492611234567");
  const fromQa = normalizeWhatsappIdKey("qa-defensive-server:5492611234567@c.us");

  assert.equal(fromCus, "num:5492611234567");
  assert.equal(fromCus, fromLid);
  assert.equal(fromCus, fromPhone);
  assert.equal(fromCus, fromQa);
});

test("normalizeClientIdentity produce canonicalPhone E.164 y whatsappKeys", () => {
  const identity = normalizeClientIdentity({
    canonicalClientPhone: "",
    phone: "",
    chatId: "qa-defensive-server:5492611234567@c.us",
  });

  assert.equal(identity.canonicalPhone, "+5492611234567");
  assert.equal(identity.canonicalPhoneDigits, "5492611234567");
  assert.ok(identity.whatsappKeys.includes("phone:5492611234567"));
});

test("matchBookingsByClient audita mismatch con valores comparados", () => {
  const result = matchBookingsByClient({
    client: {
      chatId: "5492611234567@c.us",
      canonicalClientPhone: "5492611234567",
    },
    bookings: [
      {
        _id: "b1",
        clientPhone: "5492619999999",
        clientWhatsappId: "qa-defensive-server:5492618888888@lid",
      },
    ],
  });

  assert.equal(result.matchedBookings.length, 0);
  assert.equal(result.strategy, "no_match");
  assert.equal(result.audits[0].reason, "whatsapp_mismatch+phone_mismatch");
  assert.ok(Array.isArray(result.audits[0].compared.requestWhatsappKeys));
  assert.ok(Array.isArray(result.audits[0].compared.bookingWhatsappKeys));
});

test("normalizeCanonicalClientPhone resuelve el primer valor usable", () => {
  assert.equal(
    normalizeCanonicalClientPhone("", "qa-defensive-server:5492611234567@c.us"),
    "5492611234567",
  );
});
