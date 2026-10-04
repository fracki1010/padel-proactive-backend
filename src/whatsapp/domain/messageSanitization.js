'use strict';

const { normalizeHomoglyphs } = require('../../utils/normalizeHomoglyphs');

const normalizeSpanishText = (text = "") =>
  String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeNameText = (value = "") =>
  String(value)
    .trim()
    .replace(/\s+/g, " ");

const normalizeLooseText = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sanitizeIncomingUserMessage = (value = "") => {
  const clean = String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeHomoglyphs(clean);
};

const isPromptInjectionAttempt = (value = "") => {
  const text = normalizeSpanishText(value);
  if (!text) return false;
  return (
    /\bignora(?:r)?\b.*\b(instrucciones?|reglas?)\b/.test(text) ||
    /\ba partir de ahora\b.*\b(responde|responder|contesta|contestar)\b/.test(text) ||
    /\bresponde?\s+solo\b/.test(text) ||
    /\bactua?\s+como\b/.test(text) ||
    /\bsystem prompt\b/.test(text) ||
    /\bdesobedece\b/.test(text)
  );
};

const sanitizeModelOnlyMessage = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  const normalized = normalizeSpanishText(raw);
  if (
    /\breserva\s+confirmada\b/.test(normalized) ||
    /\bturno\s+(cancelado|anulado)\b/.test(normalized)
  ) {
    return (
      "Para evitar errores, solo confirmo o cancelo turnos cuando tengo " +
      "fecha, hora y validación del flujo correspondiente."
    );
  }
  return raw;
};

module.exports = {
  normalizeSpanishText,
  normalizeNameText,
  normalizeLooseText,
  sanitizeIncomingUserMessage,
  sanitizeModelOnlyMessage,
  isPromptInjectionAttempt,
};