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

  const hasMyBookingsIntent =
    /(mis\s+reservas|mis\s+turnos|que\s+reservas\s+tengo|que\s+turnos\s+tengo|tengo\s+reservas|tengo\s+turnos|reservas\s+vigentes|turnos\s+vigentes|reserve\s+algun\s+turno|reserve\s+algo|tengo\s+algun\s+turno\s+reservado|me\s+reservaste\s+algo|hay\s+alguna\s+reserva\s+a\s+mi\s+nombre|si\s+reserve\s+algo|si\s+tengo\s+alguna\s+reserva)/.test(
      text,
    );
  if (hasMyBookingsIntent) {
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