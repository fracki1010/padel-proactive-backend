"use strict";

const { getFormattedDate } = require("../../utils/getFormattedDate");
const { normalizeSpanishText } = require("./messageSanitization");

// El orden importa: las frases de "próximo" son más específicas que "hoy".
// Un mensaje como "el jueves que viene" debe resolverse como NEXT, no TODAY.
const NEXT_CHOICE_PATTERNS = [
  /\bel proximo\b/,
  /\bla proxima\b/,
  /\bproximo\b/,
  /\bproxima\b/,
  /\bel que viene\b/,
  /\bla que viene\b/,
  /\bque viene\b/,
  /\bsiguiente\b/,
  /\bla semana que viene\b/,
  /\bla semana proxima\b/,
  /\bsemana siguiente\b/,
  /\bnext\b/,
];

const TODAY_CHOICE_PATTERNS = [
  /\bhoy\b/,
  /\bpara hoy\b/,
  /\bhoy mismo\b/,
  /\bel de hoy\b/,
  /\beste mismo dia\b/,
];

const resolveWeekdayChoiceReply = (reply = "") => {
  const text = normalizeSpanishText(reply);
  if (!text) return null;

  if (NEXT_CHOICE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "NEXT";
  }
  if (TODAY_CHOICE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "TODAY";
  }
  return null;
};

const resolveWeekdayChoiceDate = (reply = "", { todayIso, nextIso } = {}) => {
  const choice = resolveWeekdayChoiceReply(reply);
  if (!choice) {
    return { matched: false, choice: null, date: null };
  }
  return {
    matched: true,
    choice,
    date: choice === "TODAY" ? todayIso : nextIso,
  };
};

const buildWeekdayDisambiguationQuestion = ({
  weekdayName = "",
  todayIso = "",
  nextIso = "",
} = {}) =>
  `¿Querés *hoy* (${getFormattedDate(todayIso)}) o el *${weekdayName} que viene* (${getFormattedDate(nextIso)})?`;

module.exports = {
  buildWeekdayDisambiguationQuestion,
  resolveWeekdayChoiceReply,
  resolveWeekdayChoiceDate,
};
