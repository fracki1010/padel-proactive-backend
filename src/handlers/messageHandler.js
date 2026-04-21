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
  getStrictQuestionFlowEnabled,
  getTrustedClientConfirmationCount,
} = require("../services/appConfig.service");
const { getFormattedDate } = require("../utils/getFormattedDate");
const { getNumberByUser } = require("../utils/getNumberByUser");
const {
  normalizeCanonicalClientPhone,
} = require("../utils/identityNormalization");
const {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  shouldBlockRejectedSlotReattempt,
} = require("../utils/conversationGuardrails");
const {
  resolveStrictStateTransition,
} = require("../utils/stateTransitionHandler");
const {
  hasInvalidTimeInput,
  parseTime,
} = require("../utils/timeParser");
const {
  extractPersonName,
} = require("../whatsapp/domain/extractPersonName");
const {
  parseBookingDateTime,
  getTodayIso,
} = require("../whatsapp/domain/parseBookingDateTime");
const {
  interpretIncomingMessage,
  INTENTS,
} = require("../whatsapp/domain/messageInterpreter");
const {
  deriveStateFromMeta,
} = require("../whatsapp/domain/bookingStateMachine");

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
  return getTodayIso(new Date(), "America/Argentina/Buenos_Aires");
};

const TRANSACTIONAL_MODE_ENABLED =
  String(process.env.WHATSAPP_TRANSACTIONAL_MODE || "true")
    .trim()
    .toLowerCase() !== "false";
const INCOMING_RATE_WINDOW_MS = Number(
  process.env.WHATSAPP_BOT_RATE_WINDOW_MS || 60 * 1000,
);
const INCOMING_RATE_MAX_MESSAGES = Number(
  process.env.WHATSAPP_BOT_RATE_MAX_MESSAGES || 14,
);
const INCOMING_RATE_MAX_CONTROL_MESSAGES = Number(
  process.env.WHATSAPP_BOT_RATE_MAX_CONTROL_MESSAGES || 8,
);
const incomingRateState = new Map();
const MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY = 3;

const fingerprintMessage = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildAntiLoopReply = ({ interpretation = {}, sessionMeta = {} } = {}) => {
  const missingName = sessionMeta.awaitingFullNameForBooking;
  const missingConfirmation = sessionMeta.pendingBookingOffer?.dateStr && sessionMeta.pendingBookingOffer?.timeStr;
  const intent = interpretation?.detectedIntent || INTENTS.UNKNOWN;

  if (missingName) {
    return "Sigo esperando tu *nombre y apellido* para avanzar con la reserva. Ejemplo: *Juan Pérez*.";
  }
  if (missingConfirmation) {
    return "Para avanzar, decime solo una opción: *CONFIRMAR RESERVA* o *CANCELAR*.";
  }
  if (intent === INTENTS.CREATE_BOOKING) {
    return "Entendido. Para reservar sin errores necesito *fecha y hora* (ej: hoy 20:00).";
  }
  if (intent === INTENTS.CANCEL_BOOKING) {
    return "Entendido. Si no me pasás fecha/hora, intento cancelar tu próxima reserva activa.";
  }
  return "Te estoy entendiendo, pero para avanzar necesito un dato más concreto.";
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
  return parseBookingDateTime(rawText, new Date(), "America/Argentina/Buenos_Aires").date;
};

const extractTimeFromMessage = (rawText) => {
  return parseBookingDateTime(rawText, new Date(), "America/Argentina/Buenos_Aires").time;
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
  const invalidTimeInMessage = hasInvalidTimeInput(rawText);

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

const normalizeNameText = (value = "") =>
  String(value)
    .trim()
    .replace(/\s+/g, " ");

const normalizeLooseText = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sanitizeIncomingUserMessage = (value = "") =>
  String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

const clearBookingStrictStateMeta = (sessionId) =>
  sessionService.updateMeta(sessionId, {
    awaitingFullNameForBooking: false,
    awaitingBookingClientNameConfirmation: false,
    pendingBookingClientNameCandidate: null,
    awaitingExtraBookingConfirmation: false,
    pendingBookingOffer: null,
    pendingBooking: null,
    pendingBookingDrafts: null,
    pendingBookingClientName: null,
    lastRejectedBookingAttempt: null,
    concreteAnswerRequestedAt: null,
  });

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
    "cancelar",
    "confirmar",
    "confirmar reserva",
    "confirmar turno",
    "confirmar todo",
    "confirmar extra",
  ];

  if (blockedPhrases.includes(normalized)) return true;
  if (
    /^confirmar(?:\s+(?:reserva|turno|todo|extra|[a-z]))?$/.test(normalized) ||
    /^(cancelar|cancelo|cancelado)$/.test(normalized)
  ) {
    return true;
  }

  return isEquivalentConfirmation(normalized);
};

const extractFullNameFromMessage = (rawMessage, _aiCandidate = "") => {
  const parsed = extractPersonName(rawMessage);
  if (!parsed?.isValid) return null;
  return parsed.value;
};

