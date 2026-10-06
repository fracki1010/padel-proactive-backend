const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectIntent,
  interpretIncomingMessage,
  INTENTS,
} = require("../whatsapp/domain/messageInterpreter");

const now = new Date("2026-04-20T18:00:00.000Z");
const timezone = "America/Argentina/Buenos_Aires";

test("detectIntent reconoce frases de 'los míos' como LIST_ACTIVE_BOOKINGS", () => {
  const accepted = [
    "mis reservas",
    "tengo turnos",
    "mis turnos",
    "cuántos turnos tengo",
    "cuantos turnos tengo",
    "tengo reservas",
    "turnos que tengo",
    "ver mis turnos",
    "ver mis reservas",
    "lista de reservas",
    "lista de turnos",
    "que turnos tengo",
  ];
  for (const text of accepted) {
    assert.equal(
      detectIntent(text),
      INTENTS.LIST_ACTIVE_BOOKINGS,
      `Debe detectar como reservas propias: ${text}`,
    );
  }
});

test("interpretIncomingMessage mapea 'tengo turnos' a LIST_ACTIVE_BOOKINGS", () => {
  const result = interpretIncomingMessage({ text: "tengo turnos", now, timezone, sessionMeta: {} });

  assert.equal(result.detectedIntent, INTENTS.LIST_ACTIVE_BOOKINGS);
  assert.equal(result.nextAction.action, "LIST_ACTIVE_BOOKINGS");
});

test("detectIntent reconoce 'turnos disponibles' como CHECK_AVAILABILITY", () => {
  assert.equal(detectIntent("turnos disponibles"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("turnos"), INTENTS.CHECK_AVAILABILITY);
});

test("detectIntent mantiene la disponibilidad con fecha explícita", () => {
  const result = interpretIncomingMessage({
    text: "turnos disponibles para mañana",
    now,
    timezone,
    sessionMeta: {},
  });

  assert.equal(result.detectedIntent, INTENTS.CHECK_AVAILABILITY);
  assert.equal(result.extractedEntities.date, "2026-04-21");
});

test("interpretIncomingMessage marca la disponibilidad ambigua sin fecha", () => {
  const ambiguous = interpretIncomingMessage({
    text: "turnos disponibles",
    now,
    timezone,
    sessionMeta: {},
  });
  assert.equal(ambiguous.detectedIntent, INTENTS.CHECK_AVAILABILITY);
  assert.equal(ambiguous.nextAction.hasExplicitDate, false);

  const explicit = interpretIncomingMessage({
    text: "turnos para mañana",
    now,
    timezone,
    sessionMeta: {},
  });
  assert.equal(explicit.detectedIntent, INTENTS.CHECK_AVAILABILITY);
  assert.equal(explicit.nextAction.hasExplicitDate, true);
});

test("no se roban a CHECK_AVAILABILITY los casos de disponibilidad clásicos", () => {
  assert.equal(detectIntent("disponibilidad"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("horarios disponibles"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("disponibilidad mañana"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("quiero reservar hoy 20"), INTENTS.CREATE_BOOKING);
});
