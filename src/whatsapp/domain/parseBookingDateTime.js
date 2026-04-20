const { parseTime, hasInvalidTimeInput } = require("../../utils/timeParser");

const WEEKDAY_MAP = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
};

const normalizeSpanishText = (value = "") =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const toIsoDate = (dateObj) => {
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getNowInTimezone = (now = new Date(), timezone = "America/Argentina/Buenos_Aires") =>
  new Date(now.toLocaleString("en-US", { timeZone: timezone }));

const getTodayIso = (now = new Date(), timezone = "America/Argentina/Buenos_Aires") => {
  const date = getNowInTimezone(now, timezone);
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  return toIsoDate(utc);
};

const addDays = (isoDate, days) => {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return toIsoDate(date);
};

const resolveWeekday = (weekday, now = new Date(), timezone = "America/Argentina/Buenos_Aires") => {
  const tzNow = getNowInTimezone(now, timezone);
  const currentWeekday = tzNow.getDay();
  let diff = (weekday - currentWeekday + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(getTodayIso(now, timezone), diff);
};

const parseDate = (input = "", now = new Date(), timezone = "America/Argentina/Buenos_Aires") => {
  const text = normalizeSpanishText(input);
  const today = getTodayIso(now, timezone);

  if (/\bpasado manana\b/.test(text)) {
    return { date: addDays(today, 2), relativeDate: "PASADO_MANANA" };
  }
  if (/\bmanana\b/.test(text)) {
    return { date: addDays(today, 1), relativeDate: "MANANA" };
  }
  if (/\bhoy\b/.test(text)) {
    return { date: today, relativeDate: "HOY" };
  }

  for (const [name, index] of Object.entries(WEEKDAY_MAP)) {
    const matcher = new RegExp(`\\b${name}\\b`, "i");
    if (matcher.test(text)) {
      return {
        date: resolveWeekday(index, now, timezone),
        weekday: name,
        relativeDate: "WEEKDAY",
      };
    }
  }

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch?.[1]) {
    return { date: isoMatch[1], relativeDate: "ISO" };
  }

  const dmyMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const currentYear = Number(today.slice(0, 4));
    const rawYear = dmyMatch[3];
    const year = rawYear
      ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
      : currentYear;
    const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { date: candidate, relativeDate: "DMY" };
  }

  return { date: null, relativeDate: null };
};

const inferHourFromNaturalLanguage = (input = "") => {
  const normalized = normalizeSpanishText(input);

  const byNight = normalized.match(/\b(\d{1,2})\s*(?:de\s+la\s+)?noche\b/);
  if (byNight) {
    const h = Number(byNight[1]);
    if (h >= 1 && h <= 11) return `${String(h + 12).padStart(2, "0")}:00`;
    if (h >= 12 && h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }

  const byAfternoon = normalized.match(/\b(\d{1,2})\s*(?:de\s+la\s+)?tarde\b/);
  if (byAfternoon) {
    const h = Number(byAfternoon[1]);
    if (h >= 1 && h <= 11) return `${String(h + 12).padStart(2, "0")}:00`;
    if (h >= 12 && h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }

  const plainHourMatch = normalized.match(
    /(?:\ba\s+las\s+|\b(?:hoy|manana|pasado\s+manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+|\bdame\s+|\bsi\s+no\s+hay\s+\d{1,2}\s*,?\s*dame\s+)(\d{1,2})\b/,
  );

  if (plainHourMatch) {
    const h = Number(plainHourMatch[1]);
    if (h >= 0 && h <= 23) {
      const hasMorningHint = /\bmanana\b|\bam\b/.test(normalized);
      const hasEveningHint = /\bnoche\b|\btarde\b|\breservar\b|\bturno\b/.test(normalized);
      if (!hasMorningHint && hasEveningHint && h >= 1 && h <= 11) {
        return `${String(h + 12).padStart(2, "0")}:00`;
      }
      return `${String(h).padStart(2, "0")}:00`;
    }
  }

  return null;
};

const parseTimeEntity = (input = "") => {
  if (hasInvalidTimeInput(input)) {
    return { time: null, invalidTime: true };
  }

  const normalized = normalizeSpanishText(input);
  const hhmmMatch = normalized.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (hhmmMatch) {
    const normalizedTime = parseTime(`${hhmmMatch[1]}:${hhmmMatch[2]}`);
    return { time: normalizedTime, invalidTime: false };
  }

  const natural = inferHourFromNaturalLanguage(input);
  if (natural) {
    return { time: parseTime(natural), invalidTime: false };
  }

  return { time: null, invalidTime: false };
};

const parseBookingDateTime = (input = "", now = new Date(), timezone = "America/Argentina/Buenos_Aires") => {
  const dateParsed = parseDate(input, now, timezone);
  const timeParsed = parseTimeEntity(input);

  return {
    date: dateParsed.date,
    time: timeParsed.time,
    dateTime: dateParsed.date && timeParsed.time ? `${dateParsed.date} ${timeParsed.time}` : null,
    relativeDate: dateParsed.relativeDate,
    weekday: dateParsed.weekday || null,
    invalidTime: Boolean(timeParsed.invalidTime),
    raw: {
      date: dateParsed,
      time: timeParsed,
    },
  };
};

module.exports = {
  parseBookingDateTime,
  getTodayIso,
};
