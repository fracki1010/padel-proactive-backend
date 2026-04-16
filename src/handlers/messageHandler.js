const groqService = require("../services/groqService");
const sessionService = require("../services/sessionService");
const bookingService = require("../services/bookingService");
const userService = require("../services/userService");
const Booking = require("../models/booking.model");
const User = require("../models/user.model");
const TimeSlot = require("../models/timeSlot.model");
const { sendAdminNotification } = require("../services/notificationService");
const {
  DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
  getTrustedClientConfirmationCount,
} = require("../services/appConfig.service");
const { getFormattedDate } = require("../utils/getFormattedDate");
const { getNumberByUser } = require("../utils/getNumberByUser");

// --- FUNCIÓN HELPER PARA EXTRAER JSON ---
// Busca cualquier cosa que parezca un objeto JSON {...} dentro del texto
const extractJSON = (text) => {
  try {
    // 1. Intento directo
    return JSON.parse(text);
  } catch (e) {
    // 2. Buscar patrón { ... } ignorando lo que haya fuera
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        return null; // No es un JSON válido
      }
    }
    return null;
  }
};

const getTodayIsoArgentina = () => {
  const argentinaNow = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
    }),
  );
  const year = argentinaNow.getFullYear();
  const month = String(argentinaNow.getMonth() + 1).padStart(2, "0");
  const day = String(argentinaNow.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeTimeString = (rawTime) => {
  if (!rawTime && rawTime !== 0) return null;
  const text = String(rawTime).trim();
  const fullMatch = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (fullMatch) {
    return `${fullMatch[1].padStart(2, "0")}:${fullMatch[2]}`;
  }

  const hourOnlyMatch = text.match(/^([01]?\d|2[0-3])$/);
  if (hourOnlyMatch) {
    return `${hourOnlyMatch[1].padStart(2, "0")}:00`;
  }

  return null;
};

const isLikelyPhoneNumber = (value = "") => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
};

const isValidIsoDate = (value) => {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const normalizeSpanishText = (text = "") =>
  String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

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
  const text = normalizeSpanishText(rawText);
  const today = getTodayIsoArgentina();
  const textWithoutMorningPeriod = text
    .replace(/\b(?:de|por|en|a)\s+la\s+manana\b/g, " ")
    .replace(/\bla\s+manana\b/g, " ")
    .replace(/\bde\s+manana\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.includes("pasado manana")) return addDaysToIsoDate(today, 2);
  if (textWithoutMorningPeriod.includes("manana"))
    return addDaysToIsoDate(today, 1);
  if (text.includes("hoy")) return today;

  const weekdayMatchers = [
    { pattern: /\blunes\b/, weekday: 1 },
    { pattern: /\bmartes\b/, weekday: 2 },
    { pattern: /\bmiercoles\b/, weekday: 3 },
    { pattern: /\bjueves\b/, weekday: 4 },
    { pattern: /\bviernes\b/, weekday: 5 },
    { pattern: /\bsabado\b/, weekday: 6 },
    { pattern: /\bdomingo\b/, weekday: 0 },
  ];

  for (const matcher of weekdayMatchers) {
    if (matcher.pattern.test(text)) {
      return getNextWeekdayIsoDate(matcher.weekday, { includeToday: true });
    }
  }

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch && isValidIsoDate(isoMatch[1])) return isoMatch[1];

  const dmyMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (!dmyMatch) return null;

  const day = Number(dmyMatch[1]);
  const month = Number(dmyMatch[2]);
  const currentYear = Number(today.slice(0, 4));
  const rawYear = dmyMatch[3];
  let year = currentYear;
  if (rawYear) {
    year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
  }

  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidIsoDate(candidate) ? candidate : null;
};

const extractTimeFromMessage = (rawText) => {
  const text = normalizeSpanishText(rawText);

  const hourMinuteMatch = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (hourMinuteMatch) {
    return `${hourMinuteMatch[1].padStart(2, "0")}:${hourMinuteMatch[2]}`;
  }

  const hourHsMatch = text.match(/\b([01]?\d|2[0-3])\s*(?:hs|h)\b/);
  if (hourHsMatch) return `${hourHsMatch[1].padStart(2, "0")}:00`;

  const aLasMatch = text.match(/a\s*las\s*([01]?\d|2[0-3])\b/);
  if (aLasMatch) return `${aLasMatch[1].padStart(2, "0")}:00`;

  const compactHourMinuteMatch = text.match(/\b([01]\d|2[0-3])([0-5]\d)\b/);
  if (compactHourMinuteMatch) {
    return `${compactHourMinuteMatch[1]}:${compactHourMinuteMatch[2]}`;
  }

  return null;
};

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

  if (hasAvailabilityIntent && (date || time)) {
    return {
      action: "CHECK_AVAILABILITY",
      date: date || getTodayIsoArgentina(),
      time,
    };
  }

  return null;
};

const normalizeNameText = (value = "") =>
  String(value)
    .trim()
    .replace(/\s+/g, " ");

const normalizeLooseText = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
  return /^(si|dale|ok|confirmo|listo)\b/.test(text);
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

const isLikelyFullName = (value = "") => {
  const clean = normalizeNameText(value);
  const parts = clean.split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}$/.test(part));
};

const isPlaceholderName = (value = "") => {
  const normalized = normalizeSpanishText(value)
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const placeholders = new Set([
    "juan perez",
    "cliente",
    "cliente desconocido",
    "nombre apellido",
    "socio",
    "invitado",
  ]);
  return placeholders.has(normalized);
};

const isNonNameReply = (value = "") => {
  const normalized = normalizeSpanishText(value)
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;

  const blockedPhrases = [
    "si",
    "si por favor",
    "por favor",
    "dale",
    "ok",
    "okay",
    "oka",
    "listo",
    "de una",
    "confirmo",
    "confirmado",
    "reservalo",
    "reserva",
    "hazlo",
    "hace la reserva",
    "quiero reservar",
    "quiero una cancha",
  ];

  if (blockedPhrases.includes(normalized)) return true;

  return /^(si|dale|ok|listo|confirmo)\b/.test(normalized);
};

const extractFullNameFromMessage = (rawMessage, aiCandidate = "") => {
  const raw = String(rawMessage || "").trim();
  if (isNonNameReply(raw)) return null;

  const explicitPatterns = [
    /(?:mi\s+nombre\s+es|soy)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{4,})/i,
    /^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{4,})$/,
  ];

  for (const pattern of explicitPatterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const candidate = normalizeNameText(match[1]);
    if (isLikelyFullName(candidate) && !isPlaceholderName(candidate)) {
      return candidate;
    }
  }

  const candidateFromAi = normalizeNameText(aiCandidate);
  if (
    candidateFromAi &&
    isLikelyFullName(candidateFromAi) &&
    !isPlaceholderName(candidateFromAi) &&
    !isNonNameReply(candidateFromAi)
  ) {
    const normalizedMessage = normalizeSpanishText(raw)
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedCandidate = normalizeSpanishText(candidateFromAi)
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (normalizedMessage.includes(normalizedCandidate)) {
      return candidateFromAi;
    }
  }

  return null;
};

