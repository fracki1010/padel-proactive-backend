const AppConfig = require("../models/appConfig.model");
const Booking = require("../models/booking.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const { isMongoConnected } = require("../config/database");
const { getWhatsappState } = require("../state/whatsapp.state");
const { getReadyClient } = require("./whatsappTenantManager.service");
const {
  getWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestLastSentDate,
} = require("./appConfig.service");
const {
  getTodayIsoInTimezone,
} = require("./whatsappCancellationGroup.service");

const CONFIG_KEY = "main";
const TIMEZONE = "America/Argentina/Buenos_Aires";
const CHECK_INTERVAL_MS = 60 * 1000;
const DAILY_HOUR_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_SEND_TIME = DAILY_HOUR_REGEX.test(
  String(process.env.DAILY_AVAILABILITY_DIGEST_TIME || "").trim(),
)
  ? String(process.env.DAILY_AVAILABILITY_DIGEST_TIME).trim()
  : "09:00";

let timer = null;
let isRunning = false;

const buildCompanyFilter = (companyId = null) => ({ companyId: companyId || null });

const dateStringToUtcMidnight = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};

const parseTimeToMinutes = (timeStr) => {
  const [hour, minute] = String(timeStr || "")
    .split(":")
    .map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
};

const getCurrentMinutesInTimezone = (timeZone = TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
};

const buildDigestMessage = (entries = []) => {
  if (!entries.length) {
    return [
      "🎾 *Disponibilidad de hoy*",
      "",
      "Hoy no quedan turnos disponibles.",
    ].join("\n");
  }

  const lines = entries.map(
    (entry) =>
      `• ${entry.startTime}-${entry.endTime}: ${entry.availableCourts} cancha(s) libre(s)`,
  );

  return [
    "🎾 *Disponibilidad de hoy*",
    "",
    ...lines,
    "",
    "Reservá por este chat.",
  ].join("\n");
};

const buildAvailabilityEntries = async (companyId = null) => {
  const scope = buildCompanyFilter(companyId);
  const todayIso = getTodayIsoInTimezone(TIMEZONE);
  const todayUtcDate = dateStringToUtcMidnight(todayIso);
  const nowMinutes = getCurrentMinutesInTimezone(TIMEZONE);

  const [totalActiveCourts, slots, bookings] = await Promise.all([
    Court.countDocuments({ ...scope, isActive: true }),
    TimeSlot.find({ ...scope, isActive: true }).sort({ order: 1 }).lean(),
    Booking.find({
      ...scope,
      date: todayUtcDate,
      status: { $ne: "cancelado" },
    })
      .select("timeSlot")
      .lean(),
  ]);

  if (totalActiveCourts <= 0 || !slots.length) return [];

  const busyBySlotId = bookings.reduce((acc, booking) => {
    const slotId = String(booking?.timeSlot || "");
    if (!slotId) return acc;
    acc[slotId] = (acc[slotId] || 0) + 1;
    return acc;
  }, {});

  return slots
    .filter((slot) => parseTimeToMinutes(slot.startTime) > nowMinutes)
    .map((slot) => {
      const busy = Number(busyBySlotId[String(slot._id)] || 0);
      const availableCourts = Math.max(0, totalActiveCourts - busy);
      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        availableCourts,
      };
    })
    .filter((entry) => entry.availableCourts > 0);
};

const processCompany = async (config) => {
  const companyId = config.companyId || null;
  const todayIso = getTodayIsoInTimezone(TIMEZONE);
  const nowMinutes = getCurrentMinutesInTimezone(TIMEZONE);
  const configuredHour = String(config.dailyAvailabilityDigestHour || "").trim();
  const sendTimeMinutes = parseTimeToMinutes(
    DAILY_HOUR_REGEX.test(configuredHour) ? configuredHour : DEFAULT_SEND_TIME,
  );

  if (nowMinutes < sendTimeMinutes) return;
  if (String(config.dailyAvailabilityDigestLastSentDate || "") === todayIso) return;

  const groupSettings = await getWhatsappCancellationGroupSettings(companyId);
  if (!groupSettings.groupId) return;

  const waState = getWhatsappState(companyId);
  if (!waState.enabled) return;

  let client;
  try {
    client = getReadyClient(companyId);
  } catch {
    return;
  }

  const entries = await buildAvailabilityEntries(companyId);
  const message = buildDigestMessage(entries);
  const groupId = String(groupSettings.groupId).trim().endsWith("@g.us")
    ? String(groupSettings.groupId).trim()
    : `${String(groupSettings.groupId).trim()}@g.us`;
  if (!groupId.endsWith("@g.us")) return;

  await client.sendMessage(groupId, message);
  await setDailyAvailabilityDigestLastSentDate(todayIso, companyId);
};

const runSweep = async () => {
  if (isRunning) return;
  if (!isMongoConnected()) return;
  isRunning = true;
  try {
    const configs = await AppConfig.find({
      key: CONFIG_KEY,
      whatsappEnabled: true,
      dailyAvailabilityDigestEnabled: true,
    }).select(
      "companyId dailyAvailabilityDigestLastSentDate dailyAvailabilityDigestHour",
    );

    for (const config of configs) {
      try {
        await processCompany(config);
      } catch (error) {
        console.error(
          `[DailyAvailabilityDigest][${config.companyId || "global"}] Error:`,
          error?.message || error,
        );
      }
    }
  } finally {
    isRunning = false;
  }
};

const startDailyAvailabilityDigestMonitor = () => {
  if (timer) return;
  timer = setInterval(runSweep, CHECK_INTERVAL_MS);
  runSweep().catch(() => {});
};

module.exports = {
  startDailyAvailabilityDigestMonitor,
};
