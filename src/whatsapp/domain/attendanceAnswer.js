'use strict';

const { normalizeLooseText } = require('./messageSanitization');

// Tolerant recognition of attendance-confirmation replies.
// The prompt asks for "1) SI ASISTO" / "2) NO ASISTO", but real clients answer
// with plenty of natural variants ("sí, voy", "no puedo", "confirmo", ...).
// These pure helpers keep that recognition out of the handler so it is testable
// and reusable by the sessionless fallback.

const ATTENDANCE_YES_VALUES = new Set([
  '1',
  's',
  'si',
  'yes',
  'claro',
  'dale',
  'ok',
  'okay',
  'listo',
  'asisto',
  'asistire',
  'asistir',
  'voy',
  'voy a ir',
  'voy a asistir',
  'quiero ir',
  'quiero asistir',
  'confirmo',
  'confirmo asistencia',
  'confirmo que asisto',
  'confirmar asistencia',
  'si asisto',
  'si asistire',
  'si voy',
  'si voy a ir',
  'si voy a asistir',
  'si quiero ir',
  'si quiero asistir',
]);

const ATTENDANCE_NO_VALUES = new Set([
  '2',
  'n',
  'no',
  'baja',
  'no asisto',
  'no asistire',
  'no asistir',
  'no voy',
  'no voy a ir',
  'no puedo',
  'no puedo ir',
  'no quiero ir',
  'no quiero asistir',
]);

// "si ..." followed by an attendance verb, tolerating filler ("si, quiero ir").
const ATTENDANCE_YES_PREFIX_REGEX =
  /^si(?:\s+(?:asisto|asistire|asistir|voy|puedo|quiero|ir)\b.*)?$/;

// "no ..." only when followed by a decline verb (or another "no"), so plain
// "no entendi" or "no se" never get interpreted as a decline.
const ATTENDANCE_NO_PREFIX_REGEX =
  /^no(?:\s+(?:asisto|asistire|asistir|voy|puedo|quiero|ir|no)\b.*)?$/;

const ATTENDANCE_BARE_YES_REGEX = /^(?:asist|asistire|asistir|voy)\b/;

const parseAttendanceAnswer = (value = '') => {
  const text = normalizeLooseText(value);
  if (!text) return null;

  if (ATTENDANCE_YES_VALUES.has(text)) return 'YES';
  if (ATTENDANCE_NO_VALUES.has(text)) return 'NO';

  // Negative intent wins so "no puedo ir" is never read as affirmative.
  if (ATTENDANCE_NO_PREFIX_REGEX.test(text)) return 'NO';
  if (ATTENDANCE_YES_PREFIX_REGEX.test(text)) return 'YES';
  if (ATTENDANCE_BARE_YES_REGEX.test(text)) return 'YES';

  return null;
};

// Broader "this looks like an attendance reply" signal, used to trigger the
// sessionless fallback (e.g. when the incoming chatId is an @lid alias that
// does not match the session used to send the reminder).
const looksLikeAttendanceAnswer = (value = '') => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  if (parseAttendanceAnswer(value)) return true;
  if (/\basist/.test(text)) return true;
  if (/\bvoy a ir\b/.test(text)) return true;
  if (/\bconfirmo asistencia\b/.test(text)) return true;
  return false;
};

// Attendance fallback only trusts reminders that were sent recently.
const ATTENDANCE_FALLBACK_WINDOW_MS = 6 * 60 * 60 * 1000;

const isRecentAttendancePrompt = (
  sentAt,
  now = Date.now(),
  windowMs = ATTENDANCE_FALLBACK_WINDOW_MS,
) => {
  if (!sentAt) return false;
  const timestamp = new Date(sentAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp <= windowMs;
};

module.exports = {
  parseAttendanceAnswer,
  looksLikeAttendanceAnswer,
  isRecentAttendancePrompt,
  ATTENDANCE_FALLBACK_WINDOW_MS,
};