const isValidClientName = (value = "") =>
  isLikelyFullName(value) &&
  !isPlaceholderName(value) &&
  !isNonNameReply(value);

const buildBookingReplyText = (requestedDate, requestedClientName, bookingResult) => {
  if (bookingResult.success) {
    return (
      `✅ *¡Reserva Confirmada!* 🎾\n\n` +
      `👤 *Jugador:* ${requestedClientName}\n` +
      `📌 *Cancha:* ${bookingResult.data.courtName}\n` +
      `📅 *Fecha:* ${getFormattedDate(requestedDate)}\n` +
      `⏰ *Hora:* ${bookingResult.data.startTime} - ${bookingResult.data.endTime}\n` +
      `💰 *Precio:* $${bookingResult.data.price}`
    );
  }

  if (bookingResult.error === "BUSY") return "🚫 Ese turno ya está ocupado. ¿Te busco otro?";
  if (bookingResult.error === "INVALID_TIME") return "⚠️ Ese horario no existe en la grilla.";
  if (bookingResult.error === "PAST_TIME") {
    return "⏰ Ese horario ya pasó o ya comenzó. Decime otro turno y te ayudo a reservarlo.";
  }
  if (bookingResult.error === "CANCHA_NOT_FOUND") {
    return "⚠️ No encontré esa cancha. Decime el nombre exacto o te asigno la primera disponible.";
  }
  if (bookingResult.error === "SUSPENDED") {
    return (
      `🚫 *Tu cuenta está suspendida.*\n\n` +
      `Has acumulado demasiadas cancelaciones y no podés reservar nuevos turnos por el momento.\n` +
      `Contactá a la administración del club para regularizar tu situación.`
    );
  }
  if (bookingResult.error === "ALREADY_BOOKED") {
    return (
      `ℹ️ Ya tenés una reserva activa para el *${getFormattedDate(requestedDate)}* a las *${bookingResult.data?.startTime || "ese horario"}*.\n\n` +
      `Si querés otra cancha u otro horario, decime y te ayudo.`
    );
  }
  if (bookingResult.error === "DAILY_LIMIT_REACHED") {
    const limit = bookingResult?.data?.limit || 0;
    return `⚠️ Ya alcanzaste el límite de ${limit} reservas para el ${getFormattedDate(requestedDate)}.`;
  }
  return "⚠️ Hubo un error técnico al reservar.";
};

const buildSecondBookingConfirmationText = () =>
  "Ya tenés una reserva activa. Para continuar sin errores, respondé *CONFIRMAR EXTRA* o *CANCELAR*.";

const formatIsoDateAsDayMonthYear = (isoDate = "") => {
  if (!isValidIsoDate(isoDate)) return String(isoDate || "");
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
};

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

const buildActiveBookingsReply = (bookings = []) => {
  if (!Array.isArray(bookings) || bookings.length === 0) {
    return "📭 No encontré reservas vigentes para este número de WhatsApp.";
  }

  const lines = bookings.map((booking, index) => {
    const dateText = getFormattedDate(booking.date);
    const timeText = booking.endTime
      ? `${booking.startTime} - ${booking.endTime}`
      : booking.startTime;
    return (
      `${index + 1}) 📅 ${dateText}\n` +
      `   ⏰ ${timeText}\n` +
      `   📌 ${booking.courtName}`
    );
  });

  return `🎾 *Estas son tus reservas vigentes:*\n\n${lines.join("\n\n")}`;
};

const buildBookingDraftSummaryReply = async ({
  companyId = null,
  clientName = "Cliente",
  drafts = [],
}) => {
  const lines = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    const slot = await TimeSlot.findOne({
      companyId: companyId || null,
      startTime: draft.timeStr,
    })
      .select("endTime price")
      .lean();

    const priceText =
      typeof slot?.price === "number" ? `$${slot.price}` : null;
    const endTimeText = slot?.endTime ? ` - ${slot.endTime}` : "";
    const priceLine = priceText ? `\n   💰 Precio: ${priceText}` : "";
    lines.push(
      `${draft.id}) 👤 ${clientName}\n` +
        `   📌 Cancha: ${draft.courtName}\n` +
        `   📅 Fecha: ${formatIsoDateAsDayMonthYear(draft.dateStr)}\n` +
        `   ⏰ Hora: ${draft.timeStr}${endTimeText}` +
        priceLine,
    );
  }

  const confirmLine =
    drafts.length === 1
      ? "Para avanzar respondé: *CONFIRMAR RESERVA* o *CANCELAR*."
      : "Para avanzar respondé: *CONFIRMAR TODO*, *CONFIRMAR A*, *CONFIRMAR B* o *CANCELAR*.";

  return (
    `Resumen previo (sin reservar todavía):\n\n${lines.join("\n\n")}\n\n` +
    `${confirmLine}`
  );
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

