const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  shouldBlockRejectedSlotReattempt,
  shouldAllowStrictStateInterrupt,
  isRejectedSlotAlternativeRequest,
  parseConcreteAlternativeChoice,
  sanitizeOutgoingReply,
  resolveSafeBotReply,
  buildRejectedBookingAttempt,
  SAFE_FALLBACK_REPLY,
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

test("parseConcreteAlternativeChoice detecta elección concreta de hora", () => {
  assert.deepEqual(parseConcreteAlternativeChoice("17:00"), {
    type: "time",
    value: "17:00",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("17"), {
    type: "time",
    value: "17:00",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("17hs"), {
    type: "time",
    value: "17:00",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("las 17"), {
    type: "time",
    value: "17:00",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("a las 5"), {
    type: "time",
    value: "17:00",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("5:30"), {
    type: "time",
    value: "05:30",
  });
});

test("parseConcreteAlternativeChoice detecta elección ordinal", () => {
  assert.deepEqual(parseConcreteAlternativeChoice("la primera"), {
    type: "ordinal",
    index: 0,
  });
  assert.deepEqual(parseConcreteAlternativeChoice("el primero"), {
    type: "ordinal",
    index: 0,
  });
  assert.deepEqual(parseConcreteAlternativeChoice("la segunda"), {
    type: "ordinal",
    index: 1,
  });
  assert.deepEqual(parseConcreteAlternativeChoice("la 2"), {
    type: "ordinal",
    index: 1,
  });
  assert.deepEqual(parseConcreteAlternativeChoice("la tercera"), {
    type: "ordinal",
    index: 2,
  });
});

test("parseConcreteAlternativeChoice detecta elección de cancha", () => {
  assert.deepEqual(parseConcreteAlternativeChoice("techada"), {
    type: "court",
    value: "techada",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("la techada"), {
    type: "court",
    value: "techada",
  });
  assert.deepEqual(parseConcreteAlternativeChoice("descubierta"), {
    type: "court",
    value: "descubierta",
  });
});

test("parseConcreteAlternativeChoice no dispara en charla casual o pedidos con fecha", () => {
  assert.equal(parseConcreteAlternativeChoice("hola"), null);
  assert.equal(parseConcreteAlternativeChoice("gracias"), null);
  assert.equal(parseConcreteAlternativeChoice("mañana 20:00"), null);
  assert.equal(parseConcreteAlternativeChoice("no entendí"), null);
  assert.equal(parseConcreteAlternativeChoice(""), null);
});

test("isRejectedSlotAlternativeRequest cubre elecciones concretas post-rechazo", () => {
  assert.equal(isRejectedSlotAlternativeRequest("17:00"), true);
  assert.equal(isRejectedSlotAlternativeRequest("la primera"), true);
  assert.equal(isRejectedSlotAlternativeRequest("techada"), true);
});

test("sanitizeOutgoingReply reemplaza payloads JSON crudos con nudge seguro", () => {
  assert.equal(
    sanitizeOutgoingReply('{"action":"CREATE_BOOKING","courtName":"Techada"}'),
    SAFE_FALLBACK_REPLY,
  );
  assert.equal(sanitizeOutgoingReply('["a","b"]'), SAFE_FALLBACK_REPLY);
  assert.equal(sanitizeOutgoingReply('  {"truncado":'), SAFE_FALLBACK_REPLY);
  assert.equal(
    sanitizeOutgoingReply("hola que tal"),
    "hola que tal",
  );
  assert.equal(
    sanitizeOutgoingReply("Tengo {2} canchas libres a las 17:00"),
    "Tengo {2} canchas libres a las 17:00",
  );
  assert.equal(sanitizeOutgoingReply(""), "");
  assert.equal(sanitizeOutgoingReply("   \n"), "");
});