const isValidClientName = (value = "") =>
  Boolean(extractPersonName(value)?.isValid);

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

const DAY_NAMES_ES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

const buildActiveBookingsReply = (bookings = []) => {
  if (!Array.isArray(bookings) || bookings.length === 0) {
    return "📭 No encontré reservas vigentes para este número de WhatsApp.";
  }

  const lines = bookings.map((booking, index) => {
    const timeText = booking.endTime
      ? `${booking.startTime} - ${booking.endTime}`
      : booking.startTime;

    if (booking.type === "fixed") {
      const dayName = DAY_NAMES_ES[booking.dayOfWeek] || "?";
      return (
        `${index + 1}) 📌 ${booking.courtName}\n` +
        `   🔁 Todos los ${dayName}\n` +
        `   ⏰ ${timeText}`
      );
    }

    const dateText = getFormattedDate(booking.date);
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

const formatSlotLines = (slot) => {
  if (slot.courtTypes?.length > 0) {
    return slot.courtTypes.map((ct) => `• ${slot.time} (${ct.type}) ($${slot.price})`);
  }
  return [`• ${slot.time} ($${slot.price})`];
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
        rejectedBookingAttempt: {
          dateStr: requestedDate,
          timeStr: requestedTime,
          reason: "INVALID_TIME",
        },
      };
    }
  }

  if (!availability?.success || !Array.isArray(availability.slots)) {
    return {
      replyText: `${prefix}⚠️ Hubo un problema consultando disponibilidad.`,
      pendingBookingOffer: null,
      rejectedBookingAttempt: null,
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
          rejectedBookingAttempt: null,
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
        rejectedBookingAttempt: {
          dateStr: requestedDate,
          timeStr: requestedTime,
          reason: "INSUFFICIENT_COURTS",
          requestedCourts: requestedCourtsCount,
        },
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
        rejectedBookingAttempt: null,
      };
    }

    const alternatives = dayPeriod
      ? filterSlotsByPeriod(availability.slots, dayPeriod).slice(0, 5)
      : availability.slots.slice(0, 5);
    const list = alternatives.flatMap(formatSlotLines).join("\n");
    const periodLine = periodLabel ? ` dentro de la ${periodLabel}` : "";
    const isFixedBlocking = availability.blockedSlots?.[requestedTime]?.isFixed === true;
    const fixedNote = isFixedBlocking ? " — ese horario está reservado como turno fijo" : "";
    return {
      replyText:
        `${prefix}🚫 No tengo disponibilidad para *${requestedTime}* el ${getFormattedDate(requestedDate)}${periodLine}${fixedNote}.\n\n` +
        (alternatives.length
          ? `Te puedo ofrecer estos horarios:\n${list}\n\n_¿Cuál te reservo?_`
          : "No me quedan horarios disponibles para ese rango."),
      pendingBookingOffer: null,
      rejectedBookingAttempt: {
        dateStr: requestedDate,
        timeStr: requestedTime,
        reason: "NO_AVAILABILITY",
      },
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
        rejectedBookingAttempt: null,
      };
    }
    return {
      replyText: `${prefix}🚫 Todo ocupado para esa fecha.`,
      pendingBookingOffer: null,
      rejectedBookingAttempt: null,
    };
  }

  const lista = slotsToShow.flatMap(formatSlotLines).join("\n");
  const periodTitle = dayPeriod ? ` en la ${periodLabel}` : "";
  return {
    replyText:
      `${prefix}📅 *Libres para el ${getFormattedDate(requestedDate)}${periodTitle}:*\n\n${lista}\n\n_¿Cuál te reservo?_`,
    pendingBookingOffer: null,
    rejectedBookingAttempt: null,
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

const CONCRETE_RESPONSE_TIMEOUT_MS = 3 * 60 * 1000;
const ALLOWED_AI_ACTIONS = new Set([
  "SERVICE_DEGRADED",
  "INVALID_TIME_INPUT",
  "CREATE_BOOKING",
  "CHECK_AVAILABILITY",
  "LIST_ACTIVE_BOOKINGS",
  "CANCEL_BOOKING",
  "FIXED_TURN_REQUEST",
]);

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
  return /\bcancel(ar|ame|a|ado)?\b/.test(text);
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

const stampConcreteAnswerDeadline = (sessionId, meta = {}, extraMeta = {}) =>
  sessionService.updateMeta(sessionId, {
    ...extraMeta,
    concreteAnswerRequestedAt:
      Number(meta.concreteAnswerRequestedAt || 0) || Date.now(),
  });

const clearConcreteAnswerDeadline = (sessionId, extraMeta = {}) =>
  sessionService.updateMeta(sessionId, {
    ...extraMeta,
    concreteAnswerRequestedAt: null,
  });

const auditSecurityEvent = ({
  companyId = null,
  chatId = "",
  sessionId = "",
  event = "UNKNOWN",
  reason = "",
  userMessage = "",
  meta = {},
}) => {
  const payload = {
    ts: new Date().toISOString(),
    event,
    reason,
    companyId: companyId || "global",
    chatId: String(chatId || ""),
    sessionId: String(sessionId || ""),
    messagePreview: String(userMessage || "").slice(0, 180),
    ...meta,
  };
  console.warn(`[BotSecurity][${companyId || "global"}] ${JSON.stringify(payload)}`);
};

const enforceIncomingRateLimit = ({
  sessionId = "",
  companyId = null,
  chatId = "",
  userMessage = "",
  isControlMessage = false,
}) => {
  const now = Date.now();
  const safeWindowMs = Number.isFinite(INCOMING_RATE_WINDOW_MS)
    ? Math.max(10 * 1000, INCOMING_RATE_WINDOW_MS)
    : 60 * 1000;
  const safeMaxMessages = Number.isFinite(INCOMING_RATE_MAX_MESSAGES)
    ? Math.max(4, INCOMING_RATE_MAX_MESSAGES)
    : 14;
  const safeMaxControlMessages = Number.isFinite(INCOMING_RATE_MAX_CONTROL_MESSAGES)
    ? Math.max(2, INCOMING_RATE_MAX_CONTROL_MESSAGES)
    : 8;

  const previous = incomingRateState.get(sessionId);
  const bucket =
    previous && now - previous.windowStart < safeWindowMs
      ? previous
      : { windowStart: now, totalCount: 0, controlCount: 0 };

  bucket.totalCount += 1;
  if (isControlMessage) bucket.controlCount += 1;

  incomingRateState.set(sessionId, bucket);
  if (incomingRateState.size > 5000) {
    for (const [key, value] of incomingRateState.entries()) {
      if (now - Number(value.windowStart || 0) > safeWindowMs * 3) {
        incomingRateState.delete(key);
      }
    }
  }

  if (bucket.totalCount > safeMaxMessages || bucket.controlCount > safeMaxControlMessages) {
    const waitSeconds = Math.max(
      1,
      Math.ceil((safeWindowMs - (now - bucket.windowStart)) / 1000),
    );
    auditSecurityEvent({
      companyId,
      chatId,
      sessionId,
      event: "RATE_LIMIT_BLOCKED",
      reason:
        bucket.controlCount > safeMaxControlMessages
          ? "too_many_control_messages"
          : "too_many_messages",
      userMessage,
      meta: {
        waitSeconds,
        totalCount: bucket.totalCount,
        controlCount: bucket.controlCount,
      },
    });
    return {
      blocked: true,
      reply:
        `⚠️ Estoy recibiendo demasiados mensajes seguidos para procesar sin errores.\n` +
        `Esperá *${waitSeconds}s* y enviá un solo mensaje concreto (ej: *hoy 20:00* o *CONFIRMAR RESERVA*).`,
    };
  }

  return { blocked: false, reply: null };
};

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

const handleIncomingMessage = async (chatId, userMessage, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const client = options.client || null;
    const sessionId = companyId ? `${companyId}:${chatId}` : chatId;
    let sessionMeta = sessionService.getMeta(sessionId);
    userMessage = sanitizeIncomingUserMessage(userMessage);

    if (isPromptInjectionAttempt(userMessage)) {
      const promptInjectionReply =
        "No puedo obedecer cambios de reglas del sistema. " +
        "Decime directamente si querés *consultar disponibilidad*, *reservar* o *cancelar*.";
      auditSecurityEvent({
        companyId,
        chatId,
        sessionId,
        event: "INPUT_BLOCKED",
        reason: "prompt_injection_attempt",
        userMessage,
      });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", promptInjectionReply);
      return promptInjectionReply;
    }

    if (!userMessage) {
      const emptyMessageReply =
        "No pude leer tu mensaje. Escribime de nuevo en una sola línea.";
      auditSecurityEvent({
        companyId,
        chatId,
        sessionId,
        event: "INPUT_BLOCKED",
        reason: "empty_message",
      });
      sessionService.addMessage(sessionId, "assistant", emptyMessageReply);
      return emptyMessageReply;
    }

    if (userMessage.length > 280) {
      const tooLongMessageReply =
        "Para evitar errores, mandame un mensaje más corto (máximo 280 caracteres) con una sola solicitud.";
      auditSecurityEvent({
        companyId,
        chatId,
        sessionId,
        event: "INPUT_BLOCKED",
        reason: "message_too_long",
        userMessage,
        meta: { length: userMessage.length },
      });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", tooLongMessageReply);
      return tooLongMessageReply;
    }

    const earlyInterpretation = interpretIncomingMessage({
      text: userMessage,
      state: deriveStateFromMeta(sessionMeta),
      now: new Date(),
      timezone: "America/Argentina/Buenos_Aires",
      sessionMeta,
      draft: sessionMeta.pendingBookingOffer || sessionMeta.pendingBooking || null,
    });
    const currentFingerprint = fingerprintMessage(userMessage);
    const sameAsPrevious =
      currentFingerprint &&
      currentFingerprint === String(sessionMeta.lastUserMessageFingerprint || "");
    const repeatedCount = sameAsPrevious
      ? Number(sessionMeta.sameMessageRepeatCount || 0) + 1
      : 1;
    sessionService.updateMeta(sessionId, {
      lastUserMessageFingerprint: currentFingerprint,
      sameMessageRepeatCount: repeatedCount,
      lastDetectedIntent: earlyInterpretation.detectedIntent || INTENTS.UNKNOWN,
      conversationState: earlyInterpretation.nextState || deriveStateFromMeta(sessionMeta),
    });

    if (repeatedCount >= MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY) {
      const antiLoopReply = buildAntiLoopReply({
        interpretation: earlyInterpretation,
        sessionMeta,
      });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", antiLoopReply);
      return antiLoopReply;
    }

    const incomingRateResult = enforceIncomingRateLimit({
      sessionId,
      companyId,
      chatId,
      userMessage,
      isControlMessage:
        hasBookingControlKeywords(userMessage) || isAwaitingConcreteAnswer(sessionMeta),
    });
    if (incomingRateResult.blocked) {
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", incomingRateResult.reply);
      return incomingRateResult.reply;
    }

    if (isAwaitingConcreteAnswer(sessionMeta)) {
      const startedAt = Number(sessionMeta.concreteAnswerRequestedAt || 0);
      if (startedAt && Date.now() - startedAt > CONCRETE_RESPONSE_TIMEOUT_MS) {
        sessionService.clearHistory(sessionId);
        const timeoutReply =
          "Pasaron más de 3 minutos sin una respuesta concreta. Reinicié esta conversación para evitar errores.\n" +
          "Empecemos de nuevo: decime si querés *consultar disponibilidad*, *reservar* o *cancelar*.";
        sessionService.addMessage(sessionId, "assistant", timeoutReply);
        return timeoutReply;
      }
      if (!startedAt) {
        stampConcreteAnswerDeadline(sessionId, sessionMeta);
      }
    }

    const earlyDeterministicAction =
      TRANSACTIONAL_MODE_ENABLED && earlyInterpretation?.nextAction
        ? { ...earlyInterpretation.nextAction, source: "deterministic_interpreter" }
        : TRANSACTIONAL_MODE_ENABLED
          ? inferDeterministicAction(userMessage)
          : null;
    const globalInterruptIntent = parseGlobalInterruptIntent(userMessage);
    let forcedActionFromState = null;

    const strictInputState = getStrictInputState(sessionMeta);
    if (strictInputState) {
      const isAllowedStrictInput = isAllowedInputForStrictState(
        userMessage,
        strictInputState,
        sessionMeta,
      );
      const transition = resolveStrictStateTransition({
        state: strictInputState,
        isAllowedInput: isAllowedStrictInput,
        globalIntentAction: globalInterruptIntent?.action || "",
      });

      if (transition.decision === "RESET_FLOW") {
        sessionService.clearHistory(sessionId);
        const resetReply =
          "Reinicié la conversación.\n" +
          "Decime si querés *consultar disponibilidad*, *reservar* o *cancelar*.";
        sessionService.addMessage(sessionId, "assistant", resetReply);
        return resetReply;
      }

      if (globalInterruptIntent?.action === "TALK_TO_ADMIN") {
        clearBookingStrictStateMeta(sessionId);
        sessionMeta = sessionService.getMeta(sessionId);
        const adminReply =
          "Perfecto. Te derivamos con administración. En breve te contactan por este chat.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", adminReply);
        return adminReply;
      }

      if (transition.decision === "RESET_AND_INTERRUPT") {
        clearBookingStrictStateMeta(sessionId);
        sessionMeta = sessionService.getMeta(sessionId);
        if (transition.action === "CHECK_AVAILABILITY") {
          forcedActionFromState = {
            action: "CHECK_AVAILABILITY",
            date: extractDateFromMessage(userMessage) || getTodayIsoArgentina(),
            time: normalizeTimeString(extractTimeFromMessage(userMessage)),
            source: "strict_state_interrupt",
          };
        } else if (transition.action === "CANCEL_BOOKING") {
          forcedActionFromState = {
            action: "CANCEL_BOOKING",
            date: extractDateFromMessage(userMessage),
            time: normalizeTimeString(extractTimeFromMessage(userMessage)),
            source: "strict_state_interrupt",
          };
        } else if (transition.action === "LIST_ACTIVE_BOOKINGS") {
          forcedActionFromState = {
            action: "LIST_ACTIVE_BOOKINGS",
            source: "strict_state_interrupt",
          };
        } else if (transition.action === "CREATE_BOOKING") {
          forcedActionFromState = {
            action: "CREATE_BOOKING",
            date: extractDateFromMessage(userMessage),
            time: normalizeTimeString(extractTimeFromMessage(userMessage)),
            courtName: "INDIFERENTE",
            source: "strict_state_interrupt",
          };
        }
      } else if (transition.decision === "REQUIRE_STATE_INPUT") {
        if (strictInputState === "FULL_NAME_CAPTURE") {
          // En captura de nombre interpretamos el mensaje en lugar de bloquear.
        } else {
          const strictInputReply = buildStrictStateInvalidInputReply(
            strictInputState,
            sessionMeta,
          );
          auditSecurityEvent({
            companyId,
            chatId,
            sessionId,
            event: "STATE_INPUT_BLOCKED",
            reason: strictInputState,
            userMessage,
          });
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", strictInputReply);
          stampConcreteAnswerDeadline(sessionId, sessionMeta);
          return strictInputReply;
        }
      }
    }

    const strictQuestionFlowEnabled = await getStrictQuestionFlowEnabled(companyId);

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
    const canonicalClientPhone = normalizeCanonicalClientPhone(
      registeredPhoneRaw,
      number,
      chatId,
    );

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
          concreteAnswerRequestedAt: null,
        });
      } else {
        const attendanceAnswer = parseAttendanceAnswer(userMessage);
        if (!attendanceAnswer) {
          const optionsOnlyReply = buildAttendanceOptionsOnlyReply();
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", optionsOnlyReply);
          stampConcreteAnswerDeadline(sessionId, sessionMeta);
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
            concreteAnswerRequestedAt: null,
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
          concreteAnswerRequestedAt: null,
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

      if (parseStrictCancel(userMessage)) {
        sessionService.updateMeta(sessionId, {
          pendingBookingDrafts: null,
          pendingBookingClientName: null,
          pendingBookingOffer: null,
          awaitingExtraBookingConfirmation: false,
          concreteAnswerRequestedAt: null,
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
          concreteAnswerRequestedAt:
            Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", summaryReply);
        return summaryReply;
      }

      if (!strictConfirmation) {
        const askSpecificConfirmationReply =
          pendingDrafts.length > 1
            ? "Para evitar errores, indicame exactamente: *CONFIRMAR TODO*, *CONFIRMAR A*, *CONFIRMAR B* o *CANCELAR*."
            : "Para evitar errores, confirmá con *SI*, *OK*, *DALE* o *CONFIRMAR RESERVA*; o cancelá con *CANCELAR*.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(
          sessionId,
          "assistant",
          askSpecificConfirmationReply,
        );
        stampConcreteAnswerDeadline(sessionId, sessionMeta);
        return askSpecificConfirmationReply;
      }

      if (!pendingClientName || !isValidClientName(pendingClientName)) {
        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: true,
          pendingBookingClientName: null,
          pendingBookingOffer: null,
          concreteAnswerRequestedAt:
            Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
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
        awaitingBookingClientNameConfirmation: false,
        pendingBookingClientNameCandidate: null,
        concreteAnswerRequestedAt: null,
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
          concreteAnswerRequestedAt:
            Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
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
            concreteAnswerRequestedAt:
              Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
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
          concreteAnswerRequestedAt: null,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", bookingReply);
        return bookingReply;
      }

      if (parseStrictCancel(userMessage)) {
        sessionService.updateMeta(sessionId, {
          awaitingExtraBookingConfirmation: false,
          pendingBooking: null,
          pendingBookingClientName: null,
          concreteAnswerRequestedAt: null,
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
      stampConcreteAnswerDeadline(sessionId, sessionMeta);
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
        clearConcreteAnswerDeadline(sessionId, { pendingBookingOffer: null });
      } else if (parseStrictCancel(userMessage)) {
        clearConcreteAnswerDeadline(sessionId, { pendingBookingOffer: null });
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
            concreteAnswerRequestedAt:
              Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
          });
          const needNameReply =
            "Antes de reservar, necesito tu *nombre completo* (ej: *Juan Pérez*). Te lo pido para dejar el turno a tu nombre y guardarte en la base de clientes.";
          sessionService.addMessage(sessionId, "user", userMessage);
          sessionService.addMessage(sessionId, "assistant", needNameReply);
          return needNameReply;
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
          awaitingBookingClientNameConfirmation: false,
          pendingBookingClientNameCandidate: null,
          concreteAnswerRequestedAt: null,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", bookingReply);
        return bookingReply;
      } else if (isAffirmativeBookingReply(userMessage)) {
        const strictConfirmReply =
          "Para confirmar sin errores, respondé *SI*, *OK*, *DALE* o *CONFIRMAR RESERVA*; o *CANCELAR*.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", strictConfirmReply);
        stampConcreteAnswerDeadline(sessionId, sessionMeta);
        return strictConfirmReply;
      } else if (!hasDirectBookingIntent(userMessage)) {
        const strictConfirmReply =
          "Todavía estoy esperando una respuesta concreta para ese turno. Respondé *SI*, *OK*, *DALE* o *CONFIRMAR RESERVA*; o *CANCELAR*.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", strictConfirmReply);
        stampConcreteAnswerDeadline(sessionId, sessionMeta);
        return strictConfirmReply;
      }
    }

    if (sessionMeta.awaitingBookingClientNameConfirmation) {
      const candidateName = normalizeNameText(
        sessionMeta.pendingBookingClientNameCandidate || "",
      );
      const yesNoAnswer = parseStrictYesNoAnswer(userMessage);

      if (!yesNoAnswer) {
        const askNameConfirmationAgain =
          `Solo necesito confirmar esto para continuar: ¿tu nombre es *${candidateName || "ese nombre"}*?\n` +
          "Respondé únicamente *SI* o *NO*.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", askNameConfirmationAgain);
        stampConcreteAnswerDeadline(sessionId, sessionMeta);
        return askNameConfirmationAgain;
      }

      if (yesNoAnswer === "NO") {
        sessionService.updateMeta(sessionId, {
          awaitingBookingClientNameConfirmation: false,
          pendingBookingClientNameCandidate: null,
          awaitingFullNameForBooking: true,
          concreteAnswerRequestedAt:
            Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
        });
        const retryNamePrompt =
          "Perfecto, pasame tu *nombre completo* nuevamente (ej: *Juan Pérez*).";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", retryNamePrompt);
        return retryNamePrompt;
      }

      const confirmedName = candidateName;
      if (!confirmedName || !isValidClientName(confirmedName)) {
        sessionService.updateMeta(sessionId, {
          awaitingBookingClientNameConfirmation: false,
          pendingBookingClientNameCandidate: null,
          awaitingFullNameForBooking: true,
          concreteAnswerRequestedAt:
            Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
        });
        const retryNamePrompt =
          "Necesito un *nombre completo válido* para continuar (ej: *Juan Pérez*).";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", retryNamePrompt);
        return retryNamePrompt;
      }

      const savedUser = await userService.saveOrUpdateUser(chatId, confirmedName, {
        companyId,
        client,
      });
      knownName = savedUser?.name || confirmedName;

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
          awaitingBookingClientNameConfirmation: false,
          pendingBookingClientNameCandidate: null,
          awaitingFullNameForBooking: false,
          pendingBookingOffer: null,
          concreteAnswerRequestedAt:
            Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
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
          awaitingBookingClientNameConfirmation: false,
          pendingBookingClientNameCandidate: null,
          awaitingFullNameForBooking: false,
          pendingBooking: null,
          pendingBookingOffer: {
            courtName: draft.courtName,
            dateStr: draft.dateStr,
            timeStr: draft.timeStr,
            createdAt: Date.now(),
          },
          lastRejectedBookingAttempt: null,
          awaitingExtraBookingConfirmation: false,
          pendingBookingClientName: knownName,
          concreteAnswerRequestedAt: Date.now(),
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", summaryReply);
        return summaryReply;
      }

      const continueReply =
        `Perfecto, ${knownName}. Ya te registré en el sistema ✅\n` +
        "Ahora sí, decime fecha y hora del turno y te lo reservo.";
      sessionService.updateMeta(sessionId, {
        awaitingBookingClientNameConfirmation: false,
        pendingBookingClientNameCandidate: null,
        awaitingFullNameForBooking: false,
        pendingBooking: null,
        awaitingExtraBookingConfirmation: false,
        pendingBookingClientName: null,
        concreteAnswerRequestedAt: null,
      });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", continueReply);
      return continueReply;
    }

    // Si estábamos esperando nombre completo para una reserva pendiente, lo resolvemos antes de llamar a IA.
    if (sessionMeta.awaitingFullNameForBooking) {
      const fullNameCaptureGlobalAction =
        globalInterruptIntent?.action || (parseStrictCancel(userMessage) ? "CANCEL_BOOKING" : "");

      if (fullNameCaptureGlobalAction === "RESET_FLOW") {
        sessionService.clearHistory(sessionId);
        const resetReply =
          "Reinicié la conversación.\n" +
          "Decime si querés *consultar disponibilidad*, *reservar* o *cancelar*.";
        sessionService.addMessage(sessionId, "assistant", resetReply);
        return resetReply;
      }

      if (
        fullNameCaptureGlobalAction === "CHECK_AVAILABILITY" ||
        fullNameCaptureGlobalAction === "CANCEL_BOOKING" ||
        fullNameCaptureGlobalAction === "LIST_ACTIVE_BOOKINGS" ||
        fullNameCaptureGlobalAction === "CREATE_BOOKING"
      ) {
        clearBookingStrictStateMeta(sessionId);
        sessionMeta = sessionService.getMeta(sessionId);
        if (fullNameCaptureGlobalAction === "CHECK_AVAILABILITY") {
          forcedActionFromState = {
            action: "CHECK_AVAILABILITY",
            date: extractDateFromMessage(userMessage) || getTodayIsoArgentina(),
            time: normalizeTimeString(extractTimeFromMessage(userMessage)),
            source: "full_name_capture_interrupt",
          };
        } else {
          if (fullNameCaptureGlobalAction === "LIST_ACTIVE_BOOKINGS") {
            forcedActionFromState = {
              action: "LIST_ACTIVE_BOOKINGS",
              source: "full_name_capture_interrupt",
            };
          } else if (fullNameCaptureGlobalAction === "CREATE_BOOKING") {
            forcedActionFromState = {
              action: "CREATE_BOOKING",
              date: extractDateFromMessage(userMessage),
              time: normalizeTimeString(extractTimeFromMessage(userMessage)),
              courtName: "INDIFERENTE",
              source: "full_name_capture_interrupt",
            };
          } else {
            forcedActionFromState = {
              action: "CANCEL_BOOKING",
              date: extractDateFromMessage(userMessage),
              time: normalizeTimeString(extractTimeFromMessage(userMessage)),
              source: "full_name_capture_interrupt",
            };
          }
        }
      }

      if (!sessionMeta.awaitingFullNameForBooking) {
        // Se liberó el estado estricto por intent global; continuar flujo normal.
      } else {
      let fullName = "";
      if (knownName && isValidClientName(knownName)) {
        fullName = normalizeNameText(knownName);
      } else {
        fullName = extractFullNameFromMessage(userMessage);
      }

      if (!fullName || !isValidClientName(fullName)) {
        const retryNamePrompt =
          "Antes de continuar con tu turno, pasame tu *nombre completo* para registrarte (ej: *Juan Pérez*). Es para dejar el turno a tu nombre.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", retryNamePrompt);
        stampConcreteAnswerDeadline(sessionId, sessionMeta);
        return retryNamePrompt;
      }
      sessionService.updateMeta(sessionId, {
        awaitingFullNameForBooking: false,
        awaitingBookingClientNameConfirmation: true,
        pendingBookingClientNameCandidate: fullName,
        concreteAnswerRequestedAt:
          Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
      });
      const confirmNameReply =
        `Entonces tu nombre es *${fullName}*, ¿verdad?\n` +
        "Respondé únicamente *SI* o *NO*.";
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", confirmNameReply);
      return confirmNameReply;
      }
    }

    // 2. Historial
    sessionService.addMessage(sessionId, "user", userMessage);

    let replyText = "";
    let aiResponseRaw = "";
    let parsedData = null;

    if (TRANSACTIONAL_MODE_ENABLED) {
      parsedData =
        forcedActionFromState ||
        earlyDeterministicAction ||
        inferDeterministicAction(userMessage);
    }

    if (!parsedData) {
      const history = sessionService.getHistory(sessionId);
      aiResponseRaw = await groqService.getChatResponse(history, knownName, {
        companyId,
        strictQuestionFlowEnabled,
      });
      parsedData = extractJSON(aiResponseRaw);
    }

    if (parsedData?.action && !ALLOWED_AI_ACTIONS.has(parsedData.action)) {
      parsedData = null;
    }

    if (parsedData) {
      // ==========================================
      // SI ES UN JSON VÁLIDO (Acción o Mensaje)
      // ==========================================

      // CASO 0: MODO DEGRADADO (sin IA por rate limit)
      if (parsedData.action === "SERVICE_DEGRADED") {
        const retryText = parsedData.retryAfterText || "unos minutos";
        const fallback = inferFallbackAction(userMessage);

        if (fallback?.action === "INVALID_TIME_INPUT") {
          replyText =
            "⚠️ La hora no es válida. Decime una hora en formato *HH:mm* entre *00:00* y *23:59*.";
        } else if (fallback?.action === "CHECK_AVAILABILITY") {
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
            lastRejectedBookingAttempt:
              availabilityResponse.rejectedBookingAttempt || null,
            concreteAnswerRequestedAt: availabilityResponse.pendingBookingOffer
              ? Date.now()
              : null,
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
              lastRejectedBookingAttempt:
                availabilityResponse.rejectedBookingAttempt || null,
              concreteAnswerRequestedAt: availabilityResponse.pendingBookingOffer
                ? Date.now()
                : null,
            });
          }
        } else {
          replyText =
            parsedData.message ||
            `🟡 Modo básico activo por límite diario de IA. Volvé a intentar en ${retryText}.`;
        }
      }

      else if (parsedData.action === "INVALID_TIME_INPUT") {
        replyText =
          "⚠️ La hora que enviaste no es válida. Usá formato *HH:mm* entre *00:00* y *23:59*.";
      }

      // CASO A: RESERVAR
      else if (parsedData.action === "CREATE_BOOKING") {
        const requestedDate = parsedData.date;
        const requestedTime = normalizeTimeString(parsedData.time);
        const userDerivedDate = extractDateFromMessage(userMessage);
        const userDerivedTime = normalizeTimeString(extractTimeFromMessage(userMessage));
        const requestedCourt = (parsedData.courtName || "INDIFERENTE").trim();
        const detectedDrafts = extractBookingDraftsFromMessage(
          userMessage,
          requestedCourt,
        );
        const canCreateBookingFromMessage = hasDirectBookingIntent(userMessage);

        if (
          requestedDate &&
          requestedTime &&
          shouldBlockRejectedSlotReattempt({
            rejectedBookingAttempt: sessionMeta.lastRejectedBookingAttempt || null,
            requestedDate,
            requestedTime,
          })
        ) {
          replyText =
            "Ese horario ya fue rechazado por falta de disponibilidad.\n" +
            "Decime otro horario y te lo reviso.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (detectedDrafts.length >= 2) {
          const pendingClientName = normalizeNameText(knownName || "");
          sessionService.updateMeta(sessionId, {
            pendingBookingDrafts: detectedDrafts,
            pendingBookingClientName: pendingClientName || null,
            pendingBookingOffer: null,
            pendingBooking: null,
            awaitingExtraBookingConfirmation: false,
            concreteAnswerRequestedAt: Date.now(),
          });

          if (!pendingClientName || !isValidClientName(pendingClientName)) {
            sessionService.updateMeta(sessionId, {
              awaitingFullNameForBooking: true,
              concreteAnswerRequestedAt:
                Number(sessionMeta.concreteAnswerRequestedAt || 0) || Date.now(),
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
            userDerivedDate &&
            isValidIsoDate(userDerivedDate) &&
            userDerivedTime
          ) {
            sessionService.updateMeta(sessionId, {
              pendingBookingOffer: {
                courtName: requestedCourt,
                dateStr: userDerivedDate,
                timeStr: userDerivedTime,
                createdAt: Date.now(),
              },
              lastRejectedBookingAttempt: null,
              concreteAnswerRequestedAt: Date.now(),
            });
          }
          replyText =
            "Si querés que lo reserve, respondé *SI*, *OK*, *DALE* o *CONFIRMAR RESERVA*.";
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
            concreteAnswerRequestedAt: Date.now(),
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
          lastRejectedBookingAttempt: null,
          awaitingExtraBookingConfirmation: false,
          concreteAnswerRequestedAt: Date.now(),
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
        const invalidTimeInMessage = hasInvalidTimeInput(userMessage);

        if (parsedData.date && !isValidIsoDate(parsedData.date)) {
          replyText =
            "⚠️ No pude entender la fecha. Decime por ejemplo *2026-04-07* o *hoy*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (invalidTimeInMessage || (parsedData.time && !requestedTime)) {
          replyText =
            "⚠️ La hora no es válida. Decime una hora en formato *HH:mm* entre *00:00* y *23:59*.";
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
          lastRejectedBookingAttempt:
            availabilityResponse.rejectedBookingAttempt || null,
          concreteAnswerRequestedAt: availabilityResponse.pendingBookingOffer
            ? Date.now()
            : null,
        });
      }

      // CASO C: LISTAR RESERVAS VIGENTES DEL CLIENTE
      else if (parsedData.action === "LIST_ACTIVE_BOOKINGS") {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        const activeBookings = await bookingService.getActiveBookingsForClient({
          companyId,
          clientPhone: canonicalClientPhone,
            clientWhatsappId: chatId,
          limit: 15,
        });
        if (activeBookings.success) {
          replyText = buildActiveBookingsReply(activeBookings.data);
        } else {
          replyText = "⚠️ No pude consultar tus reservas vigentes en este momento.";
        }
      }

      // CASO D: CANCELAR TURNO
      else if (parsedData.action === "CANCEL_BOOKING") {
        sessionService.updateMeta(sessionId, { pendingBookingOffer: null });
        const requestedDate = parsedData.date || extractDateFromMessage(userMessage);
        const requestedTime = normalizeTimeString(
          parsedData.time || extractTimeFromMessage(userMessage),
        );

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
            `📅 *Fecha:* ${getFormattedDate(cancelResult.data?.date || requestedDate)}\n` +
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
        replyText = sanitizeModelOnlyMessage(parsedData.message);
      }

      // CASO G: JSON DESCONOCIDO
      else {
        const fallback = inferFallbackAction(userMessage);
        if (fallback?.action === "INVALID_TIME_INPUT") {
          replyText =
            "⚠️ La hora no es válida. Decime una hora en formato *HH:mm* entre *00:00* y *23:59*.";
        } else if (fallback?.action === "CHECK_AVAILABILITY") {
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
            lastRejectedBookingAttempt:
              availabilityResponse.rejectedBookingAttempt || null,
            concreteAnswerRequestedAt: availabilityResponse.pendingBookingOffer
              ? Date.now()
              : null,
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

      if (fallback?.action === "INVALID_TIME_INPUT") {
        replyText =
          "⚠️ La hora no es válida. Decime una hora en formato *HH:mm* entre *00:00* y *23:59*.";
      } else if (fallback?.action === "CHECK_AVAILABILITY") {
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
          lastRejectedBookingAttempt:
            availabilityResponse.rejectedBookingAttempt || null,
          concreteAnswerRequestedAt: availabilityResponse.pendingBookingOffer
            ? Date.now()
            : null,
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
        replyText = sanitizeModelOnlyMessage(
          aiResponseRaw
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim(),
        );
      }
    }

    // 5. Enviar y Guardar
    if (strictQuestionFlowEnabled) {
      replyText = enforceStrictQuestionFlowReply(replyText);
    }
    sessionService.addMessage(sessionId, "assistant", replyText);
    return replyText;
  } catch (error) {
    console.error("❌ Error en messageHandler:", error);
    return "Tuve un error procesando tu mensaje.";
  }
};

module.exports = { handleIncomingMessage };
