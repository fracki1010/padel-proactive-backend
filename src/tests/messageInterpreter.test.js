const test = require("node:test");
const assert = require("node:assert/strict");

const { interpretIncomingMessage, detectIntent, INTENTS } = require("../whatsapp/domain/messageInterpreter");
const { STATES } = require("../whatsapp/domain/bookingStateMachine");

const now = new Date("2026-04-20T18:00:00.000Z");

test("detecta intent CREATE_BOOKING y entidades", () => {
  const result = interpretIncomingMessage({
    text: "quiero reservar hoy 20",
    now,
    timezone: "America/Argentina/Buenos_Aires",
    sessionMeta: {},
  });

  assert.equal(result.detectedIntent, INTENTS.CREATE_BOOKING);
  assert.equal(result.extractedEntities.date, "2026-04-20");
  assert.equal(result.extractedEntities.time, "20:00");
});

test("confirmación con draft válido ejecuta", () => {
  const result = interpretIncomingMessage({
    text: "confirmar reserva",
    state: STATES.AWAITING_FINAL_CONFIRMATION,
    draft: { dateStr: "2026-04-20", timeStr: "20:00" },
    now,
    timezone: "America/Argentina/Buenos_Aires",
    sessionMeta: {},
  });

  assert.equal(result.detectedIntent, INTENTS.CONFIRM);
  assert.equal(result.nextAction.action, "CONFIRM_DRAFT");
});

test("cancelación global desde estado de draft", () => {
  const result = interpretIncomingMessage({
    text: "quiero cancelar ese mismo turno",
    state: STATES.AWAITING_FINAL_CONFIRMATION,
    draft: { dateStr: "2026-04-20", timeStr: "20:00" },
    now,
    timezone: "America/Argentina/Buenos_Aires",
    sessionMeta: {},
  });

  assert.equal(result.detectedIntent, INTENTS.CANCEL_BOOKING);
  assert.equal(result.nextAction.action, "CANCEL_BOOKING");
});

test("mis reservas detecta list active", () => {
  const result = interpretIncomingMessage({
    text: "mis reservas",
    now,
    timezone: "America/Argentina/Buenos_Aires",
    sessionMeta: {},
  });

  assert.equal(result.detectedIntent, INTENTS.LIST_ACTIVE_BOOKINGS);
  assert.equal(result.nextAction.action, "LIST_ACTIVE_BOOKINGS");
});

test("detectIntent reconoce pedidos escopetados de disponibilidad", () => {
  const accepted = [
    "cuál está disponible",
    "cuál está libre",
    "qué hay disponible",
    "qué horarios tenés",
    "tenés algo libre",
    "hay opciones",
  ];
  for (const text of accepted) {
    assert.equal(
      detectIntent(text),
      INTENTS.CHECK_AVAILABILITY,
      `Debe detectar: ${text}`,
    );
  }
});

test("detectIntent no false-positive con 'libre' en charla casual", () => {
  assert.notEqual(detectIntent("estoy libre el jueves"), INTENTS.CHECK_AVAILABILITY);
  assert.notEqual(detectIntent("hoy me siento libre"), INTENTS.CHECK_AVAILABILITY);
});
