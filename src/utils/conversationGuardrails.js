const normalizeSpanishText = (text = "") =>
  String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeLooseText = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isEquivalentConfirmation = (value = "", extra = []) => {
  const text = normalizeLooseText(value);
  if (!text) return false;

  const defaults = new Set([
    "si",
    "si por favor",
    "dale",
    "ok",
    "okay",
    "confirmar",
    "confirmo",
    "confirmado",
    "confirmar reserva",
    "confirmar turno",
    "listo",
  ]);
  for (const item of extra || []) {
    const normalized = normalizeLooseText(item);
    if (normalized) defaults.add(normalized);
  }

  if (defaults.has(text)) return true;
  return /^(dale|ok|confirmar|confirmo|listo)\b/.test(text);
};

const parseGlobalInterruptIntent = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return null;

  if (
    /^(empezar de nuevo|reiniciar|resetear|reset|arrancar de nuevo|comenzar de nuevo)$/.test(
      text,
    )
  ) {
    return { action: "RESET_FLOW" };
  }

  if (
    /(hablar con(?: un)? admin(?:istrador)?|quiero hablar con(?: un)? admin(?:istrador)?|pasame con(?: un)? admin(?:istrador)?)/.test(
      text,
    )
  ) {
    return { action: "TALK_TO_ADMIN" };
  }

  if (
    /(ver disponibilidad|disponibilidad|hay lugar|tenes lugar|tenes algo|horarios disponibles|que horarios hay)/.test(
      text,
    ) ||
    /(cual(?:es)? (?:esta|estan) (?:disponible|disponibles|libre|libres)|que (?:esta|hay) (?:disponible|libre)|que horarios? (?:hay|tenes)|tenes algo (?:disponible|libre)|hay (?:opciones?|alternativas))/.test(
      text,
    )
  ) {
    return { action: "CHECK_AVAILABILITY" };
  }

  if (/\b(cancelar|cancelo|cancelame|cancela|anular|anulo|anulado|anulada|anula|dar de baja)\b/.test(text)) {
    return { action: "CANCEL_BOOKING" };
  }

  if (/(mis reservas|que tengo reservado|que turnos tengo|lista de reservas)/.test(text)) {
    return { action: "LIST_ACTIVE_BOOKINGS" };
  }

  if (/(reservar|quiero reservar|anotame|agendame|hace la reserva|confirma.*turno)/.test(text)) {
    return { action: "CREATE_BOOKING" };
  }

  return null;
};

const isInterruptibleAction = (action = "") =>
  action === "LIST_ACTIVE_BOOKINGS" ||
  action === "CANCEL_BOOKING" ||
  action === "CHECK_AVAILABILITY";

const shouldAllowStrictStateInterrupt = (state = null, action = "") => {
  if (!state || !isInterruptibleAction(action)) return false;
  if (state === "ATTENDANCE_CONFIRMATION") return false;
  return true;
};

const shouldBlockRejectedSlotReattempt = ({
  rejectedBookingAttempt = null,
  requestedDate = "",
  requestedTime = "",
}) => {
  if (!rejectedBookingAttempt?.dateStr || !rejectedBookingAttempt?.timeStr) {
    return false;
  }
  if (!requestedDate || !requestedTime) return false;
  return (
    String(rejectedBookingAttempt.dateStr) === String(requestedDate) &&
    String(rejectedBookingAttempt.timeStr) === String(requestedTime)
  );
};

// El usuario pide alternativas tras un rechazo de horario ("cuál está disponible",
// "dame otro horario", "mostrame opciones"). Requiere ambos grupos: el introductor
// (que/cuál/otro/dame/mostrame) y el sustantivo objetivo (disponible/libre/opciones/
// horarios/alternativas), para no dispararse en charla casual ("estoy libre").
const REJECTED_SLOT_ALTERNATIVES_PATTERN =
  /(que|cu[aá]l(?:es)?|otr[oa]s?|dame|mostr[aá](?:me|s))\b.*(disponible|libre|opciones?|horarios?|alternativas?)/;

const isRejectedSlotAlternativeRequest = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  return REJECTED_SLOT_ALTERNATIVES_PATTERN.test(text);
};

const SAFE_FALLBACK_REPLY =
  "No entendí. Decime qué horario querés (ej: mañana 20:00) o escribí 'disponibilidad'.";

// Garantiza que el bot nunca emite un reply vacío: un mensaje vacío se descarta
// silenciosamente en el worker (internal.routes.js) y deja al usuario sin respuesta.
const resolveSafeBotReply = (value = "") => {
  const reply = String(value || "").trim();
  if (!reply) return SAFE_FALLBACK_REPLY;
  return reply;
};

// Mapea el resultado de createNewBooking a un lastRejectedBookingAttempt, solo cuando
// el motivo es INVALID_TIME (horario inexistente en la grilla). Así el follow-up
// "cuál está disponible" puede recuperar la fecha del intento rechazado.
const buildRejectedBookingAttempt = ({
  dateStr = "",
  timeStr = "",
  bookingResult = null,
} = {}) => {
  if (!dateStr || !timeStr) return null;
  if (bookingResult?.error !== "INVALID_TIME") return null;
  return { dateStr, timeStr, reason: "INVALID_TIME" };
};

module.exports = {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  isInterruptibleAction,
  shouldAllowStrictStateInterrupt,
  shouldBlockRejectedSlotReattempt,
  isRejectedSlotAlternativeRequest,
  resolveSafeBotReply,
  buildRejectedBookingAttempt,
};