const buildAvailabilityResponse = async ({
  companyId = null,
  requestedDate,
  requestedTime = null,
  userMessage = "",
  availability,
  modePrefix = "",
}) => {
  const dayPeriod = extractDayPeriodFromMessage(userMessage);
  const periodLabel = getDayPeriodLabel(dayPeriod);
  const prefix = modePrefix ? `${modePrefix}\n` : "";
  const requestedCourtsCount = extractRequestedCourtsCount(userMessage);
  const needsMultipleCourts = requestedCourtsCount >= 2;

  if (requestedTime) {
    const slotExists = await TimeSlot.findOne({
      companyId: companyId || null,
      isActive: true,
      startTime: requestedTime,
    })
      .select("_id")
      .lean();

    if (!slotExists) {
      return {
        replyText: `${prefix}⚠️ Ese horario no existe en la grilla.`,
        pendingBookingOffer: null,
      };
    }
  }

  if (!availability?.success || !Array.isArray(availability.slots)) {
    return {
      replyText: `${prefix}⚠️ Hubo un problema consultando disponibilidad.`,
      pendingBookingOffer: null,
    };
  }

  if (requestedTime) {
    const exactMatch = availability.slots.find((s) => s.time === requestedTime);
    const availableCourtsInExactTime = Math.max(
      0,
      Number(exactMatch?.availableCourts || 0),
    );
    const enoughCourtsForRequest = availableCourtsInExactTime >= requestedCourtsCount;

    if (needsMultipleCourts) {
      if (exactMatch && enoughCourtsForRequest) {
        return {
          replyText:
            `${prefix}✅ Sí, tengo *${requestedCourtsCount} canchas* disponibles para el *${getFormattedDate(requestedDate)} a las ${requestedTime}*.` +
            `\n💰 Precio por cancha: $${exactMatch.price}`,
          pendingBookingOffer: null,
        };
      }

      const alternativesForRequestedCourts = availability.slots
        .filter((s) => Number(s.availableCourts || 0) >= requestedCourtsCount)
        .slice(0, 5);
      const alternativesList = alternativesForRequestedCourts
        .map((s) => `• ${s.time} (${requestedCourtsCount} canchas, $${s.price} c/u)`)
        .join("\n");

      const shortageLine = exactMatch
        ? `Solo tengo *${availableCourtsInExactTime}* libre${availableCourtsInExactTime === 1 ? "" : "s"} a esa hora.`
        : "Ese horario no tiene disponibilidad.";

      return {
        replyText:
          `${prefix}🚫 No tengo *${requestedCourtsCount} canchas* para *${requestedTime}* el ${getFormattedDate(requestedDate)}.` +
          `\n${shortageLine}\n\n` +
          (alternativesForRequestedCourts.length
            ? `Te puedo ofrecer horarios con ${requestedCourtsCount} canchas:\n${alternativesList}`
            : `No tengo otro horario con ${requestedCourtsCount} canchas libres para esa fecha.`),
        pendingBookingOffer: null,
      };
    }

    if (exactMatch) {
      return {
        replyText:
          `${prefix}✅ Sí, tengo disponibilidad para el *${getFormattedDate(requestedDate)} a las ${requestedTime}*.\n` +
          `💰 Precio: $${exactMatch.price}\n\n` +
          `_¿Te lo reservo?_`,
        pendingBookingOffer: {
          courtName: "INDIFERENTE",
          dateStr: requestedDate,
          timeStr: requestedTime,
          createdAt: Date.now(),
        },
      };
    }

    const alternatives = dayPeriod
      ? filterSlotsByPeriod(availability.slots, dayPeriod).slice(0, 5)
      : availability.slots.slice(0, 5);
    const list = alternatives.map((s) => `• ${s.time} ($${s.price})`).join("\n");
    const periodLine = periodLabel ? ` dentro de la ${periodLabel}` : "";
    return {
      replyText:
        `${prefix}🚫 No tengo disponibilidad para *${requestedTime}* el ${getFormattedDate(requestedDate)}${periodLine}.\n\n` +
        (alternatives.length
          ? `Te puedo ofrecer estos horarios:\n${list}\n\n_¿Cuál te reservo?_`
          : "No me quedan horarios disponibles para ese rango."),
      pendingBookingOffer: null,
    };
  }

  const slotsToShow = dayPeriod
    ? filterSlotsByPeriod(availability.slots, dayPeriod)
    : availability.slots;

  if (!slotsToShow.length) {
    if (dayPeriod) {
      return {
        replyText:
          `${prefix}🚫 Para la *${periodLabel}* no tengo disponibilidad el ${getFormattedDate(requestedDate)}.`,
        pendingBookingOffer: null,
      };
    }
    return {
      replyText: `${prefix}🚫 Todo ocupado para esa fecha.`,
      pendingBookingOffer: null,
    };
  }

  const lista = slotsToShow.map((s) => `• ${s.time} ($${s.price})`).join("\n");
  const periodTitle = dayPeriod ? ` en la ${periodLabel}` : "";
  return {
    replyText:
      `${prefix}📅 *Libres para el ${getFormattedDate(requestedDate)}${periodTitle}:*\n\n${lista}\n\n_¿Cuál te reservo?_`,
    pendingBookingOffer: null,
  };
};

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

