const AppConfig = require("../models/appConfig.model");
const Booking = require("../models/booking.model");
const User = require("../models/user.model");
const sessionService = require("./sessionService");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("./whatsappCommandQueue.service");
const { isMongoConnected } = require("../config/database");
const { sendAdminNotification } = require("./notificationService");
const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
const {
  getAttendanceReminderLeadMinutes,
  getAttendanceResponseTimeoutMinutes,
  getOneHourReminderEnabled,
  getTrustedClientConfirmationCount,
} = require("./appConfig.service");

const CONFIG_KEY = "main";
const CHECK_INTERVAL_MS = 60 * 1000;
const ARG_TZ_OFFSET = "-03:00";
const ASK_WINDOW_BEFORE_MINUTES = 2;
const ASK_WINDOW_AFTER_MINUTES = 10;
const ATTENDANCE_DEBUG =
  String(process.env.ATTENDANCE_DEBUG || "")
    .trim()
    .toLowerCase() === "true";

let timer = null;
let isRunning = false;

const debugLog = (...args) => {
  if (!ATTENDANCE_DEBUG) return;
  console.log("[AttendanceConfirmation][debug]", ...args);
};

const toUtcMidnightFromIso = (isoDate) => {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};

const getTodayIsoArgentina = () => {
  const nowArg = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
    }),
  );
  const year = nowArg.getFullYear();
  const month = String(nowArg.getMonth() + 1).padStart(2, "0");
  const day = String(nowArg.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const addDaysIso = (iso, days) => {
  const [year, month, day] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};

const buildSessionId = (companyId, chatId) =>
  companyId ? `${companyId}:${chatId}` : chatId;

const getBookingIsoDate = (bookingDate) =>
  new Date(bookingDate).toISOString().slice(0, 10);

const buildBookingStartDate = (bookingDate, startTime) => {
  const isoDate = getBookingIsoDate(bookingDate);
  return new Date(`${isoDate}T${startTime}:00${ARG_TZ_OFFSET}`);
};

const getEnabledCompanyIds = async () => {
  const configs = await AppConfig.find({
    key: CONFIG_KEY,
    whatsappEnabled: true,
  }).select("companyId");

  if (!configs.length) return [null];

  return configs.map((cfg) => cfg.companyId || null);
};

const buildAttendancePrompt = (
  booking,
  reminderLeadMinutes,
  attendanceResponseTimeoutMinutes,
) => {
  const startTime = booking.timeSlot?.startTime || "";
  const endTime = booking.timeSlot?.endTime || "";
  const courtName = booking.court?.name || "tu cancha";

  const reminderText =
    reminderLeadMinutes === 60
      ? "en 1 hora"
      : `en ${reminderLeadMinutes} minutos`;

  return (
    `⏰ Tu turno empieza ${reminderText}.\n` +
    `📌 ${courtName} - ${startTime}${endTime ? ` a ${endTime}` : ""}\n\n` +
    `Confirmá asistencia respondiendo SOLO una opción:\n` +
    `1) SI ASISTO\n` +
    `2) NO ASISTO\n\n` +
    `Si respondés *NO ASISTO*, avisamos al administrador para que gestione la situación.\n` +
    `Si no respondés en ${attendanceResponseTimeoutMinutes} minutos, también se notifica al administrador.`
  );
};

const notifyAdminForNoResponse = async (
  companyId = null,
  attendanceResponseTimeoutMinutes = 15,
) => {
  if (!Number.isFinite(attendanceResponseTimeoutMinutes)) return;
  if (attendanceResponseTimeoutMinutes <= 0) return;

  const cutoffDate = new Date(
    Date.now() - attendanceResponseTimeoutMinutes * 60 * 1000,
  );

  const pendingBookings = await Booking.find({
    companyId: companyId || null,
    status: { $in: ["confirmado", "reservado"] },
    attendanceConfirmationStatus: "pending",
    attendanceConfirmationSentAt: { $ne: null, $lte: cutoffDate },
    attendanceConfirmationRespondedAt: null,
    attendanceNoResponseNotifiedAt: null,
  })
    .populate("timeSlot")
    .populate("court")
    .lean();

  for (const booking of pendingBookings) {
    try {
      await sendAdminNotification(
        "attendance_no_response",
        "Cliente sin respuesta de asistencia",
        `Cliente: ${booking.clientName}\nTeléfono: ${booking.clientPhone}\nFecha: ${formatBookingDateShort(
          booking.date,
        )}\nHora: ${booking?.timeSlot?.startTime || "N/D"}\nCancha: ${booking?.court?.name || "N/D"}\n\nNo respondió la confirmación de asistencia dentro de ${attendanceResponseTimeoutMinutes} minutos.`,
        { bookingId: booking._id, companyId },
        { companyId },
      );

      await Booking.updateOne(
        {
          _id: booking._id,
          attendanceNoResponseNotifiedAt: null,
        },
        {
          $set: {
            attendanceNoResponseNotifiedAt: new Date(),
          },
        },
      );
    } catch (error) {
      console.error(
        `[AttendanceConfirmation][${companyId || "global"}] Error notificando falta de respuesta al admin:`,
        error?.message || error,
      );
    }
  }
};

const processCompany = async (companyId = null) => {
  const oneHourReminderEnabled = await getOneHourReminderEnabled(companyId);
  if (!oneHourReminderEnabled) {
    debugLog(`company=${companyId || "global"} skip: reminder disabled`);
    return;
  }

  const trustedClientConfirmationCount =
    await getTrustedClientConfirmationCount(companyId);
  const attendanceReminderLeadMinutes =
    await getAttendanceReminderLeadMinutes(companyId);
  const attendanceResponseTimeoutMinutes =
    await getAttendanceResponseTimeoutMinutes(companyId);

  await notifyAdminForNoResponse(companyId, attendanceResponseTimeoutMinutes);

  const todayIso = getTodayIsoArgentina();
  const tomorrowIso = addDaysIso(todayIso, 1);
  const datesToCheck = [
    toUtcMidnightFromIso(todayIso),
    toUtcMidnightFromIso(tomorrowIso),
  ];

  const bookings = await Booking.find({
    companyId: companyId || null,
    date: { $in: datesToCheck },
    status: { $in: ["confirmado", "reservado"] },
    attendanceConfirmationSentAt: null,
    attendanceConfirmationStatus: null,
  })
    .populate("timeSlot")
    .populate("court")
    .lean();

  const stats = {
    totalCandidates: bookings.length,
    skippedMissingStartOrPhone: 0,
    skippedUserNotFound: 0,
    markedTrustedNoPrompt: 0,
    skippedMissingWhatsappId: 0,
    skippedOutsideWindow: 0,
    skippedLockRace: 0,
    enqueuedPrompt: 0,
    enqueueErrors: 0,
  };

  const now = new Date();
  debugLog(
    `company=${companyId || "global"} candidates=${bookings.length} leadMin=${attendanceReminderLeadMinutes} timeoutMin=${attendanceResponseTimeoutMinutes}`,
  );

  for (const booking of bookings) {
    const startTime = booking.timeSlot?.startTime;
    if (!startTime || !booking.clientPhone) {
      stats.skippedMissingStartOrPhone += 1;
      continue;
    }

    const user = await User.findOne({
      companyId: companyId || null,
      phoneNumber: booking.clientPhone,
    }).lean();

    if (!user) {
      stats.skippedUserNotFound += 1;
      continue;
    }

    // Cliente cumplidor: no volvemos a preguntar.
    if (
      (user?.attendanceConfirmedCount || 0) >= trustedClientConfirmationCount
    ) {
      await Booking.updateOne(
        { _id: booking._id, attendanceConfirmationStatus: null },
        {
          $set: {
            attendanceConfirmationStatus: "not_required",
            attendanceConfirmationSentAt: new Date(),
          },
        },
      );
      stats.markedTrustedNoPrompt += 1;
      continue;
    }

    if (!user?.whatsappId) {
      stats.skippedMissingWhatsappId += 1;
      continue;
    }

    const startDate = buildBookingStartDate(booking.date, startTime);
    const minutesLeft = (startDate.getTime() - now.getTime()) / 60000;
    if (
      minutesLeft > attendanceReminderLeadMinutes + ASK_WINDOW_BEFORE_MINUTES ||
      minutesLeft < attendanceReminderLeadMinutes - ASK_WINDOW_AFTER_MINUTES
    ) {
      stats.skippedOutsideWindow += 1;
      continue;
    }

    const locked = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        status: { $in: ["confirmado", "reservado"] },
        attendanceConfirmationSentAt: null,
        attendanceConfirmationStatus: null,
      },
      {
        $set: {
          attendanceConfirmationStatus: "pending",
          attendanceConfirmationSentAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );

    if (!locked) {
      stats.skippedLockRace += 1;
      continue;
    }

    try {
      await enqueueWhatsappCommand({
        companyId,
        type: COMMAND_TYPES.SEND_MESSAGE,
        payload: {
          to: user.whatsappId,
          message: buildAttendancePrompt(
            booking,
            attendanceReminderLeadMinutes,
            attendanceResponseTimeoutMinutes,
          ),
        },
      });

      const sessionId = buildSessionId(companyId, user.whatsappId);
      sessionService.updateMeta(sessionId, {
        awaitingAttendanceConfirmation: true,
        attendanceBookingId: String(booking._id),
      });
      stats.enqueuedPrompt += 1;
      debugLog(
        `company=${companyId || "global"} queued booking=${booking._id} to=${user.whatsappId}`,
      );
    } catch (error) {
      await Booking.updateOne(
        {
          _id: booking._id,
          attendanceConfirmationStatus: "pending",
          attendanceConfirmationRespondedAt: null,
        },
        {
          $set: {
            attendanceConfirmationStatus: null,
            attendanceConfirmationSentAt: null,
          },
        },
      );
      console.error(
        `[AttendanceConfirmation] Error enviando prompt a ${user.whatsappId}:`,
        error?.message || error,
      );
      stats.enqueueErrors += 1;
    }
  }

  debugLog(
    `company=${companyId || "global"} summary=${JSON.stringify(stats)}`,
  );
};

const runAttendanceSweep = async () => {
  if (isRunning) return;
  if (!isMongoConnected()) {
    console.warn(
      "[AttendanceConfirmation] Barrido omitido: MongoDB no está conectado.",
    );
    return;
  }
  isRunning = true;
  debugLog("sweep:start");

  try {
    const companyIds = await getEnabledCompanyIds();
    debugLog(`sweep:enabledCompanies=${companyIds.length}`);
    for (const companyId of companyIds) {
      await processCompany(companyId);
    }
  } catch (error) {
    console.error(
      "[AttendanceConfirmation] Error en barrido:",
      error?.message || error,
    );
  } finally {
    isRunning = false;
    debugLog("sweep:end");
  }
};

const startAttendanceConfirmationMonitor = () => {
  if (timer) return;
  timer = setInterval(runAttendanceSweep, CHECK_INTERVAL_MS);
  runAttendanceSweep().catch(() => {});
};

module.exports = {
  startAttendanceConfirmationMonitor,
};
