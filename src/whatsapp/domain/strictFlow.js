'use strict';

const { normalizeLooseText, normalizeSpanishText } = require('./messageSanitization');
const { extractFullNameFromMessage } = require('./extractPersonName');
const { parseStrictDraftConfirmation } = require('./bookingDrafts');
const { isEquivalentConfirmation } = require('../../utils/conversationGuardrails');

const CONCRETE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
const ALLOWED_AI_ACTIONS = new Set([
  "SERVICE_DEGRADED",
  "INVALID_TIME_INPUT",
  "CREATE_BOOKING",
  "CHECK_AVAILABILITY",
  "LIST_ACTIVE_BOOKINGS",
  "AWAIT_COURT_SELECTION",
  "CANCEL_BOOKING",
  "FIXED_TURN_REQUEST",
]);

const parseAttendanceAnswer = (value = "") => {
  const text = normalizeLooseText(value);
  const yesSet = new Set(["1", "si asisto"]);
  const noSet = new Set(["2", "no asisto"]);

  if (yesSet.has(text)) return "YES";
  if (noSet.has(text)) return "NO";
  return null;
};

const buildAttendanceOptionsOnlyReply = () =>
  "Para este turno solo puedo recibir una opción:\n1) SI ASISTO\n2) NO ASISTO";

const parseStrictYesNoAnswer = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return null;

  const yesValues = new Set(["si", "si.", "s", "yes"]);
  const noValues = new Set(["no", "n"]);

  if (yesValues.has(text)) return "YES";
  if (noValues.has(text)) return "NO";
  return null;
};

const parseStrictCancel = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  return /\bcancel(ar|ame|a|ado|o)?\b/.test(text) || /\banul(ar|o|ado|ada|a)?\b/.test(text);
};

const parseStrictOfferConfirmation = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  if (text === "confirmar reserva" || text === "confirmar turno") return true;
  return isEquivalentConfirmation(text);
};

const getStrictInputState = (meta = {}) => {
  if (meta.awaitingAttendanceConfirmation && meta.attendanceBookingId) {
    return "ATTENDANCE_CONFIRMATION";
  }
  if (meta.awaitingBookingClientNameConfirmation) {
    return "NAME_CONFIRMATION";
  }
  if (meta.awaitingFullNameForBooking) {
    return "FULL_NAME_CAPTURE";
  }
  if (
    meta.awaitingExtraBookingConfirmation &&
    meta.pendingBooking?.dateStr &&
    meta.pendingBooking?.timeStr
  ) {
    return "EXTRA_CONFIRMATION";
  }
  if (Array.isArray(meta.pendingBookingDrafts) && meta.pendingBookingDrafts.length > 0) {
    return "DRAFT_CONFIRMATION";
  }
  if (meta.pendingBookingOffer?.dateStr && meta.pendingBookingOffer?.timeStr) {
    return "OFFER_CONFIRMATION";
  }
  return null;
};

const isAllowedInputForStrictState = (value = "", state = null, meta = {}) => {
  if (!state) return true;
  const text = normalizeLooseText(value);
  if (!text) return false;

  if (state === "ATTENDANCE_CONFIRMATION") {
    return Boolean(parseAttendanceAnswer(value));
  }
  if (state === "NAME_CONFIRMATION") {
    return Boolean(parseStrictYesNoAnswer(value));
  }
  if (state === "FULL_NAME_CAPTURE") {
    return parseStrictCancel(value) || Boolean(extractFullNameFromMessage(value));
  }
  if (state === "EXTRA_CONFIRMATION") {
    return parseStrictCancel(value) || text === "confirmar extra";
  }
  if (state === "DRAFT_CONFIRMATION") {
    const draftCount = Array.isArray(meta.pendingBookingDrafts)
      ? meta.pendingBookingDrafts.length
      : 0;
    return parseStrictCancel(value) || Boolean(parseStrictDraftConfirmation(value, draftCount));
  }
  if (state === "OFFER_CONFIRMATION") {
    return parseStrictCancel(value) || parseStrictOfferConfirmation(value);
  }
  return true;
};

