const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  shouldBlockRejectedSlotReattempt,
  shouldAllowStrictStateInterrupt,
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