const handleIncomingMessage = async (chatId, userMessage, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const client = options.client || null;
    const sessionId = companyId ? `${companyId}:${chatId}` : chatId;
    const sessionMeta = sessionService.getMeta(sessionId);

    // 1. Identificar Usuario
    const registeredUser = await userService.getUserByWhatsappId(chatId, {
      companyId,
    });
    let knownName = registeredUser ? registeredUser.name : null;
    if (knownName && !isValidClientName(knownName)) {
      knownName = null;
    }
    const number = await getNumberByUser(chatId, client);
    const registeredPhoneRaw = String(registeredUser?.phoneNumber || "").trim();
    const canonicalClientPhone =
      isLikelyPhoneNumber(registeredPhoneRaw)
        ? registeredPhoneRaw
        : number;
    console.log(`👤 Mensaje de: ${knownName || chatId}`);
    console.log(`📞 Número de WhatsApp detectado: ${number}`);
    console.log(`📇 Número canónico para reservas: ${canonicalClientPhone}`);

    if (sessionMeta.awaitingAttendanceConfirmation && sessionMeta.attendanceBookingId) {
      const attendanceBooking = await Booking.findOne({
        _id: sessionMeta.attendanceBookingId,
        companyId: companyId || null,
      }).populate("timeSlot");

      if (
        !attendanceBooking ||
        attendanceBooking.status === "cancelado" ||
        attendanceBooking.attendanceConfirmationStatus !== "pending"
      ) {
        sessionService.updateMeta(sessionId, {
          awaitingAttendanceConfirmation: false,
          attendanceBookingId: null,
        });
      } else {
        const attendanceAnswer = parseAttendanceAnswer(userMessage);
        if (!attendanceAnswer) {
          const optionsOnlyReply = buildAttendanceOptionsOnlyReply();
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", optionsOnlyReply);
          return optionsOnlyReply;
        }

        if (attendanceAnswer === "YES") {
          await Booking.updateOne(
            { _id: attendanceBooking._id },
            {
              $set: {
                attendanceConfirmationStatus: "confirmed",
                attendanceConfirmationRespondedAt: new Date(),
              },
            },
          );

          const updatedUser = await User.findOneAndUpdate(
            {
              companyId: companyId || null,
              phoneNumber: attendanceBooking.clientPhone,
            },
            {
              $inc: { attendanceConfirmedCount: 1 },
            },
            { returnDocument: "after" },
          );

          const confirmedCount = updatedUser?.attendanceConfirmedCount || 0;
          let trustedThreshold = DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT;
          try {
            trustedThreshold = await getTrustedClientConfirmationCount(companyId);
          } catch (_error) {
            trustedThreshold = DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT;
          }
          const attendanceOkReply =
            confirmedCount >= trustedThreshold
              ? "Perfecto, gracias por confirmar ✅ Ya te marcamos como cliente cumplidor, no te vamos a pedir esta confirmación previa en próximos turnos."
              : "Perfecto, gracias por confirmar ✅ Te esperamos en el club.";

          sessionService.updateMeta(sessionId, {
            awaitingAttendanceConfirmation: false,
            attendanceBookingId: null,
          });
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", attendanceOkReply);
          return attendanceOkReply;
        }

        await Booking.updateOne(
          { _id: attendanceBooking._id },
          {
            $set: {
              attendanceConfirmationStatus: "declined",
              attendanceConfirmationRespondedAt: new Date(),
            },
          },
        );

        sessionService.updateMeta(sessionId, {
          awaitingAttendanceConfirmation: false,
          attendanceBookingId: null,
        });

        try {
          await sendAdminNotification(
            "attendance_declined",
            "Cliente indicó que no asistirá",
            `Cliente: ${attendanceBooking.clientName}\nTeléfono: ${canonicalClientPhone}\nFecha: ${getFormattedDate(
              new Date(attendanceBooking.date).toISOString().slice(0, 10),
            )}\nHora: ${attendanceBooking?.timeSlot?.startTime || "N/D"}\nReserva ID: ${attendanceBooking._id}\n\nEl turno NO fue cancelado automáticamente. Requiere gestión del administrador.`,
            { bookingId: attendanceBooking._id, companyId },
            { companyId },
          );
        } catch (attendanceDeclinedNotificationError) {
          console.error(
            `[AttendanceDeclined][${companyId || "global"}] Error notificando al admin:`,
            attendanceDeclinedNotificationError?.message ||
              attendanceDeclinedNotificationError,
          );
        }
        const declinedReply =
          "Gracias por avisar. Ya notificamos al administrador para que lo resuelva o te contacte.\n" +
          "Este turno no se cancela automáticamente por esta vía; para cancelarlo, hablá con el admin.";

        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", declinedReply);
        return declinedReply;
      }
    }

    if (
      Array.isArray(sessionMeta.pendingBookingDrafts) &&
      sessionMeta.pendingBookingDrafts.length > 0
    ) {
      const pendingDrafts = sessionMeta.pendingBookingDrafts;
      const pendingClientName = normalizeNameText(
        sessionMeta.pendingBookingClientName || knownName || "",
      );
      const strictConfirmation = parseStrictDraftConfirmation(
        userMessage,
        pendingDrafts.length,
      );

      if (isNegativeBookingReply(userMessage)) {
        sessionService.updateMeta(sessionId, {
          pendingBookingDrafts: null,
          pendingBookingClientName: null,
          pendingBookingOffer: null,
          awaitingExtraBookingConfirmation: false,
        });
        const cancelDraftReply =
          pendingDrafts.length > 1
            ? "Perfecto, no reservo esos turnos."
            : "Perfecto, no reservo ese turno.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", cancelDraftReply);
        return cancelDraftReply;
      }

      const updatedDrafts = extractBookingDraftsFromMessage(
        userMessage,
        pendingDrafts[0]?.courtName || "INDIFERENTE",
      );
      if (updatedDrafts.length >= 2) {
        const summaryReply = await buildBookingDraftSummaryReply({
          companyId,
          clientName: pendingClientName || "Cliente",
          drafts: updatedDrafts,
        });
        sessionService.updateMeta(sessionId, {
          pendingBookingDrafts: updatedDrafts,
          pendingBookingOffer: null,
          awaitingExtraBookingConfirmation: false,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", summaryReply);
        return summaryReply;
      }

      if (!strictConfirmation) {
        const askSpecificConfirmationReply =
          pendingDrafts.length > 1
            ? "Para evitar errores, indicame exactamente: *CONFIRMAR TODO*, *CONFIRMAR A*, *CONFIRMAR B* o *CANCELAR*."
            : "Para evitar errores, confirmame con *CONFIRMAR RESERVA* o *CANCELAR*.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(
          sessionId,
          "assistant",
          askSpecificConfirmationReply,
        );
        return askSpecificConfirmationReply;
      }

      if (!pendingClientName || !isValidClientName(pendingClientName)) {
        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: true,
          pendingBookingClientName: null,
          pendingBookingOffer: null,
        });
        const needNameReply =
          "Antes de reservar, necesito tu *nombre completo* (ej: *Juan Pérez*).";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", needNameReply);
        return needNameReply;
      }

      const selectedDrafts =
        strictConfirmation.type === "ONE"
          ? [pendingDrafts[strictConfirmation.index]].filter(Boolean)
          : pendingDrafts;
      const allowSameClientSameSlot = selectedDrafts.length > 1;

      const executionResults = [];
      for (const draft of selectedDrafts) {
        const result = await bookingService.createNewBooking({
          companyId,
          courtName: draft.courtName || "INDIFERENTE",
          dateStr: draft.dateStr,
          timeStr: draft.timeStr,
          clientName: pendingClientName,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
          allowSameClientSameSlot,
        });
        executionResults.push({ draft, result });
      }

      const successMessages = executionResults
        .filter((item) => item.result?.success)
        .map((item) =>
          buildBookingReplyText(
            item.draft.dateStr,
            pendingClientName,
            item.result,
          ),
        );

      const failedMessages = executionResults
        .filter((item) => !item.result?.success)
        .map((item) => {
          const failureReason = buildBookingReplyText(
            item.draft.dateStr,
            pendingClientName,
            item.result,
          );
          return (
            `⚠️ No pude reservar el borrador ${item.draft.id} ` +
            `(${formatIsoDateAsDayMonthYear(item.draft.dateStr)} ${item.draft.timeStr}).\n` +
            `${failureReason}`
          );
        });

      let finalReply = "";
      if (successMessages.length && failedMessages.length) {
        finalReply =
          `${successMessages.join("\n\n")}\n\n` +
          `${failedMessages.join("\n\n")}`;
      } else if (successMessages.length) {
        finalReply = successMessages.join("\n\n");
      } else {
        finalReply = failedMessages.join("\n\n") || "⚠️ No pude reservar los turnos solicitados.";
      }

      sessionService.updateMeta(sessionId, {
        pendingBookingDrafts: null,
        pendingBookingClientName: null,
        pendingBookingOffer: null,
        pendingBooking: null,
        awaitingExtraBookingConfirmation: false,
        awaitingFullNameForBooking: false,
      });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", finalReply);
      return finalReply;
    }

    if (
      sessionMeta.awaitingExtraBookingConfirmation &&
      sessionMeta.pendingBooking?.dateStr &&
      sessionMeta.pendingBooking?.timeStr
    ) {
      const strictExtraConfirmation = parseStrictDraftConfirmation(userMessage, 1);
      const pendingBooking = sessionMeta.pendingBooking;
      const editedDate = extractDateFromMessage(userMessage);
      const editedTime = normalizeTimeString(extractTimeFromMessage(userMessage));

      if (editedDate && editedTime) {
        const editedDraft = buildDraftFromRaw(
          {
            courtName: pendingBooking.courtName || "INDIFERENTE",
            dateStr: editedDate,
            timeStr: editedTime,
          },
          0,
        );
        const summaryReply = await buildBookingDraftSummaryReply({
          companyId,
          clientName:
            normalizeNameText(sessionMeta.pendingBookingClientName || knownName || "") ||
            "Cliente",
          drafts: [editedDraft],
        });
        sessionService.updateMeta(sessionId, {
          awaitingExtraBookingConfirmation: true,
          pendingBooking: {
            courtName: editedDraft.courtName,
            dateStr: editedDraft.dateStr,
            timeStr: editedDraft.timeStr,
          },
          pendingBookingOffer: null,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", summaryReply);
        return summaryReply;
      }

      if (strictExtraConfirmation) {
        const pendingBooking = sessionMeta.pendingBooking;
        const pendingClientName = normalizeNameText(
          sessionMeta.pendingBookingClientName || knownName || "",
        );

        if (!pendingClientName || !isValidClientName(pendingClientName)) {
          sessionService.updateMeta(sessionId, {
            awaitingExtraBookingConfirmation: false,
            pendingBooking: {
              courtName: pendingBooking.courtName || "INDIFERENTE",
              dateStr: pendingBooking.dateStr,
              timeStr: pendingBooking.timeStr,
            },
            pendingBookingClientName: null,
            awaitingFullNameForBooking: true,
            pendingBookingOffer: null,
          });
          const needNameReply =
            "Antes de reservar, necesito tu *nombre completo* (ej: *Juan Pérez*).";
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", needNameReply);
          return needNameReply;
        }

        const bookingResult = await bookingService.createNewBooking({
          companyId,
          courtName: pendingBooking.courtName || "INDIFERENTE",
          dateStr: pendingBooking.dateStr,
          timeStr: pendingBooking.timeStr,
          clientName: pendingClientName,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
        });

        const bookingReply = buildBookingReplyText(
          pendingBooking.dateStr,
          pendingClientName,
          bookingResult,
        );
        sessionService.updateMeta(sessionId, {
          awaitingExtraBookingConfirmation: false,
          pendingBooking: null,
          pendingBookingClientName: null,
          pendingBookingOffer: null,
          awaitingFullNameForBooking: false,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", bookingReply);
        return bookingReply;
      }

      if (isNegativeBookingReply(userMessage)) {
        sessionService.updateMeta(sessionId, {
          awaitingExtraBookingConfirmation: false,
          pendingBooking: null,
          pendingBookingClientName: null,
        });
        const cancelExtraBookingReply =
          "Perfecto, no reservo otro turno. Si querés, te ayudo con otra cosa.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", cancelExtraBookingReply);
        return cancelExtraBookingReply;
      }

      const askAgainReply =
        "Para evitar errores, confirmame con *CONFIRMAR EXTRA* o cancelá con *CANCELAR*.";
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", askAgainReply);
      return askAgainReply;
    }

    // Si hay una oferta pendiente, solo se ejecuta con confirmación estricta.
    const pendingBookingOffer = sessionMeta.pendingBookingOffer || null;
    if (
      pendingBookingOffer?.dateStr &&
      pendingBookingOffer?.timeStr &&
      !sessionMeta.awaitingFullNameForBooking
    ) {
      const offerAgeMs = Date.now() - Number(pendingBookingOffer.createdAt || 0);
      const isExpired = !pendingBookingOffer.createdAt || offerAgeMs > 10 * 60 * 1000;

      if (isExpired) {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
      } else if (isNegativeBookingReply(userMessage)) {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        const cancelledOfferReply = "Perfecto, no reservo ese turno.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", cancelledOfferReply);
        return cancelledOfferReply;
      } else if (parseStrictDraftConfirmation(userMessage, 1)) {
        let requestedClientName = normalizeNameText(knownName || "");

        if (!requestedClientName || !isValidClientName(requestedClientName)) {
          const extractedName = extractFullNameFromMessage(userMessage);
          if (extractedName && isValidClientName(extractedName)) {
            requestedClientName = extractedName;
            await userService.saveOrUpdateUser(chatId, requestedClientName, {
              companyId,
              client,
            });
          }
        }

        if (!requestedClientName || !isValidClientName(requestedClientName)) {
          sessionService.updateMeta(sessionId, {
            awaitingFullNameForBooking: true,
            pendingBooking: {
              courtName: pendingBookingOffer.courtName || "INDIFERENTE",
              dateStr: pendingBookingOffer.dateStr,
              timeStr: pendingBookingOffer.timeStr,
            },
            pendingBookingOffer: null,
          });
          const needNameReply =
            "Antes de reservar, necesito tu *nombre completo* (ej: *Juan Pérez*). Te lo pido para dejar el turno a tu nombre y guardarte en la base de clientes.";
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", needNameReply);
          return needNameReply;
        }

        const hasActiveBooking = await bookingService.hasActiveBookingForClient({
          companyId,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
        });
        if (hasActiveBooking) {
          sessionService.updateMeta(sessionId, {
            awaitingExtraBookingConfirmation: true,
            pendingBooking: {
              courtName: pendingBookingOffer.courtName || "INDIFERENTE",
              dateStr: pendingBookingOffer.dateStr,
              timeStr: pendingBookingOffer.timeStr,
            },
            pendingBookingClientName: requestedClientName,
            pendingBookingOffer: null,
            awaitingFullNameForBooking: false,
          });
          const askExtraBookingReply = buildSecondBookingConfirmationText();
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", askExtraBookingReply);
          return askExtraBookingReply;
        }

        const bookingResult = await bookingService.createNewBooking({
          companyId,
          courtName: pendingBookingOffer.courtName || "INDIFERENTE",
          dateStr: pendingBookingOffer.dateStr,
          timeStr: pendingBookingOffer.timeStr,
          clientName: requestedClientName,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
        });

        const bookingReply = buildBookingReplyText(
          pendingBookingOffer.dateStr,
          requestedClientName,
          bookingResult,
        );
        sessionService.updateMeta(sessionId, {
          pendingBookingOffer: null,
          awaitingFullNameForBooking: false,
          pendingBooking: null,
          awaitingExtraBookingConfirmation: false,
          pendingBookingClientName: null,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", bookingReply);
        return bookingReply;
      } else if (isAffirmativeBookingReply(userMessage)) {
        const strictConfirmReply =
          "Para confirmar sin errores, respondé exactamente *CONFIRMAR RESERVA* o *CANCELAR*.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", strictConfirmReply);
        return strictConfirmReply;
      } else if (!hasDirectBookingIntent(userMessage)) {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
      }
    }

    // Si estábamos esperando nombre completo para una reserva pendiente, lo resolvemos antes de llamar a IA.
    if (!knownName && sessionMeta.awaitingFullNameForBooking) {
      const fullName = extractFullNameFromMessage(userMessage);
      if (!fullName || !isValidClientName(fullName)) {
        const retryNamePrompt =
          "Antes de continuar con tu turno, pasame tu *nombre completo* para registrarte (ej: *Juan Pérez*). Es para dejar el turno a tu nombre.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", retryNamePrompt);
        return retryNamePrompt;
      }

      const savedUser = await userService.saveOrUpdateUser(chatId, fullName, {
        companyId,
        client,
      });
      knownName = savedUser?.name || fullName;

      const pendingBooking = sessionMeta.pendingBooking || null;
      const pendingBookingDrafts = Array.isArray(sessionMeta.pendingBookingDrafts)
        ? sessionMeta.pendingBookingDrafts
        : [];
      if (pendingBookingDrafts.length > 0) {
        const summaryReply = await buildBookingDraftSummaryReply({
          companyId,
          clientName: knownName,
          drafts: pendingBookingDrafts,
        });
        sessionService.updateMeta(sessionId, {
          pendingBookingClientName: knownName,
          awaitingFullNameForBooking: false,
          pendingBookingOffer: null,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", summaryReply);
        return summaryReply;
      }

      if (pendingBooking?.dateStr && pendingBooking?.timeStr) {
        const draft = buildDraftFromRaw(
          {
            courtName: pendingBooking.courtName || "INDIFERENTE",
            dateStr: pendingBooking.dateStr,
            timeStr: pendingBooking.timeStr,
          },
          0,
        );
        const summaryReply = await buildBookingDraftSummaryReply({
          companyId,
          clientName: knownName,
          drafts: [draft],
        });
        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: false,
          pendingBooking: null,
          pendingBookingOffer: {
            courtName: draft.courtName,
            dateStr: draft.dateStr,
            timeStr: draft.timeStr,
            createdAt: Date.now(),
          },
          awaitingExtraBookingConfirmation: false,
          pendingBookingClientName: knownName,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", summaryReply);
        return summaryReply;
      }

      const continueReply =
        `Perfecto, ${knownName}. Ya te registré en el sistema ✅\n` +
        "Ahora sí, decime fecha y hora del turno y te lo reservo.";
        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: false,
          pendingBooking: null,
          awaitingExtraBookingConfirmation: false,
          pendingBookingClientName: null,
        });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", continueReply);
      return continueReply;
    }

    // 2. Historial
    sessionService.addMessage(sessionId, "user", userMessage);
    const history = sessionService.getHistory(sessionId);

    // 3. IA
    const aiResponseRaw = await groqService.getChatResponse(history, knownName, {
      companyId,
    });
    console.log("🤖 Respuesta RAW de IA:", aiResponseRaw); // Para depuración

    let replyText = "";

    // 4. INTENTO DE PARSEO ROBUSTO
    const parsedData = extractJSON(aiResponseRaw);

    if (parsedData) {
      // ==========================================
      // SI ES UN JSON VÁLIDO (Acción o Mensaje)
      // ==========================================

      // CASO 0: MODO DEGRADADO (sin IA por rate limit)
      if (parsedData.action === "SERVICE_DEGRADED") {
        const retryText = parsedData.retryAfterText || "unos minutos";
        const fallback = inferFallbackAction(userMessage);

        if (fallback?.action === "CHECK_AVAILABILITY") {
          const requestedDate = fallback.date || getTodayIsoArgentina();
          const requestedTime = normalizeTimeString(fallback.time);
          const availability = await bookingService.getAvailableSlots(
            requestedDate,
            { companyId },
          );
          const availabilityResponse = await buildAvailabilityResponse({
            companyId,
            requestedDate,
            requestedTime,
            userMessage,
            availability,
            modePrefix: `🟡 *Modo básico activo* (IA con límite, aprox ${retryText}).`,
          });
          replyText = availabilityResponse.replyText;
          sessionService.updateMeta(sessionId, {
            pendingBookingOffer: availabilityResponse.pendingBookingOffer,
          });
        } else if (fallback?.action === "LIST_ACTIVE_BOOKINGS") {
          const activeBookings = await bookingService.getActiveBookingsForClient({
            companyId,
            clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
            limit: 15,
          });
          replyText = activeBookings.success
            ? buildActiveBookingsReply(activeBookings.data)
            : "⚠️ No pude consultar tus reservas vigentes en este momento.";
        } else if (hasDirectBookingIntent(userMessage)) {
          const requestedDate = extractDateFromMessage(userMessage) || getTodayIsoArgentina();
          const requestedTime = normalizeTimeString(extractTimeFromMessage(userMessage));

          if (!requestedTime) {
            replyText =
              `🟡 *Modo básico activo* (IA con límite, aprox ${retryText}). ` +
              "Para reservar necesito la hora exacta (ej: 19:30).";
          } else {
            const availability = await bookingService.getAvailableSlots(
              requestedDate,
              { companyId },
            );
            const availabilityResponse = await buildAvailabilityResponse({
              companyId,
              requestedDate,
              requestedTime,
              userMessage,
              availability,
              modePrefix: `🟡 *Modo básico activo* (IA con límite, aprox ${retryText}).`,
            });
            replyText = availabilityResponse.replyText;
            sessionService.updateMeta(sessionId, {
              pendingBookingOffer: availabilityResponse.pendingBookingOffer,
            });
          }
        } else {
          replyText =
            parsedData.message ||
            `🟡 Modo básico activo por límite diario de IA. Volvé a intentar en ${retryText}.`;
        }
      }

      // CASO A: RESERVAR
      else if (parsedData.action === "CREATE_BOOKING") {
        const requestedDate = parsedData.date;
        const requestedTime = normalizeTimeString(parsedData.time);
        const requestedCourt = (parsedData.courtName || "INDIFERENTE").trim();
        const detectedDrafts = extractBookingDraftsFromMessage(
          userMessage,
          requestedCourt,
        );
        const canCreateBookingFromMessage = hasDirectBookingIntent(userMessage);

        if (detectedDrafts.length >= 2) {
          const pendingClientName = normalizeNameText(knownName || "");
          sessionService.updateMeta(sessionId, {
            pendingBookingDrafts: detectedDrafts,
            pendingBookingClientName: pendingClientName || null,
            pendingBookingOffer: null,
            pendingBooking: null,
            awaitingExtraBookingConfirmation: false,
          });

          if (!pendingClientName || !isValidClientName(pendingClientName)) {
            sessionService.updateMeta(sessionId, {
              awaitingFullNameForBooking: true,
            });
            replyText =
              "Antes de reservar esos turnos, necesito tu *nombre completo* (ej: *Juan Pérez*).";
            sessionService.addMessage(sessionId, "assistant", replyText);
            return replyText;
          }

          replyText = await buildBookingDraftSummaryReply({
            companyId,
            clientName: pendingClientName,
            drafts: detectedDrafts,
          });
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (!canCreateBookingFromMessage) {
          if (
            requestedDate &&
            isValidIsoDate(requestedDate) &&
            requestedTime
          ) {
            sessionService.updateMeta(sessionId, {
              pendingBookingOffer: {
                courtName: requestedCourt,
                dateStr: requestedDate,
                timeStr: requestedTime,
                createdAt: Date.now(),
              },
            });
          }
          replyText =
            "Si querés que lo reserve, respondé exactamente *CONFIRMAR RESERVA*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }
        let requestedClientName = normalizeNameText(knownName || "");

        if (!requestedDate || !isValidIsoDate(requestedDate)) {
          replyText =
            "⚠️ Para reservar necesito la fecha en formato claro. Ejemplo: *2026-04-07* o decime *hoy/mañana*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (!requestedTime) {
          replyText =
            "⚠️ Para reservar necesito la hora exacta. Ejemplo: *17:00*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (!requestedClientName || !isValidClientName(requestedClientName)) {
          const extractedName = extractFullNameFromMessage(
            userMessage,
            parsedData.clientName,
          );
          if (extractedName && isValidClientName(extractedName)) {
            requestedClientName = extractedName;
            await userService.saveOrUpdateUser(chatId, requestedClientName, {
              companyId,
              client,
            });
          }
        }

        if (!requestedClientName || !isValidClientName(requestedClientName)) {
          sessionService.updateMeta(sessionId, {
            awaitingFullNameForBooking: true,
            pendingBooking: {
              courtName: requestedCourt,
              dateStr: requestedDate,
              timeStr: requestedTime,
            },
          });
          replyText =
            "Antes de reservar, necesito tu *nombre completo* (ej: *Juan Pérez*). Te lo pido para dejar el turno a tu nombre y guardarte en la base de clientes.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        const singleDraft = buildDraftFromRaw(
          {
            courtName: requestedCourt,
            dateStr: requestedDate,
            timeStr: requestedTime,
          },
          0,
        );
        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: false,
          pendingBooking: null,
          pendingBookingDrafts: null,
          pendingBookingClientName: requestedClientName,
          pendingBookingOffer: {
            courtName: singleDraft.courtName,
            dateStr: singleDraft.dateStr,
            timeStr: singleDraft.timeStr,
            createdAt: Date.now(),
          },
          awaitingExtraBookingConfirmation: false,
        });

        replyText = await buildBookingDraftSummaryReply({
          companyId,
          clientName: requestedClientName,
          drafts: [singleDraft],
        });
        sessionService.addMessage(sessionId, "assistant", replyText);
        return replyText;
      }

      // CASO B: DISPONIBILIDAD
      else if (parsedData.action === "CHECK_AVAILABILITY") {
        const requestedDate = parsedData.date || getTodayIsoArgentina();
        const requestedTime = normalizeTimeString(parsedData.time);

        if (parsedData.date && !isValidIsoDate(parsedData.date)) {
          replyText =
            "⚠️ No pude entender la fecha. Decime por ejemplo *2026-04-07* o *hoy*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (parsedData.time && !requestedTime) {
          replyText =
            "⚠️ No pude entender la hora exacta. Decime, por ejemplo, `17:00`.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        const availability = await bookingService.getAvailableSlots(
          requestedDate,
          { companyId },
        );
        const availabilityResponse = await buildAvailabilityResponse({
          companyId,
          requestedDate,
          requestedTime,
          userMessage,
          availability,
        });
        replyText = availabilityResponse.replyText;
        sessionService.updateMeta(sessionId, {
          pendingBookingOffer: availabilityResponse.pendingBookingOffer,
        });
      }

      // CASO C: LISTAR RESERVAS VIGENTES DEL CLIENTE
      else if (parsedData.action === "LIST_ACTIVE_BOOKINGS") {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        console.log(
          `[MessageHandler][${companyId || "global"}] LIST_ACTIVE_BOOKINGS via AI chatId=${chatId} canonicalClientPhone=${canonicalClientPhone}`,
        );
        const activeBookings = await bookingService.getActiveBookingsForClient({
          companyId,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
          limit: 15,
        });
        console.log(
          `[MessageHandler][${companyId || "global"}] LIST_ACTIVE_BOOKINGS result success=${activeBookings?.success} count=${activeBookings?.data?.length || 0}`,
        );

        if (activeBookings.success) {
          replyText = buildActiveBookingsReply(activeBookings.data);
        } else {
          replyText = "⚠️ No pude consultar tus reservas vigentes en este momento.";
        }
      }

      // CASO D: CANCELAR TURNO
      else if (parsedData.action === "CANCEL_BOOKING") {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        const requestedDate = parsedData.date;
        const requestedTime = normalizeTimeString(parsedData.time);

        if (!requestedDate || !isValidIsoDate(requestedDate) || !requestedTime) {
          replyText =
            "⚠️ Para cancelar necesito *fecha y hora exactas* del turno (ej: 2026-04-07 17:00).";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        const cancelResult = await bookingService.cancelBooking({
          companyId,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
          dateStr: requestedDate,
          timeStr: requestedTime,
        });

        if (cancelResult.success) {
          let penaltyNote = "";
          if (cancelResult.penaltyApplied && cancelResult.nowSuspended) {
            penaltyNote =
              `\n\n⚠️ *Atención:* Has acumulado ${cancelResult.penalties} cancelaciones y tu cuenta ha sido *suspendida*. ` +
              `No podrás reservar nuevos turnos. Contactá a la administración para regularizar tu situación.`;
          } else if (cancelResult.penaltyApplied && cancelResult.penalties > 0) {
            const remaining =
              cancelResult.penaltyLimit - cancelResult.penalties;
            penaltyNote =
              `\n\n⚠️ _Aviso: Tenés ${cancelResult.penalties}/${cancelResult.penaltyLimit} cancelaciones. ` +
              `Con ${remaining} más, tu cuenta quedará suspendida._`;
          } else if (!cancelResult.penaltyApplied) {
            penaltyNote =
              "\n\nℹ️ _Penalizaciones desactivadas por configuración del club._";
          }

          replyText =
            `❌ *Turno Cancelado*\n\n` +
            `📅 *Fecha:* ${getFormattedDate(requestedDate)}\n` +
            `⏰ *Hora:* ${cancelResult.data.time}\n\n` +
            `_Tu turno fue cancelado correctamente. ¡Esperamos verte pronto! 👋_` +
            penaltyNote;
        } else {
          if (cancelResult.error === "NOT_FOUND")
            replyText =
              "⚠️ No encontré ningún turno tuyo para esa fecha y hora. ¿Me podés confirmar los datos?";
          else if (cancelResult.error === "CANCELLATION_BLOCKED_WINDOW") {
            const lockHours = Number(cancelResult?.data?.cancellationLockHours || 0);
            const contactPhone = String(cancelResult?.data?.contactPhone || "").trim();
            const phoneSuffix = contactPhone
              ? ` al *${contactPhone}*`
              : " con el admin del club";
            replyText =
              `⚠️ No puedo cancelar este turno porque faltan menos de *${lockHours} horas*.\n\n` +
              `Para cancelarlo, por favor hablá${phoneSuffix}.`;
          }
          else if (cancelResult.error === "INVALID_TIME")
            replyText = "⚠️ Ese horario no existe en la grilla.";
          else replyText = "⚠️ Hubo un error técnico al cancelar.";
        }
      }

      // CASO E: PEDIDO DE TURNO FIJO
      else if (parsedData.action === "FIXED_TURN_REQUEST") {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        const requestedDate = parsedData.date || "Sin fecha";
        const requestedTime = normalizeTimeString(parsedData.time) || "Sin horario";
        const summary = parsedData.message || userMessage;
        const requester = knownName || "Cliente no identificado";

        await sendAdminNotification(
          "fixed_turn_request",
          "Solicitud de Turno Fijo",
          `Cliente: ${requester}\nTeléfono: ${number}\nFecha: ${requestedDate}\nHora: ${requestedTime}\nDetalle: ${summary}`,
          { companyId, source: "whatsapp-fixed-turn" },
          { companyId },
        );

        replyText =
          "Perfecto. Ya le aviso al admin para que gestione ese *turno fijo* y te confirme por acá.";
      }

      // CASO F: SOLO MENSAJE (La IA respondió en JSON con campo "message")
      else if (parsedData.message) {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        replyText = parsedData.message;
      }

      // CASO G: JSON DESCONOCIDO
      else {
        const fallback = inferFallbackAction(userMessage);
        if (fallback?.action === "CHECK_AVAILABILITY") {
          const requestedDate = fallback.date || getTodayIsoArgentina();
          const requestedTime = normalizeTimeString(fallback.time);
          const availability = await bookingService.getAvailableSlots(
            requestedDate,
            { companyId },
          );
          const availabilityResponse = await buildAvailabilityResponse({
            companyId,
            requestedDate,
            requestedTime,
            userMessage,
            availability,
          });
          replyText = availabilityResponse.replyText;
          sessionService.updateMeta(sessionId, {
            pendingBookingOffer: availabilityResponse.pendingBookingOffer,
          });
        } else if (fallback?.action === "LIST_ACTIVE_BOOKINGS") {
          console.log(
            `[MessageHandler][${companyId || "global"}] LIST_ACTIVE_BOOKINGS via fallback chatId=${chatId} canonicalClientPhone=${canonicalClientPhone}`,
          );
          const activeBookings = await bookingService.getActiveBookingsForClient({
            companyId,
            clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
            limit: 15,
          });
          console.log(
            `[MessageHandler][${companyId || "global"}] LIST_ACTIVE_BOOKINGS fallback result success=${activeBookings?.success} count=${activeBookings?.data?.length || 0}`,
          );
          replyText = activeBookings.success
            ? buildActiveBookingsReply(activeBookings.data)
            : "⚠️ No pude consultar tus reservas vigentes en este momento.";
        } else if (fallback?.action === "FIXED_TURN_REQUEST") {
          sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
          const requestedDate = fallback.date || "Sin fecha";
          const requestedTime = normalizeTimeString(fallback.time) || "Sin horario";
          const requester = knownName || "Cliente no identificado";

          await sendAdminNotification(
            "fixed_turn_request",
            "Solicitud de Turno Fijo",
            `Cliente: ${requester}\nTeléfono: ${number}\nFecha: ${requestedDate}\nHora: ${requestedTime}\nDetalle: ${userMessage}`,
            { companyId, source: "whatsapp-fixed-turn-fallback" },
            { companyId },
          );

          replyText =
            "Perfecto. Ya le aviso al admin para que gestione ese *turno fijo* y te confirme por acá.";
        } else {
          sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
          replyText = "No entendí la respuesta del sistema.";
        }
      }
    } else {
      // ==========================================
      // SI NO ES JSON (Texto plano o error)
      // ==========================================
      const fallback = inferFallbackAction(userMessage);

      if (fallback?.action === "CHECK_AVAILABILITY") {
        const requestedDate = fallback.date || getTodayIsoArgentina();
        const requestedTime = normalizeTimeString(fallback.time);
        const availability = await bookingService.getAvailableSlots(
          requestedDate,
          { companyId },
        );
        const availabilityResponse = await buildAvailabilityResponse({
          companyId,
          requestedDate,
          requestedTime,
          userMessage,
          availability,
        });
        replyText = availabilityResponse.replyText;
        sessionService.updateMeta(sessionId, {
          pendingBookingOffer: availabilityResponse.pendingBookingOffer,
        });
      } else if (fallback?.action === "LIST_ACTIVE_BOOKINGS") {
        console.log(
          `[MessageHandler][${companyId || "global"}] LIST_ACTIVE_BOOKINGS via plain-fallback chatId=${chatId} canonicalClientPhone=${canonicalClientPhone}`,
        );
        const activeBookings = await bookingService.getActiveBookingsForClient({
          companyId,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
          limit: 15,
        });
        console.log(
          `[MessageHandler][${companyId || "global"}] LIST_ACTIVE_BOOKINGS plain-fallback result success=${activeBookings?.success} count=${activeBookings?.data?.length || 0}`,
        );
        replyText = activeBookings.success
          ? buildActiveBookingsReply(activeBookings.data)
          : "⚠️ No pude consultar tus reservas vigentes en este momento.";
      } else if (fallback?.action === "FIXED_TURN_REQUEST") {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        const requestedDate = fallback.date || "Sin fecha";
        const requestedTime = normalizeTimeString(fallback.time) || "Sin horario";
        const requester = knownName || "Cliente no identificado";

        await sendAdminNotification(
          "fixed_turn_request",
          "Solicitud de Turno Fijo",
          `Cliente: ${requester}\nTeléfono: ${number}\nFecha: ${requestedDate}\nHora: ${requestedTime}\nDetalle: ${userMessage}`,
          { companyId, source: "whatsapp-fixed-turn-fallback" },
          { companyId },
        );

        replyText =
          "Perfecto. Ya le aviso al admin para que gestione ese *turno fijo* y te confirme por acá.";
      } else {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        // Limpiamos posibles backticks de markdown por si acaso
        replyText = aiResponseRaw
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
      }
    }

    // 5. Enviar y Guardar
    sessionService.addMessage(sessionId, "assistant", replyText);
    return replyText;
  } catch (error) {
    console.error("❌ Error en messageHandler:", error);
    return "Tuve un error procesando tu mensaje.";
  }
};

module.exports = { handleIncomingMessage };
