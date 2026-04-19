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

test("normalizeWhatsappIdValue conserva chatId QA completo", () => {
  assert.equal(
    normalizeWhatsappIdValue("qa-defensive-server:01:abc@c.us"),
    "qa-defensive-server:01:abc@c.us",
  );
  assert.equal(normalizeWhatsappIdValue("5492611234567@lid"), "5492611234567@lid");
});

test("normalizeWhatsappIdKey colapsa @c.us y @lid al mismo identificador por número", () => {
  const fromCus = normalizeWhatsappIdKey("5492611234567@c.us");
  const fromLid = normalizeWhatsappIdKey("5492611234567@lid");
  const fromPhone = normalizeWhatsappIdKey("5492611234567");

  assert.equal(fromCus, "phone:5492611234567");
  assert.equal(fromCus, fromLid);
  assert.equal(fromCus, fromPhone);
});

test("normalizeClientIdentity usa chatId como canonicalClientId para QA", () => {
  const identity = normalizeClientIdentity({
    chatId: "qa-defensive-server:01:abc@c.us",
  });

  assert.equal(identity.canonicalClientId, "qa-defensive-server:01:abc@c.us");
  assert.equal(identity.qaChatId, "qa-defensive-server:01:abc@c.us");
});

test("normalizeClientIdentity usa phone E.164 como canonicalClientId para reales", () => {
  const identity = normalizeClientIdentity({
    phone: "5492611234567",
  });

  assert.equal(identity.canonicalPhone, "+5492611234567");
  assert.equal(identity.canonicalClientId, "+5492611234567");
});

test("matchBookingsByClient soporta match por canonicalClientId QA", () => {
  const result = matchBookingsByClient({
    client: {
      chatId: "qa-defensive-server:01:abc@c.us",
    },
    bookings: [
      {
        _id: "b1",
        canonicalClientId: "qa-defensive-server:01:abc@c.us",
        clientWhatsappId: "qa-defensive-server:01:abc@c.us",
      },
    ],
  });

  assert.equal(result.matchedBookings.length, 1);
  assert.equal(result.strategy, "canonical_client_id");
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
  assert.ok(Array.isArray(result.audits[0].compared.requestWhatsappKeys));
  assert.ok(Array.isArray(result.audits[0].compared.bookingWhatsappKeys));
});

test("normalizeCanonicalClientPhone resuelve el primer valor usable", () => {
  assert.equal(
    normalizeCanonicalClientPhone("", "qa-defensive-server:5492611234567@c.us"),
    "5492611234567",
  );
});
