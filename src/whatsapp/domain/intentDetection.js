'use strict';

const {
  normalizeSpanishText,
  normalizeLooseText,
} = require('./messageSanitization');
const {
  extractDateFromMessage,
  extractTimeFromMessage,
  getTodayIsoArgentina,
} = require('./bookingDateTime');
const {
  hasInvalidTimeInput,
  hasCompactInvalidTime,
} = require('../../utils/timeParser');
const { interpretIncomingMessage } = require('./messageInterpreter');
const { isEquivalentConfirmation } = require('../../utils/conversationGuardrails');

const inferFallbackAction = (rawText) => {
  const text = normalizeSpanishText(rawText);

  const hasBookingActionVerb =
    /\b(quiero reservar|anotame|agendame|reservame|haceme la reserva|hace la reserva)\b/.test(text);
  const hasOwnBookingsPhrase =
    /\b(mi reserva|mi turno|mis reservas|mis turnos|ver mis reservas|ver mis turnos|lista de reservas|lista de turnos|que reservas tengo|que turnos tengo|cuant[ao]s? (?:reservas|turnos) tengo|(?:reservas|turnos) que tengo|tengo reservas|tengo turnos|tengo (?:una )?reserva|tengo (?:un )?turno|reservas vigentes|turnos vigentes|turnos reservados|que tengo reservado|hay alguna reserva a mi nombre|reserve algun turno|reserve algo|me reservaste algo|si reserve algo|si tengo alguna reserva|mi reserva esta confirmada|mi turno esta confirmado|esta confirmada mi reserva|esta confirmado mi turno|confirmada mi reserva|confirmado mi turno|verificar mi reserva|verificar mi turno|consultar mi reserva|consultar mi turno|saber si tengo (?:una )?(?:reserva|turno)|quiero saber si (?:tengo|tengo (?:una )?(?:reserva|turno)|mi reserva|mi turno|esta confirmada mi reserva|esta confirmado mi turno)|quiero ver mi (?:reserva|turno)|estado de mi (?:reserva|turno)|como esta mi (?:reserva|turno)|sigue en pie mi (?:reserva|turno))\b/.test(
      text,
    );
  if (!hasBookingActionVerb && hasOwnBookingsPhrase) {
    return { action: "LIST_ACTIVE_BOOKINGS" };
  }

  const isFixedTurn =
    /turno\s*fijo|fijo\s+semanal|semanal|todas\s+las\s+semanas/.test(text);
  if (isFixedTurn) {
    return {
      action: "FIXED_TURN_REQUEST",
      date: extractDateFromMessage(text),
      time: extractTimeFromMessage(text),
    };
  }

  const hasAvailabilityIntent =
    /tenes|tenes|hay|queda|quedan|disponible|libre|algo\s+para/.test(text);
  const date = extractDateFromMessage(text);
  const time = extractTimeFromMessage(text);
  const invalidTimeInMessage = hasInvalidTimeInput(rawText) || hasCompactInvalidTime(rawText);

  if (invalidTimeInMessage) {
    return {
      action: "INVALID_TIME_INPUT",
      date: date || getTodayIsoArgentina(),
    };
  }

  if (hasAvailabilityIntent && (date || time)) {
    return {
      action: "CHECK_AVAILABILITY",
      date: date || getTodayIsoArgentina(),
      time,
    };
  }

  return null;
};

const inferDeterministicAction = (rawText = "") => {
  const interpretation = interpretIncomingMessage({
    text: rawText,
    now: new Date(),
    timezone: "America/Argentina/Buenos_Aires",
  });

  const interpretedAction = interpretation?.nextAction?.action || null;
  if (interpretedAction) {
    return {
      ...interpretation.nextAction,
      source: "deterministic_interpreter",
    };
  }

  const fallback = inferFallbackAction(rawText);
  if (!fallback) return null;
  return {
    ...fallback,
    source: "deterministic_fallback",
  };
};

const isAffirmativeBookingReply = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;

  const exactAffirmatives = new Set([
    "si",
    "si por favor",
    "por favor",
    "dale",
    "ok",
    "okay",
    "de una",
    "confirmo",
    "confirmado",
    "hazlo",
    "hace la reserva",
    "reserva",
    "reservalo",
    "dale reservalo",
    "mandale",
    "listo",
  ]);

  if (exactAffirmatives.has(text)) return true;
  return isEquivalentConfirmation(text);
};

const isNegativeBookingReply = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;

  const negatives = new Set([
    "no",
    "mejor no",
    "no gracias",
    "cancelar",
    "dejalo",
    "deja",
    "olvidate",
  ]);

  if (negatives.has(text)) return true;
  return /^(no|cancelar|dejalo)\b/.test(text);
};

const hasDirectBookingIntent = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  const referencesPastBooking =
    /(ya me hizo la reserva|ya me habia hecho la reserva|ya reserve|ya tenia reserva|ya esta reservado)/.test(
      text,
    );
  if (referencesPastBooking) return false;

  return /(reservar|reservalo|reservalo|quiero reservar|anotame|agendame|confirma.*turno|haceme la reserva|hace la reserva)/.test(
    text,
  );
};

const hasBookingControlKeywords = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  return /\b(confirmar|cancelar|reserva|reservar|turno|cancha|hora|fecha|hoy|manana|disponibilidad|extra)\b/.test(
    text,
  );
};

module.exports = {
  inferFallbackAction,
  inferDeterministicAction,
  isAffirmativeBookingReply,
  isNegativeBookingReply,
  hasDirectBookingIntent,
  hasBookingControlKeywords,
};