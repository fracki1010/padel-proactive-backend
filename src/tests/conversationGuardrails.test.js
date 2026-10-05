const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  shouldBlockRejectedSlotReattempt,
  shouldAllowStrictStateInterrupt,
  isRejectedSlotAlternativeRequest,
  resolveSafeBotReply,
  buildRejectedBookingAttempt,
} = require("../utils/conversationGuardrails");

test("acepta confirmaciones equivalentes configuradas para UX humana", () => {
  const accepted = ["si", "dale", "ok", "confirmar", "confirmar reserva", "listo"];
  for (const text of accepted) {
    assert.equal(isEquivalentConfirmation(text), true, `Debe aceptar: ${text}`);
  }
});

test("detecta intents globales para salir de estados rígidos", () => {
  assert.equal(parseGlobalInterruptIntent("cancelar")?.action, "CANCEL_BOOKING");
  assert.equal(
    parseGlobalInterruptIntent("quiero hablar con admin")?.action,
    "TALK_TO_ADMIN",
  );
  assert.equal(
    parseGlobalInterruptIntent("empezar de nuevo")?.action,
    "RESET_FLOW",
  );
  assert.equal(
    parseGlobalInterruptIntent("que horarios disponibles hay?")?.action,
    "CHECK_AVAILABILITY",
  );
  assert.equal(
    parseGlobalInterruptIntent("ver disponibilidad")?.action,
    "CHECK_AVAILABILITY",
  );
});

test("bloquea interrupciones en attendance confirmation", () => {
  assert.equal(
    shouldAllowStrictStateInterrupt("ATTENDANCE_CONFIRMATION", "CANCEL_BOOKING"),
    false,
  );
  assert.equal(
    shouldAllowStrictStateInterrupt("FULL_NAME_CAPTURE", "CHECK_AVAILABILITY"),
    true,
  );
});

test("bloquea reintento del mismo slot rechazado", () => {
  assert.equal(
    shouldBlockRejectedSlotReattempt({
      rejectedBookingAttempt: { dateStr: "2026-04-20", timeStr: "20:00" },
      requestedDate: "2026-04-20",
      requestedTime: "20:00",
    }),
    true,
  );

  assert.equal(
    shouldBlockRejectedSlotReattempt({
      rejectedBookingAttempt: { dateStr: "2026-04-20", timeStr: "20:00" },
      requestedDate: "2026-04-20",
      requestedTime: "21:00",
    }),
    false,
  );
});

test("parseGlobalInterruptIntent detecta pedidos escopetados de alternativas", () => {
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
      parseGlobalInterruptIntent(text)?.action,
      "CHECK_AVAILABILITY",
      `Debe detectar: ${text}`,
    );
  }
});

test("parseGlobalInterruptIntent no false-positive con charla casual", () => {
  assert.equal(parseGlobalInterruptIntent("estoy libre el jueves"), null);
  assert.equal(parseGlobalInterruptIntent("hoy me siento libre"), null);
});

test("isRejectedSlotAlternativeRequest detecta pedidos de alternativas post-rechazo", () => {
  const accepted = [
    "cuál está disponible",
    "cuál está libre",
    "qué opciones hay",
    "dame otras opciones",
    "dame otro horario",
    "mostrame alternativas",
    "qué horarios hay",
    "y qué hay libre",
  ];
  for (const text of accepted) {
    assert.equal(
      isRejectedSlotAlternativeRequest(text),
      true,
      `Debe matchear: ${text}`,
    );
  }
});

test("isRejectedSlotAlternativeRequest no false-positive en charla casual", () => {
  const rejected = [
    "hola",
    "estoy libre",
    "gracias",
    "mi horario es flexible",
    "qué lindo día",
  ];
  for (const text of rejected) {
    assert.equal(
      isRejectedSlotAlternativeRequest(text),
      false,
      `No debe matchear: ${text}`,
    );
  }
});

test("resolveSafeBotReply nunca devuelve un reply vacío", () => {
  const nudge = resolveSafeBotReply("");
  assert.equal(typeof nudge, "string");
  assert.notEqual(nudge.trim(), "");
  assert.equal(resolveSafeBotReply("   "), nudge);
  assert.equal(resolveSafeBotReply("\n\t"), nudge);
  assert.equal(resolveSafeBotReply("hola"), "hola");
  assert.equal(resolveSafeBotReply("Decime otro horario"), "Decime otro horario");
});

test("buildRejectedBookingAttempt persiste intento rechazado solo ante INVALID_TIME", () => {
  assert.deepEqual(
    buildRejectedBookingAttempt({
      dateStr: "2026-04-20",
      timeStr: "20:00",
      bookingResult: { error: "INVALID_TIME" },
    }),
    { dateStr: "2026-04-20", timeStr: "20:00", reason: "INVALID_TIME" },
  );

  assert.equal(
    buildRejectedBookingAttempt({
      dateStr: "2026-04-20",
      timeStr: "20:00",
      bookingResult: { success: true },
    }),
    null,
  );

  assert.equal(
    buildRejectedBookingAttempt({
      dateStr: "2026-04-20",
      timeStr: "20:00",
      bookingResult: { error: "BUSY" },
    }),
    null,
  );

  assert.equal(
    buildRejectedBookingAttempt({
      dateStr: "2026-04-20",
      timeStr: "",
      bookingResult: { error: "INVALID_TIME" },
    }),
    null,
  );
});
