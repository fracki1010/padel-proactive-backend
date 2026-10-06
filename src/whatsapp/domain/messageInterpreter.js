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
  // Frases de "los míos": el cliente habla de SUS turnos/reservas, no de la
  // disponibilidad del club. Deben evaluarse ANTES que CHECK_AVAILABILITY para
  // que "tengo turnos" no caiga en la detección de disponibilidad genérica.
  // Incluye las formas singulares y de verificación ("mi reserva", "está
  // confirmada mi reserva") que antes caían en CREATE_BOOKING por el regex
  // genérico de "reserva" o en CONFIRM por el token suelto "si".
  const hasBookingActionVerb = /\b(quiero reservar|anotame|agendame|reservame|haceme la reserva|hace la reserva)\b/.test(normalized);
  const hasOwnBookingsPhrase =
    /\b(mi reserva|mi turno|mis reservas|mis turnos|ver mis reservas|ver mis turnos|lista de reservas|lista de turnos|que reservas tengo|que turnos tengo|cuant[ao]s? (?:reservas|turnos) tengo|(?:reservas|turnos) que tengo|tengo reservas|tengo turnos|tengo (?:una )?reserva|tengo (?:un )?turno|reservas vigentes|turnos vigentes|turnos reservados|que tengo reservado|hay alguna reserva a mi nombre|reserve algun turno|reserve algo|me reservaste algo|si reserve algo|si tengo alguna reserva|mi reserva esta confirmada|mi turno esta confirmado|esta confirmada mi reserva|esta confirmado mi turno|confirmada mi reserva|confirmado mi turno|verificar mi reserva|verificar mi turno|consultar mi reserva|consultar mi turno|saber si tengo (?:una )?(?:reserva|turno)|quiero saber si (?:tengo|tengo (?:una )?(?:reserva|turno)|mi reserva|mi turno|esta confirmada mi reserva|esta confirmado mi turno)|quiero ver mi (?:reserva|turno)|estado de mi (?:reserva|turno)|como esta mi (?:reserva|turno)|sigue en pie mi (?:reserva|turno))\b/.test(normalized);
  if (!hasBookingActionVerb && hasOwnBookingsPhrase) {
    return INTENTS.LIST_ACTIVE_BOOKINGS;
  }

  // Consulta genérica de "turnos" sin fecha/hora: puede ser tanto una pregunta por
  // la disponibilidad del club como un pedido de los turnos propios. Se clasifica
  // como CHECK_AVAILABILITY y el handler desambigua (si el cliente tiene reservas,
  // se las muestra; si no, cae a la disponibilidad normal).
  const hasGenericTurnsAvailability =
    /\bturnos\b/.test(normalized) &&
    !/\b(reservar|reserva|reservas|reservad[oa]s?|cancelar|cancelo|cancelame|anular|anulo|fijo|semanal)\b/.test(normalized);

  if (
    /\b(disponibilidad|horarios disponibles|hay lugar|tenes lugar|ver disponibilidad|que horarios hay)\b/.test(normalized) ||
    /\b(cual(?:es)?\s+(?:esta|estan)\s+(?:disponible|disponibles|libre|libres)|que\s+(?:esta|hay)\s+(?:disponible|libre)|que\s+horarios?\s+(?:hay|tenes)|tenes\s+algo\s+(?:disponible|libre)|hay\s+(?:opciones?|alternativas))\b/.test(normalized) ||
    hasGenericTurnsAvailability
  ) {
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
      // Flags de desambiguación: distinguen un pedido genérico ("turnos",
      // "turnos disponibles") de uno con fecha/hora explícita ("turnos para mañana").
      hasExplicitDate: Boolean(entities.date),
      hasExplicitTime: Boolean(entities.time),
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
