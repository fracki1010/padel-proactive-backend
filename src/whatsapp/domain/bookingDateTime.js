'use strict';

const { parseTime } = require('../../utils/timeParser');
const {
  parseBookingDateTime,
  getTodayIso,
} = require('./parseBookingDateTime');
const { normalizeSpanishText } = require('./messageSanitization');

const getTodayIsoArgentina = () => {
  return getTodayIso(new Date(), "America/Argentina/Buenos_Aires");
};

const normalizeTimeString = (rawTime) => {
  return parseTime(rawTime);
};

const isValidIsoDate = (value) => {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const addDaysToIsoDate = (isoDate, days) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getArgentinaDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === "year")?.value || 0);
  const month = Number(parts.find((p) => p.type === "month")?.value || 0);
  const day = Number(parts.find((p) => p.type === "day")?.value || 0);
  const weekdayRaw = String(
    parts.find((p) => p.type === "weekday")?.value || "",
  ).toLowerCase();

  const weekdayMap = {
    lun: 1,
    mar: 2,
    mie: 3,
    mié: 3,
    jue: 4,
    vie: 5,
    sab: 6,
    sáb: 6,
    dom: 0,
  };

  return {
    year,
    month,
    day,
    weekday: weekdayMap[weekdayRaw] ?? 0,
  };
};

const getNextWeekdayIsoDate = (targetWeekday, options = {}) => {
  const includeToday = Boolean(options.includeToday);
  const today = getArgentinaDateParts();
  const todayIso = `${today.year}-${String(today.month).padStart(2, "0")}-${String(
    today.day,
  ).padStart(2, "0")}`;

  let diff = (targetWeekday - today.weekday + 7) % 7;
  if (!includeToday && diff === 0) diff = 7;
  return addDaysToIsoDate(todayIso, diff);
};

const extractDateFromMessage = (rawText) => {
  return parseBookingDateTime(rawText, new Date(), "America/Argentina/Buenos_Aires").date;
};

const extractTimeFromMessage = (rawText) => {
  return parseBookingDateTime(rawText, new Date(), "America/Argentina/Buenos_Aires").time;
};

const formatIsoDateAsDayMonthYear = (isoDate = "") => {
  if (!isValidIsoDate(isoDate)) return String(isoDate || "");
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
};

const toMinutes = (timeStr = "") => {
  const [h, m] = String(timeStr).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

const extractDayPeriodFromMessage = (rawText = "") => {
  const text = normalizeSpanishText(rawText);
  if (
    /\b(?:por|en|de|a)\s+la\s+manana\b/.test(text) ||
    /\bla\s+manana\b/.test(text)
  ) {
    return "MORNING";
  }
  if (
    /\b(?:por|en|de|a)\s+la\s+tarde\b/.test(text) ||
    /\bla\s+tarde\b/.test(text)
  ) {
    return "AFTERNOON";
  }
  if (
    /\b(?:por|en|de|a)\s+la\s+noche\b/.test(text) ||
    /\bla\s+noche\b/.test(text)
  ) {
    return "NIGHT";
  }
  return null;
};

const getDayPeriodLabel = (period) => {
  if (period === "MORNING") return "mañana";
  if (period === "AFTERNOON") return "tarde";
  if (period === "NIGHT") return "noche";
  return null;
};

const filterSlotsByPeriod = (slots = [], period = null) => {
  if (!period) return slots;
  return slots.filter((slot) => {
    const minutes = toMinutes(slot.time);
    if (minutes === null) return false;
    if (period === "MORNING") return minutes >= 6 * 60 && minutes < 12 * 60;
    if (period === "AFTERNOON") return minutes >= 12 * 60 && minutes < 19 * 60;
    if (period === "NIGHT") return minutes >= 19 * 60 && minutes <= 23 * 60 + 59;
    return true;
  });
};

const formatSlotLines = (slot) => {
  if (slot.courtTypes?.length > 0) {
    return slot.courtTypes.map((ct) => `• ${slot.time} (${ct.type}) ($${slot.price})`);
  }
  return [`• ${slot.time} ($${slot.price})`];
};

const timeToMinutes = (timeStr = "") => {
  const [h, m] = String(timeStr).split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

const findNearbySlots = (requestedTime = "", slots = [], windowMinutes = 90) => {
  const reqMin = timeToMinutes(requestedTime);
  if (reqMin === null) return [];
  return slots.filter((s) => {
    const slotMin = timeToMinutes(s.time);
    return slotMin !== null && Math.abs(slotMin - reqMin) <= windowMinutes && slotMin !== reqMin;
  });
};

module.exports = {
  getTodayIsoArgentina,
  normalizeTimeString,
  isValidIsoDate,
  addDaysToIsoDate,
  getArgentinaDateParts,
  getNextWeekdayIsoDate,
  extractDateFromMessage,
  extractTimeFromMessage,
  formatIsoDateAsDayMonthYear,
  toMinutes,
  extractDayPeriodFromMessage,
  getDayPeriodLabel,
  filterSlotsByPeriod,
  formatSlotLines,
  timeToMinutes,
  findNearbySlots,
};