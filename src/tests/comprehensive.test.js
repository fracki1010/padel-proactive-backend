/**
 * Tests comprehensivos para el intérprete conversacional del bot de WhatsApp.
 * Cubre: extracción de nombre, parsing de fecha/hora, detección de intención,
 * state machine, matching de reservas, cancelación, confirmación y fallback sin IA.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractPersonName } = require("../whatsapp/domain/extractPersonName");
const { parseBookingDateTime } = require("../whatsapp/domain/parseBookingDateTime");
const { interpretIncomingMessage, detectIntent, INTENTS } = require("../whatsapp/domain/messageInterpreter");
const { STATES, transitionBookingState, deriveStateFromMeta } = require("../whatsapp/domain/bookingStateMachine");
const { matchBookingsByClient } = require("../services/bookingMatching.service");
const { normalizeClientIdentity } = require("../whatsapp/domain/clientIdentity");

const NOW = new Date("2026-04-20T18:00:00.000Z"); // Lunes 20/04/2026 15:00 Argentina
const TZ = "America/Argentina/Buenos_Aires";

// =====================================================================
// FASE 2: EXTRACCIÓN DE NOMBRE
// =====================================================================

test("[nombre] 'mi nombre es Juan Perez' → Juan Perez", () => {
  const r = extractPersonName("mi nombre es Juan Perez");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "Juan Perez");
});

test("[nombre] 'soy Martin Perez' → Martin Perez", () => {
  const r = extractPersonName("soy Martin Perez");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "Martin Perez");
});

test("[nombre] 'Lucas Diaz' → Lucas Diaz", () => {
  const r = extractPersonName("Lucas Diaz");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "Lucas Diaz");
});

test("[nombre] 'mi nombre es Iñaki Muñoz' → Iñaki Muñoz", () => {
  const r = extractPersonName("mi nombre es Iñaki Muñoz");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "Iñaki Muñoz");
});

test("[nombre] 'mi nombre es Jean-Luc Picard' → Jean-Luc Picard", () => {
  const r = extractPersonName("mi nombre es Jean-Luc Picard");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "Jean-Luc Picard");
});

test("[nombre] 'mi nombre es O'Connor Diaz' → O'Connor Diaz", () => {
  const r = extractPersonName("mi nombre es O'Connor Diaz");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "O'Connor Diaz");
});

test("[nombre] nombre compuesto 'Juan Carlos Perez' → válido", () => {
  const r = extractPersonName("Juan Carlos Perez");
  assert.equal(r.isValid, true);
  assert.equal(r.value, "Juan Carlos Perez");
});

test("[nombre] nombre compuesto con conector 'Maria del Pilar Lopez' → válido", () => {
  const r = extractPersonName("Maria del Pilar Lopez");
  assert.equal(r.isValid, true);
});

test("[nombre] solo un token 'mi nombre es Juan' → inválido (falta apellido)", () => {
  const r = extractPersonName("mi nombre es Juan");
  assert.equal(r.isValid, false);
  assert.equal(r.reason, "missing_last_name");
});

test("[nombre] 'juan 123' → inválido (contiene dígitos)", () => {
  const r = extractPersonName("juan 123");
  assert.equal(r.isValid, false);
  assert.equal(r.reason, "contains_digits");
});

test("[nombre] payload SQL → inválido (payload sospechoso)", () => {
  const r = extractPersonName("mi nombre es Robert'); DROP TABLE users;--");
  assert.equal(r.isValid, false);
  assert.equal(r.reason, "suspicious_payload");
});

test("[nombre] comando mezclado 'quiero reservar hoy' → inválido", () => {
  const r = extractPersonName("quiero reservar hoy");
  assert.equal(r.isValid, false);
});

// =====================================================================
// FASE 1/10: PARSING DE FECHA Y HORA
// =====================================================================

test("[datetime] 'hoy a las 20' → 2026-04-20 20:00", () => {
  const r = parseBookingDateTime("hoy a las 20", NOW, TZ);
  assert.equal(r.date, "2026-04-20");
  assert.equal(r.time, "20:00");
});

test("[datetime] 'mañana 21' → 2026-04-21 21:00", () => {
  const r = parseBookingDateTime("mañana 21", NOW, TZ);
  assert.equal(r.date, "2026-04-21");
  assert.equal(r.time, "21:00");
});

test("[datetime] '8 de la noche' → 20:00", () => {
  const r = parseBookingDateTime("8 de la noche", NOW, TZ);
  assert.equal(r.time, "20:00");
});

test("[datetime] '9 de la noche' → 21:00", () => {
  const r = parseBookingDateTime("9 de la noche", NOW, TZ);
  assert.equal(r.time, "21:00");
});

test("[datetime] 'si no hay 8, dame 9' → no interpreta como noche sin contexto", () => {
  const r = parseBookingDateTime("si no hay 8, dame 9", NOW, TZ);
  // Sin contexto de noche/tarde, 9 se interpreta como 09:00
  assert.equal(r.time, "09:00");
});

test("[datetime] hora inválida '99:99' → invalidTime true", () => {
  const r = parseBookingDateTime("reservar 99:99", NOW, TZ);
  assert.equal(r.invalidTime, true);
});

test("[datetime] hora inválida '24:00' → invalidTime true", () => {
  const r = parseBookingDateTime("reservar 24:00", NOW, TZ);
  assert.equal(r.invalidTime, true);
});

test("[datetime] 'pasado mañana 20' → 2026-04-22 20:00", () => {
  const r = parseBookingDateTime("pasado mañana 20", NOW, TZ);
  assert.equal(r.date, "2026-04-22");
  assert.equal(r.time, "20:00");
});

test("[datetime] fecha pasada tiene isPast=true", () => {
  const r = parseBookingDateTime("2026-04-15 20:00", NOW, TZ);
  assert.equal(r.isPast, true);
});

test("[datetime] fecha futura tiene isPast=false", () => {
  const r = parseBookingDateTime("mañana 20", NOW, TZ);
  assert.equal(r.isPast, false);
});

test("[datetime] 'viernes 20' → próximo viernes", () => {
  const r = parseBookingDateTime("viernes 20", NOW, TZ);
  // Hoy es lunes 20/04, próximo viernes es 24/04
  assert.equal(r.date, "2026-04-24");
  assert.equal(r.time, "20:00");
});

// =====================================================================
// FASE 1: DETECCIÓN DE INTENCIÓN
// =====================================================================

test("[intent] 'confirmar reserva' → CONFIRM (no CREATE_BOOKING)", () => {
  const intent = detectIntent("confirmar reserva");
  assert.equal(intent, INTENTS.CONFIRM);
});

test("[intent] 'quiero reservar hoy 20' → CREATE_BOOKING", () => {
  const intent = detectIntent("quiero reservar hoy 20");
  assert.equal(intent, INTENTS.CREATE_BOOKING);
});

test("[intent] 'mis reservas' → LIST_ACTIVE_BOOKINGS", () => {
  const intent = detectIntent("mis reservas");
  assert.equal(intent, INTENTS.LIST_ACTIVE_BOOKINGS);
});

test("[intent] 'qué turnos tengo' → LIST_ACTIVE_BOOKINGS", () => {
  const intent = detectIntent("que turnos tengo");
  assert.equal(intent, INTENTS.LIST_ACTIVE_BOOKINGS);
});

test("[intent] 'hay alguna reserva a mi nombre' → LIST_ACTIVE_BOOKINGS", () => {
  const intent = detectIntent("hay alguna reserva a mi nombre");
  assert.equal(intent, INTENTS.LIST_ACTIVE_BOOKINGS);
});

test("[intent] 'cancelar turno' → CANCEL_BOOKING", () => {
  const intent = detectIntent("cancelar turno");
  assert.equal(intent, INTENTS.CANCEL_BOOKING);
});

test("[intent] 'anular reserva' → CANCEL_BOOKING", () => {
  const intent = detectIntent("anular reserva");
  assert.equal(intent, INTENTS.CANCEL_BOOKING);
});

test("[intent] 'quiero cancelar ese mismo turno' → CANCEL_BOOKING", () => {
  const intent = detectIntent("quiero cancelar ese mismo turno");
  assert.equal(intent, INTENTS.CANCEL_BOOKING);
});

test("[intent] 'si' solo → CONFIRM", () => {
  const intent = detectIntent("si");
  assert.equal(intent, INTENTS.CONFIRM);
});

test("[intent] 'si hay disponibilidad' → CHECK_AVAILABILITY (no CONFIRM)", () => {
  const intent = detectIntent("si hay disponibilidad");
  assert.equal(intent, INTENTS.CHECK_AVAILABILITY);
});

test("[intent] 'disponibilidad' → CHECK_AVAILABILITY", () => {
  const intent = detectIntent("disponibilidad");
  assert.equal(intent, INTENTS.CHECK_AVAILABILITY);
});

test("[intent] 'ver disponibilidad para mañana' → CHECK_AVAILABILITY", () => {
  const intent = detectIntent("ver disponibilidad para mañana");
  assert.equal(intent, INTENTS.CHECK_AVAILABILITY);
});

test("[intent] 'empezar de nuevo' → RESTART", () => {
  const intent = detectIntent("empezar de nuevo");
  assert.equal(intent, INTENTS.RESTART);
});

test("[intent] 'Franco Galdame' → PROVIDE_NAME", () => {
  const intent = detectIntent("Franco Galdame");
  assert.equal(intent, INTENTS.PROVIDE_NAME);
});

test("[intent] en AWAITING_NAME 'Martin Perez' → PROVIDE_NAME", () => {
  const intent = detectIntent("Martin Perez", { currentState: STATES.AWAITING_NAME });
  assert.equal(intent, INTENTS.PROVIDE_NAME);
});

// =====================================================================
// FASE 3: STATE MACHINE
// =====================================================================

test("[sm] IDLE + CREATE_BOOKING sin nombre → AWAITING_NAME", () => {
  const r = transitionBookingState({
    currentState: STATES.IDLE,
    intent: "CREATE_BOOKING",
    hasValidDraft: false,
    hasPersonName: false,
    hasKnownName: false,
  });
  assert.equal(r.nextState, STATES.AWAITING_NAME);
  assert.equal(r.nextAction, "ASK_NAME");
});

test("[sm] IDLE + CREATE_BOOKING con nombre conocido → no pide nombre", () => {
  const r = transitionBookingState({
    currentState: STATES.IDLE,
    intent: "CREATE_BOOKING",
    hasValidDraft: false,
    hasPersonName: false,
    hasKnownName: true,
  });
  assert.equal(r.nextState, STATES.AWAITING_FINAL_CONFIRMATION);
  assert.equal(r.nextAction, "BUILD_DRAFT_AND_CONFIRM");
});

test("[sm] AWAITING_FINAL_CONFIRMATION + CONFIRM + draft válido → EXECUTE_DRAFT", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_FINAL_CONFIRMATION,
    intent: "CONFIRM",
    hasValidDraft: true,
    hasPersonName: false,
    hasKnownName: true,
  });
  assert.equal(r.nextState, STATES.COMPLETED);
  assert.equal(r.nextAction, "EXECUTE_DRAFT");
});

test("[sm] AWAITING_NAME + CONFIRM + no hay nombre ni conocido → pide nombre", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_NAME,
    intent: "CONFIRM",
    hasValidDraft: true,
    hasPersonName: false,
    hasKnownName: false,
  });
  assert.equal(r.nextState, STATES.AWAITING_NAME);
  assert.equal(r.nextAction, "ASK_NAME");
  assert.equal(r.reason, "confirm_needs_name");
});

test("[sm] AWAITING_NAME + CONFIRM + nombre conocido → ejecutar draft", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_NAME,
    intent: "CONFIRM",
    hasValidDraft: true,
    hasPersonName: false,
    hasKnownName: true,
  });
  assert.equal(r.nextState, STATES.COMPLETED);
  assert.equal(r.nextAction, "EXECUTE_DRAFT");
});

test("[sm] cualquier estado + CANCEL_BOOKING + sin draft + sin candidatos → IDLE", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_NAME,
    intent: "CANCEL_BOOKING",
    hasValidDraft: false,
    hasCancellationCandidates: false,
  });
  assert.equal(r.nextState, STATES.IDLE);
  assert.equal(r.nextAction, "START_CANCELLATION");
});

test("[sm] cualquier estado + CANCEL_BOOKING + con candidatos → AWAITING_CANCELLATION_TARGET", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_NAME,
    intent: "CANCEL_BOOKING",
    hasValidDraft: false,
    hasCancellationCandidates: true,
  });
  assert.equal(r.nextState, STATES.AWAITING_CANCELLATION_TARGET);
});

test("[sm] 'quiero cancelar ese mismo turno' desde draft confirmado → cancelar draft", () => {
  const r = interpretIncomingMessage({
    text: "quiero cancelar ese mismo turno",
    state: STATES.AWAITING_FINAL_CONFIRMATION,
    draft: { dateStr: "2026-04-20", timeStr: "20:00" },
    now: NOW,
    timezone: TZ,
    sessionMeta: {},
  });
  assert.equal(r.detectedIntent, INTENTS.CANCEL_BOOKING);
  assert.equal(r.nextState, STATES.CANCELLED);
});

test("[sm] CONFIRM sin draft → EXPLAIN_MISSING_DRAFT", () => {
  const r = transitionBookingState({
    currentState: STATES.IDLE,
    intent: "CONFIRM",
    hasValidDraft: false,
  });
  assert.equal(r.nextAction, "EXPLAIN_MISSING_DRAFT");
});

test("[sm] REJECT con draft → DISCARD_DRAFT", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_FINAL_CONFIRMATION,
    intent: "REJECT",
    hasValidDraft: true,
  });
  assert.equal(r.nextState, STATES.CANCELLED);
  assert.equal(r.nextAction, "DISCARD_DRAFT");
});

test("[sm] RESTART desde cualquier estado → RESET_FLOW", () => {
  for (const state of Object.values(STATES)) {
    const r = transitionBookingState({
      currentState: state,
      intent: "RESTART",
    });
    assert.equal(r.nextState, STATES.IDLE);
    assert.equal(r.nextAction, "RESET_FLOW");
  }
});

// =====================================================================
// FASE 1: INTÉRPRETE COMPLETO (interpretIncomingMessage)
// =====================================================================

test("[interpreter] 'confirmar reserva' con draft válido → CONFIRM_DRAFT", () => {
  const r = interpretIncomingMessage({
    text: "confirmar reserva",
    state: STATES.AWAITING_FINAL_CONFIRMATION,
    draft: { dateStr: "2026-04-20", timeStr: "20:00" },
    now: NOW,
    timezone: TZ,
    sessionMeta: {},
  });
  assert.equal(r.detectedIntent, INTENTS.CONFIRM);
  assert.equal(r.nextAction?.action, "CONFIRM_DRAFT");
});

test("[interpreter] 'mis reservas' → LIST_ACTIVE_BOOKINGS", () => {
  const r = interpretIncomingMessage({
    text: "mis reservas",
    now: NOW,
    timezone: TZ,
    sessionMeta: {},
  });
  assert.equal(r.detectedIntent, INTENTS.LIST_ACTIVE_BOOKINGS);
  assert.equal(r.nextAction?.action, "LIST_ACTIVE_BOOKINGS");
});

test("[interpreter] 'quiero reservar hoy 20' → extrae fecha y hora", () => {
  const r = interpretIncomingMessage({
    text: "quiero reservar hoy 20",
    now: NOW,
    timezone: TZ,
    sessionMeta: {},
  });
  assert.equal(r.detectedIntent, INTENTS.CREATE_BOOKING);
  assert.equal(r.extractedEntities.date, "2026-04-20");
  assert.equal(r.extractedEntities.time, "20:00");
});

test("[interpreter] en AWAITING_NAME 'Franco Galdame' → PROVIDE_NAME con nombre", () => {
  const r = interpretIncomingMessage({
    text: "Franco Galdame",
    state: STATES.AWAITING_NAME,
    now: NOW,
    timezone: TZ,
    sessionMeta: {},
  });
  assert.equal(r.detectedIntent, INTENTS.PROVIDE_NAME);
  assert.equal(r.extractedEntities.personName, "Franco Galdame");
});

// =====================================================================
// FASE 4: MATCHING DE CLIENTE
// =====================================================================

test("[matching] match exacto por whatsapp key", () => {
  const r = matchBookingsByClient(
    { chatId: "5492610000000@c.us", canonicalClientPhone: "5492610000000" },
    [{ _id: "b1", clientPhone: "000", clientWhatsappId: "5492610000000@lid" }],
  );
  assert.equal(r.strategy, "whatsapp");
  assert.equal(r.matchedBookings.length, 1);
});

test("[matching] cae a phone si no hay whatsapp en común", () => {
  const r = matchBookingsByClient(
    { chatId: "qa-defensive-server:sin-digitos@lid", canonicalClientPhone: "5492611111111" },
    [{ _id: "b2", clientPhone: "5492611111111", clientWhatsappId: "otro-id@c.us" }],
  );
  assert.equal(r.strategy, "phone");
  assert.equal(r.matchedBookings.length, 1);
});

test("[matching] QA booking con phone embebido se matchea con usuario real", () => {
  const r = matchBookingsByClient(
    { chatId: "5492611234567@c.us", canonicalClientPhone: "5492611234567" },
    [{ _id: "b3", clientPhone: "000", clientWhatsappId: "qa-defensive-server:5492611234567@lid" }],
  );
  assert.equal(r.strategy, "whatsapp");
  assert.equal(r.matchedBookings.length, 1);
});

test("[matching] sin coincidencia → no_match con 0 reservas", () => {
  const r = matchBookingsByClient(
    { chatId: "5492612222222@c.us", canonicalClientPhone: "5492612222222" },
    [{ _id: "b4", clientPhone: "5492613333333", clientWhatsappId: "5492613333333@c.us" }],
  );
  assert.equal(r.strategy, "no_match");
  assert.equal(r.matchedBookings.length, 0);
});

test("[matching] 'mis reservas' con booking existente: resultado correcto", () => {
  const bookings = [
    { _id: "b5", clientPhone: "5492611234567", clientWhatsappId: "5492611234567@c.us", status: "confirmed" },
    { _id: "b6", clientPhone: "5492619999999", clientWhatsappId: "5492619999999@c.us", status: "confirmed" },
  ];
  const r = matchBookingsByClient(
    { chatId: "5492611234567@c.us", canonicalClientPhone: "5492611234567" },
    bookings,
  );
  assert.equal(r.matchedBookings.length, 1);
  assert.equal(String(r.matchedBookings[0]._id), "b5");
});

// =====================================================================
// FASE 4: NORMALIZACIÓN DE IDENTIDAD
// =====================================================================

test("[identity] normalizeClientIdentity produce keys correctas para @c.us", () => {
  const id = normalizeClientIdentity({ chatId: "5492611234567@c.us", canonicalClientPhone: "5492611234567" });
  assert.equal(id.canonicalPhone, "+5492611234567");
  assert.equal(id.isQaSession, false);
  assert.ok(id.whatsappKeys.includes("wa:5492611234567"));
  assert.ok(id.whatsappKeys.includes("phone:5492611234567"));
});

test("[identity] QA session con phone embebido genera wa: key", () => {
  const id = normalizeClientIdentity({ chatId: "qa-server:5492611234567@lid" });
  assert.ok(id.whatsappKeys.includes("wa:5492611234567"), `Keys: ${JSON.stringify(id.whatsappKeys)}`);
});

test("[identity] QA session sin dígitos no genera wa: key extra", () => {
  const id = normalizeClientIdentity({ chatId: "qa-defensive-server:sin-digitos@lid" });
  const hasWaKey = id.whatsappKeys.some((k) => k.startsWith("wa:") && !k.includes("qa"));
  assert.equal(hasWaKey, false);
});

// =====================================================================
// FASE 5: FALLBACK SIN IA — comportamiento determinístico básico
// =====================================================================

test("[fallback] detectIntent funciona sin llamadas externas (sin Groq)", () => {
  // Todos los intents básicos deben detectarse sin IA
  const cases = [
    ["quiero reservar hoy 20", INTENTS.CREATE_BOOKING],
    ["mis reservas", INTENTS.LIST_ACTIVE_BOOKINGS],
    ["cancelar turno", INTENTS.CANCEL_BOOKING],
    ["confirmar reserva", INTENTS.CONFIRM],
    ["disponibilidad mañana", INTENTS.CHECK_AVAILABILITY],
    ["empezar de nuevo", INTENTS.RESTART],
    ["Franco Galdame", INTENTS.PROVIDE_NAME],
  ];
  for (const [text, expected] of cases) {
    const result = detectIntent(text);
    assert.equal(result, expected, `"${text}" should be ${expected}, got ${result}`);
  }
});

test("[fallback] parseBookingDateTime funciona sin IA para inputs básicos", () => {
  const cases = [
    ["hoy 20", "2026-04-20", "20:00"],
    ["mañana 21", "2026-04-21", "21:00"],
    ["8 de la noche", null, "20:00"],
  ];
  for (const [text, expectDate, expectTime] of cases) {
    const r = parseBookingDateTime(text, NOW, TZ);
    if (expectDate) assert.equal(r.date, expectDate, `date for "${text}"`);
    if (expectTime) assert.equal(r.time, expectTime, `time for "${text}"`);
  }
});

test("[fallback] extractPersonName funciona sin IA", () => {
  const cases = [
    ["Franco Galdame", true, "Franco Galdame"],
    ["Maria Lopez", true, "Maria Lopez"],
    ["solo", false, null],
    ["123 456", false, null],
  ];
  for (const [text, expectValid, expectValue] of cases) {
    const r = extractPersonName(text);
    assert.equal(r.isValid, expectValid, `isValid for "${text}"`);
    if (expectValue !== null) assert.equal(r.value, expectValue, `value for "${text}"`);
  }
});

// =====================================================================
// ANTI-LOOP: repetición de intent/mensaje
// =====================================================================

test("[anti-loop] repetir 'quiero reservar hoy 20' sigue retornando CREATE_BOOKING", () => {
  // La detección de intent no debe degradar con repetición (eso lo maneja el handler)
  const text = "quiero reservar hoy 20";
  for (let i = 0; i < 4; i++) {
    const r = interpretIncomingMessage({ text, now: NOW, timezone: TZ, sessionMeta: {} });
    assert.equal(r.detectedIntent, INTENTS.CREATE_BOOKING);
  }
});

// =====================================================================
// CANCELACIÓN: contexto y propuesta automática
// =====================================================================

test("[cancel] CANCEL_BOOKING con draft activo → CANCEL_DRAFT_OR_BOOKING", () => {
  const r = transitionBookingState({
    currentState: STATES.AWAITING_FINAL_CONFIRMATION,
    intent: "CANCEL_BOOKING",
    hasValidDraft: true,
    hasCancellationCandidates: false,
  });
  assert.equal(r.nextState, STATES.CANCELLED);
  assert.equal(r.nextAction, "CANCEL_DRAFT_OR_BOOKING");
});

test("[cancel] CANCEL_BOOKING sin draft pero con candidatos → AWAITING_CANCELLATION_TARGET", () => {
  const r = transitionBookingState({
    currentState: STATES.IDLE,
    intent: "CANCEL_BOOKING",
    hasValidDraft: false,
    hasCancellationCandidates: true,
  });
  assert.equal(r.nextState, STATES.AWAITING_CANCELLATION_TARGET);
  assert.equal(r.nextAction, "START_CANCELLATION");
});

test("[cancel] CANCEL_BOOKING sin draft ni candidatos → IDLE (informar que no hay reservas)", () => {
  const r = transitionBookingState({
    currentState: STATES.IDLE,
    intent: "CANCEL_BOOKING",
    hasValidDraft: false,
    hasCancellationCandidates: false,
  });
  assert.equal(r.nextState, STATES.IDLE);
  assert.equal(r.nextAction, "START_CANCELLATION");
});

// =====================================================================
// EDGE CASES
// =====================================================================

test("[edge] hora ambigua sin contexto de noche permanece como hora baja", () => {
  const r = parseBookingDateTime("hoy 9", NOW, TZ);
  assert.equal(r.time, "09:00");
});

test("[edge] 'reserva' sola → CREATE_BOOKING (sustantivo implica intención)", () => {
  const intent = detectIntent("reserva para mañana");
  assert.equal(intent, INTENTS.CREATE_BOOKING);
});

test("[edge] 'no' solo → REJECT (no CANCEL_BOOKING)", () => {
  const intent = detectIntent("no");
  assert.equal(intent, INTENTS.REJECT);
});

test("[edge] mensaje vacío → UNKNOWN", () => {
  const intent = detectIntent("");
  assert.equal(intent, INTENTS.UNKNOWN);
});

test("[edge] deriveStateFromMeta sin meta → IDLE", () => {
  assert.equal(deriveStateFromMeta({}), STATES.IDLE);
  assert.equal(deriveStateFromMeta(null), STATES.IDLE);
});

test("[edge] deriveStateFromMeta con lastFlowStatus completed → COMPLETED", () => {
  const state = deriveStateFromMeta({ lastFlowStatus: "completed" });
  assert.equal(state, STATES.COMPLETED);
});
