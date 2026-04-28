const { extractPersonName, normalizeSpanishText } = require("./extractPersonName");
const { parseBookingDateTime, getTodayIso } = require("./parseBookingDateTime");
const { deriveStateFromMeta, transitionBookingState } = require("./bookingStateMachine");

const INTENTS = {
  GREETING: "GREETING",
  CHECK_AVAILABILITY: "CHECK_AVAILABILITY",
  CREATE_BOOKING: "CREATE_BOOKING",
  CANCEL_BOOKING: "CANCEL_BOOKING",
  LIST_ACTIVE_BOOKINGS: "LIST_ACTIVE_BOOKINGS",
  CONFIRM: "CONFIRM",
  REJECT: "REJECT",
  PROVIDE_NAME: "PROVIDE_NAME",
  RESTART: "RESTART",
  TALK_TO_ADMIN: "TALK_TO_ADMIN",
  UNKNOWN: "UNKNOWN",
};

const detectIntent = (text = "", { currentState = null } = {}) => {
  const normalized = normalizeSpanishText(text);
  if (!normalized) return INTENTS.UNKNOWN;

  // Intents globales — siempre disponibles independientemente del estado
  if (/^(hola|buenas|buen dia|buenas tardes|buenas noches)\b/.test(normalized)) {
    return INTENTS.GREETING;
  }
  if (/\b(empezar de nuevo|reiniciar|resetear|reset|arrancar de nuevo)\b/.test(normalized)) {
    return INTENTS.RESTART;
  }
  if (/\b(hablar con admin|administrador|pasame con admin)\b/.test(normalized)) {
    return INTENTS.TALK_TO_ADMIN;
  }

  // State-aware: en AWAITING_NAME priorizar extracción de nombre antes que confirmar/rechazar
  if (currentState === "AWAITING_NAME") {
    const norm = normalizeSpanishText(text);
    const hasNameIntro = /^(mi\s+\S+\s+es|me\s+\S+o|soy)\s/i.test(text);
    // Skip name extraction when message starts with an operational keyword (no name intro prefix)
    // so "CONFIRMAR RESERVA" → CONFIRM, "cancelar" → CANCEL_BOOKING, not a name capture
    const startsWithOp = /^(confirmar|cancelar|si|no|ok|dale|listo|anular|confirm|cancel|yes|book|reserve)\b/.test(norm);
    if (!startsWithOp || hasNameIntro) {
      const personName = extractPersonName(text);
      if (personName.isValid) return INTENTS.PROVIDE_NAME;
    }
  }

  // Explicit name-intro phrases take priority over cancel/confirm/booking keywords.
  // "mi nombre es Cancelar Diaz" must be a name attempt, not CANCEL_BOOKING.
  // "mi nombre es Confirmar Perez" must be a name attempt, not CONFIRM.
  // Exception: if the content after the prefix also contains booking verb phrases,
  // it's a multi-intent message — let the AI handle it.
  const nameIntroMatch = text.match(/\b(?:mi\s+nombre\s+es|me\s+llamo|soy)\s+(.+)/i);
  if (nameIntroMatch) {
    const afterPrefixNorm = normalizeSpanishText(nameIntroMatch[1]);
    const hasBookingVerb =
      /\b(?:reservar|quiero\s+reservar|anotame|agendame|haceme\s+la\s+reserva)\b/.test(afterPrefixNorm);
    if (!hasBookingVerb) {
      return INTENTS.PROVIDE_NAME;
    }
  }

  if (
    /\b(cancelar|cancelo|cancelame|anular|anulo|anulado|anulada|dar de baja)\b/.test(normalized) &&
    /\b(reservar|quiero reservar|anotame|agendame|haceme la reserva|hace la reserva)\b/.test(normalized)
  ) {
    return INTENTS.UNKNOWN;
  }

  if (/\b(cancelar|cancelo|cancelame|anular|anulo|anulado|anulada|dar de baja)\b/.test(normalized)) {
    return INTENTS.CANCEL_BOOKING;
  }
  if (/\b(mis reservas|que turnos tengo|que tengo reservado|hay alguna reserva a mi nombre)\b/.test(normalized)) {
    return INTENTS.LIST_ACTIVE_BOOKINGS;
  }
  if (/\b(disponibilidad|horarios disponibles|hay lugar|tenes lugar|ver disponibilidad|que horarios hay)\b/.test(normalized)) {
    return INTENTS.CHECK_AVAILABILITY;
  }

  // Frases de asistencia ("si asisto", "no asisto") no son confirmaciones de reserva.
  if (/\b(asisto|asistiré|asistire|no\s+asisto|si\s+asisto)\b/.test(normalized)) {
    return INTENTS.UNKNOWN;
  }

  // CONFIRM antes de CREATE_BOOKING: "confirmar reserva" debe ser CONFIRM, no CREATE_BOOKING
  if (/\b(si|ok|dale|confirmar|confirmado|confirmo|listo|confirmar reserva|confirmar turno)\b/.test(normalized)) {
    return INTENTS.CONFIRM;
  }

  if (/\b(reservar|reserva|quiero reservar|anotame|agendame|haceme la reserva|hace la reserva)\b/.test(normalized)) {
    return INTENTS.CREATE_BOOKING;
  }
  if (/\b(no|dejalo|olvidate|mejor no)\b/.test(normalized)) {
    return INTENTS.REJECT;
  }

  const personName = extractPersonName(text);
  if (personName.isValid) return INTENTS.PROVIDE_NAME;

  return INTENTS.UNKNOWN;
};

