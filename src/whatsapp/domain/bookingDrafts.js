'use strict';

const {
  normalizeSpanishText,
  normalizeLooseText,
} = require('./messageSanitization');
const {
  extractDateFromMessage,
  extractTimeFromMessage,
  normalizeTimeString,
} = require('./bookingDateTime');
const { isEquivalentConfirmation } = require('../../utils/conversationGuardrails');

const toDraftLabelByIndex = (index) => String.fromCharCode(65 + index);

const buildDraftFromRaw = (entry = {}, index = 0) => ({
  id: toDraftLabelByIndex(index),
  courtName: (entry.courtName || "INDIFERENTE").trim(),
  dateStr: entry.dateStr,
  timeStr: entry.timeStr,
});

const extractRequestedCourtsCount = (rawText = "") => {
  const normalizedText = normalizeSpanishText(rawText);
  const wordToNumber = {
    un: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
  };

  const numericMatch = normalizedText.match(
    /\b(\d+)\s+(?:cancha|canchas|turno|turnos|reserva|reservas)\b/,
  );
  if (numericMatch) return Math.max(1, Number(numericMatch[1]));

  const wordMatch = normalizedText.match(
    /\b(un|una|dos|tres|cuatro|cinco|seis)\s+(?:cancha|canchas|turno|turnos|reserva|reservas)\b/,
  );
  if (wordMatch) return Math.max(1, wordToNumber[wordMatch[1]] || 1);

  const byMultiplier = normalizedText.match(/\bx\s*(\d+)\b/);
  if (byMultiplier) return Math.max(1, Number(byMultiplier[1]));

  return 1;
};

const parseStrictDraftConfirmation = (value = "", draftCount = 1) => {
  const text = normalizeLooseText(value);
  if (!text) return null;

  if (/^confirmar\s+todo$/.test(text)) {
    return { type: "ALL" };
  }

  const byLetter = text.match(/^confirmar\s+([a-z])$/);
  if (byLetter) {
    const index = byLetter[1].charCodeAt(0) - 97;
    if (index >= 0 && index < draftCount) {
      return { type: "ONE", index };
    }
    return null;
  }

  if (draftCount === 1) {
    if (/^confirmar(?:\s+reserva|\s+turno)?$/.test(text)) {
      return { type: "ALL" };
    }
    if (isEquivalentConfirmation(text)) {
      return { type: "ALL" };
    }
  }

  if (text === "confirmar extra") {
    return { type: "ALL" };
  }

  return null;
};

const extractBookingDraftsFromMessage = (rawText, fallbackCourt = "INDIFERENTE") => {
  const text = String(rawText || "").trim();
  if (!text) return [];

  const rawSegments = text
    .split(/\s+y\s+/i)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!rawSegments.length) return [];

  const draftCandidates = [];
  for (const segment of rawSegments) {
    const dateStr = extractDateFromMessage(segment);
    const timeStr = normalizeTimeString(extractTimeFromMessage(segment));
    if (dateStr && timeStr) {
      draftCandidates.push({
        dateStr,
        timeStr,
        courtName: fallbackCourt,
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of draftCandidates) {
    const key = `${candidate.dateStr}|${candidate.timeStr}|${candidate.courtName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  if (unique.length >= 2) {
    return unique.map((candidate, index) => buildDraftFromRaw(candidate, index));
  }

  if (unique.length === 1) {
    const requestedCourtsCount = extractRequestedCourtsCount(rawText);
    if (requestedCourtsCount >= 2) {
      const cappedCount = Math.min(requestedCourtsCount, 6);
      return Array.from({ length: cappedCount }, (_, index) =>
        buildDraftFromRaw(unique[0], index),
      );
    }
  }

  return [];
};

module.exports = {
  toDraftLabelByIndex,
  buildDraftFromRaw,
  extractRequestedCourtsCount,
  parseStrictDraftConfirmation,
  extractBookingDraftsFromMessage,
};