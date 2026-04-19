const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePhone,
  normalizeWhatsappIdValue,
  normalizeWhatsappIdKey,
  normalizeCanonicalClientPhone,
  buildClientIdentity,
  matchClientIdentity,
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

test("buildClientIdentity prioriza teléfono canónico consistente", () => {
  const identity = buildClientIdentity({
    canonicalClientPhone: "",
    phone: "",
    chatId: "qa-defensive-server:5492611234567@c.us",
  });

  assert.equal(identity.canonicalPhone, "5492611234567");
  assert.equal(identity.whatsappKey, "num:5492611234567");
});

test("matchClientIdentity audita match por whatsapp y por teléfono", () => {
  const request = buildClientIdentity({
    chatId: "5492611234567@c.us",
    canonicalClientPhone: "5492611234567",
  });

  const bookingByWhatsapp = buildClientIdentity({
    whatsappId: "5492611234567@lid",
    canonicalClientPhone: "",
  });
  const matchByWhatsapp = matchClientIdentity(bookingByWhatsapp, request);
  assert.equal(matchByWhatsapp.matched, true);
  assert.equal(matchByWhatsapp.byWhatsapp, true);
  assert.equal(matchByWhatsapp.reason, "match.whatsappId");

  const bookingByPhone = buildClientIdentity({
    whatsappId: "otro-id@lid",
    canonicalClientPhone: "5492611234567",
  });
  const matchByPhone = matchClientIdentity(bookingByPhone, request);
  assert.equal(matchByPhone.matched, true);
  assert.equal(matchByPhone.byPhone, true);
  assert.equal(matchByPhone.reason, "match.canonicalPhone");

  const noMatch = matchClientIdentity(
    buildClientIdentity({ whatsappId: "111111@c.us", canonicalClientPhone: "111111" }),
    request,
  );
  assert.equal(noMatch.matched, false);
  assert.equal(noMatch.reason, "no_match.identity_mismatch");
});

test("normalizeCanonicalClientPhone resuelve el primer valor usable", () => {
  assert.equal(
    normalizeCanonicalClientPhone("", "qa-defensive-server:5492611234567@c.us"),
    "5492611234567",
  );
});