const extractEntities = ({ text = "", now = new Date(), timezone = "America/Argentina/Buenos_Aires" } = {}) => {
  const parsedDateTime = parseBookingDateTime(text, now, timezone);
  const name = extractPersonName(text);
  const qtyMatch = normalizeSpanishText(text).match(/\b(\d+)\s*(?:canchas|turnos|reservas)\b/);
  const quantity = qtyMatch?.[1] ? Number(qtyMatch[1]) : 1;

  return {
    personName: name.isValid ? name.value : null,
    personNameMeta: name,
    date: parsedDateTime.date,
    time: parsedDateTime.time,
    dateTime: parsedDateTime.dateTime,
    relativeDate: parsedDateTime.relativeDate,
    weekday: parsedDateTime.weekday,
    courtPreference: /\b(cualquiera|indiferente|primera disponible)\b/i.test(text)
      ? "INDIFERENTE"
      : null,
    quantity,
    invalidTime: parsedDateTime.invalidTime,
  };
};

const mapIntentToAction = ({ intent = INTENTS.UNKNOWN, entities = {}, now = new Date(), timezone }) => {
  if (intent === INTENTS.CHECK_AVAILABILITY) {
    return {
      action: "CHECK_AVAILABILITY",
      date: entities.date || getTodayIso(now, timezone),
      time: entities.time || null,
    };
  }
  if (intent === INTENTS.CREATE_BOOKING) {
    return {
      action: "CREATE_BOOKING",
      date: entities.date || null,
      time: entities.time || null,
      courtName: entities.courtPreference || "INDIFERENTE",
    };
  }
  if (intent === INTENTS.CANCEL_BOOKING) {
    return {
      action: "CANCEL_BOOKING",
      date: entities.date || null,
      time: entities.time || null,
    };
  }
  if (intent === INTENTS.LIST_ACTIVE_BOOKINGS) {
    return { action: "LIST_ACTIVE_BOOKINGS" };
  }
  if (intent === INTENTS.TALK_TO_ADMIN) {
    return { action: "TALK_TO_ADMIN" };
  }
  if (intent === INTENTS.RESTART) {
    return { action: "RESET_FLOW" };
  }
  return null;
};

const buildReplyStrategy = ({ intent = INTENTS.UNKNOWN, entities = {}, stateDecision = {} } = {}) => {
  if (entities.invalidTime) return "INVALID_TIME";
  if (intent === INTENTS.PROVIDE_NAME && entities.personName) return "NAME_CAPTURED";
  if (stateDecision.nextAction === "EXPLAIN_MISSING_DRAFT") return "MISSING_DRAFT";
  return "DEFAULT";
};

const interpretIncomingMessage = ({
  text,
  state,
  now = new Date(),
  timezone = "America/Argentina/Buenos_Aires",
  clientIdentity,
  draft,
  activeBookings = [],
  availableSlots = [],
  sessionMeta = {},
} = {}) => {
  const derivedState = state || deriveStateFromMeta(sessionMeta);
  const detectedIntent = detectIntent(text || "", { currentState: derivedState });
  const extractedEntities = extractEntities({ text: text || "", now, timezone });

  const hasValidDraft = Boolean(draft?.dateStr && draft?.timeStr);
  const hasPersonName = Boolean(extractedEntities.personName);
  // hasKnownName: nombre ya registrado en perfil o capturado en sesión previa
  const hasKnownName = Boolean(
    sessionMeta?.knownName || sessionMeta?.pendingBookingClientNameCandidate,
  );
  const stateDecision = transitionBookingState({
    currentState: derivedState,
    intent: detectedIntent,
    hasValidDraft,
    hasPersonName,
    hasCancellationCandidates: Array.isArray(activeBookings) && activeBookings.length > 0,
    hasKnownName,
  });

  const nextAction =
    mapIntentToAction({ intent: detectedIntent, entities: extractedEntities, now, timezone }) ||
    (stateDecision.nextAction === "EXECUTE_DRAFT" ? { action: "CONFIRM_DRAFT" } : null);

  return {
    detectedIntent,
    extractedEntities,
    nextAction,
    nextState: stateDecision.nextState,
    replyStrategy: buildReplyStrategy({
      intent: detectedIntent,
      entities: extractedEntities,
      stateDecision,
    }),
    debug: {
      derivedState,
      stateDecision,
      clientIdentity,
      draft,
      activeBookingsCount: Array.isArray(activeBookings) ? activeBookings.length : 0,
      availableSlotsCount: Array.isArray(availableSlots) ? availableSlots.length : 0,
    },
  };
};

module.exports = {
  INTENTS,
  interpretIncomingMessage,
  detectIntent,
  extractEntities,
  mapIntentToAction,
  buildReplyStrategy,
};