const buildStrictStateInvalidInputReply = (state = null, meta = {}) => {
  if (state === "ATTENDANCE_CONFIRMATION") {
    return buildAttendanceOptionsOnlyReply();
  }
  if (state === "NAME_CONFIRMATION") {
    return "Para continuar, respondé únicamente *SI* o *NO*.";
  }
  if (state === "FULL_NAME_CAPTURE") {
    return (
      "Para continuar con tu reserva, enviame solo tu *nombre completo* (ej: *Juan Pérez*) " +
      "o escribí *CANCELAR*."
    );
  }
  if (state === "EXTRA_CONFIRMATION") {
    return "Para continuar, respondé exactamente *CONFIRMAR EXTRA* o *CANCELAR*.";
  }
  if (state === "DRAFT_CONFIRMATION") {
    const draftCount = Array.isArray(meta.pendingBookingDrafts)
      ? meta.pendingBookingDrafts.length
      : 0;
    return draftCount > 1
      ? "Para continuar, respondé *CONFIRMAR TODO*, *CONFIRMAR A*/*B*... o *CANCELAR*."
      : "Para continuar, confirmá con *SI*, *OK*, *DALE* o *CONFIRMAR RESERVA*; o cancelá con *CANCELAR*.";
  }
  if (state === "OFFER_CONFIRMATION") {
    return "Para continuar, confirmá con *SI*, *OK*, *DALE* o *CONFIRMAR RESERVA*; o cancelá con *CANCELAR*.";
  }
  return "No pude procesar ese mensaje. Probá de nuevo con una instrucción concreta.";
};

const isAwaitingConcreteAnswer = (meta = {}) =>
  Boolean(
    meta.awaitingAttendanceConfirmation ||
      meta.awaitingFullNameForBooking ||
      meta.awaitingBookingClientNameConfirmation ||
      meta.awaitingExtraBookingConfirmation ||
      (Array.isArray(meta.pendingBookingDrafts) &&
        meta.pendingBookingDrafts.length > 0) ||
      (meta.pendingBookingOffer?.dateStr && meta.pendingBookingOffer?.timeStr),
  );

const enforceStrictQuestionFlowReply = (rawReply = "") => {
  const reply = String(rawReply || "").trim();
  if (!reply) return reply;

  const normalized = normalizeSpanishText(reply);
  if (
    /nombre[^.?!\n]*(fecha|hora)|(?:fecha|hora)[^.?!\n]*nombre/.test(normalized)
  ) {
    return "Antes de continuar, pasame tu *nombre completo* (ej: *Juan Pérez*).";
  }
  if (/fecha[^.?!\n]*hora|hora[^.?!\n]*fecha/.test(normalized)) {
    return "Antes de continuar, decime solo la *fecha* del turno (ej: *hoy*, *mañana* o *2026-04-07*).";
  }

  const questionMarks = (reply.match(/\?/g) || []).length;
  if (questionMarks <= 1) return reply;

  const firstQuestionMatch = reply.match(/[\s\S]*?\?/);
  const firstQuestion = firstQuestionMatch?.[0]?.trim();
  if (!firstQuestion) return reply;
  return `${firstQuestion}\n\nRespondé eso y avanzamos paso a paso.`;
};

module.exports = {
  CONCRETE_RESPONSE_TIMEOUT_MS,
  ALLOWED_AI_ACTIONS,
  parseAttendanceAnswer,
  buildAttendanceOptionsOnlyReply,
  parseStrictYesNoAnswer,
  parseStrictCancel,
  parseStrictOfferConfirmation,
  getStrictInputState,
  isAllowedInputForStrictState,
  buildStrictStateInvalidInputReply,
  isAwaitingConcreteAnswer,
  enforceStrictQuestionFlowReply,
};