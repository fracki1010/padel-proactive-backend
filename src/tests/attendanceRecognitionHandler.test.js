const test = require("node:test");
const assert = require("node:assert/strict");

// Inyectar stubs ANTES de requerir el handler para no tocar la base ni el worker.
const stubModule = (requestPath, exportsObj) => {
  const resolved = require.resolve(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
  return resolved;
};

const state = {
  activeAttendanceBooking: null,
  fallbackAttendanceBooking: null,
  notifications: [],
  userConfirmedCount: 1,
};

const makePopulatable = (booking) => ({ populate: async () => booking });

stubModule("../services/bookingService", {
  getActiveBookingsForClient: async () => ({ success: true, data: [] }),
  getAvailableSlots: async () => ({ success: true, slots: [] }),
  cancelBooking: async () => ({ success: false }),
  createNewBooking: async () => ({ success: false }),
});
stubModule("../services/userService", {
  getUserByWhatsappId: async () => null,
  saveOrUpdateUser: async () => null,
});
stubModule("../services/appConfig.service", {
  DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT: 3,
  DEFAULT_STRICT_QUESTION_FLOW_ENABLED: false,
  getStrictQuestionFlowEnabled: async () => false,
  getTrustedClientConfirmationCount: async () => 3,
});
stubModule("../services/notificationService", {
  sendAdminNotification: async (...args) => {
    state.notifications.push(args);
  },
});
stubModule("../utils/getNumberByUser", {
  getNumberByUser: async () => "5491100000000",
});
stubModule("../services/groqService", {
  getChatResponse: async () => {
    throw new Error("groqService should not be called in deterministic attendance flow");
  },
});
stubModule("../models/booking.model", {
  // El handler encadena Booking.findOne(...).populate("timeSlot").
  findOne: (query = {}) =>
    makePopulatable(
      query && query._id
        ? state.activeAttendanceBooking
        : state.fallbackAttendanceBooking,
    ),
  findOneAndUpdate: async () => null,
  updateOne: async () => ({}),
  find: () => ({ lean: async () => [] }),
});
stubModule("../models/user.model", {
  findOne: async () => null,
  findOneAndUpdate: async () => ({
    attendanceConfirmedCount: state.userConfirmedCount,
  }),
});
stubModule("../models/timeSlot.model", {
  findOne: () => null,
  find: () => ({ lean: async () => [] }),
});

const sessionService = require("../services/sessionService");
const { handleIncomingMessage } = require("../handlers/messageHandler");

const makeAttendanceBooking = (overrides = {}) => ({
  _id: "booking-1",
  companyId: null,
  status: "confirmado",
  clientName: "Juan Perez",
  clientPhone: "5491100000000",
  date: new Date("2026-05-01T00:00:00.000Z"),
  attendanceConfirmationStatus: "pending",
  attendanceConfirmationSentAt: new Date(),
  attendanceConfirmationRespondedAt: null,
  timeSlot: { startTime: "20:00", endTime: "21:00" },
  ...overrides,
});

const resetState = () => {
  state.activeAttendanceBooking = null;
  state.fallbackAttendanceBooking = null;
  state.notifications = [];
  state.userConfirmedCount = 1;
};

// ============================================================
// Sesión de asistencia activa (flujo original) + parser tolerante
// ============================================================
test("'si asisto' con sesión de asistencia activa → confirma", async () => {
  resetState();
  const chatId = "attendance-active-si";
  sessionService.clearHistory(chatId);
  state.activeAttendanceBooking = makeAttendanceBooking();
  sessionService.updateMeta(chatId, {
    awaitingAttendanceConfirmation: true,
    attendanceBookingId: "booking-1",
  });

  const reply = await handleIncomingMessage(chatId, "si asisto");

  assert.match(reply, /gracias por confirmar/i);
  assert.equal(state.notifications.length, 0);
});

test("'si, voy' (variante no exacta) con sesión activa → confirma", async () => {
  resetState();
  const chatId = "attendance-active-voy";
  sessionService.clearHistory(chatId);
  state.activeAttendanceBooking = makeAttendanceBooking();
  sessionService.updateMeta(chatId, {
    awaitingAttendanceConfirmation: true,
    attendanceBookingId: "booking-1",
  });

  const reply = await handleIncomingMessage(chatId, "si, voy");

  assert.match(reply, /gracias por confirmar/i);
});

// ============================================================
// Fallback @lid: sin sesión activa, pero con reserva pendiente del cliente
// ============================================================
test("'si asisto' sin sesión activa pero con reserva pendiente del cliente → confirma (fallback)", async () => {
  resetState();
  const chatId = "attendance-fallback-si";
  sessionService.clearHistory(chatId);
  state.fallbackAttendanceBooking = makeAttendanceBooking();

  const reply = await handleIncomingMessage(chatId, "si asisto");

  assert.match(reply, /gracias por confirmar/i);
  assert.equal(state.notifications.length, 0);
});

test("'no asisto' sin sesión activa pero con reserva pendiente → declina y notifica al admin", async () => {
  resetState();
  const chatId = "attendance-fallback-no";
  sessionService.clearHistory(chatId);
  state.fallbackAttendanceBooking = makeAttendanceBooking();

  const reply = await handleIncomingMessage(chatId, "no asisto");

  assert.match(reply, /gracias por avisar/i);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0][0], "attendance_declined");
});

test("'no puedo ir' (variante) con reserva pendiente → declina (fallback)", async () => {
  resetState();
  const chatId = "attendance-fallback-no-variant";
  sessionService.clearHistory(chatId);
  state.fallbackAttendanceBooking = makeAttendanceBooking();

  const reply = await handleIncomingMessage(chatId, "no puedo ir");

  assert.match(reply, /gracias por avisar/i);
});

// ============================================================
// No regresiones: sin reserva pendiente o con otro intent
// ============================================================
test("'si asisto' sin reserva pendiente → NO se desvía al flujo de asistencia", async () => {
  resetState();
  const chatId = "attendance-no-pending";
  sessionService.clearHistory(chatId);

  const reply = await handleIncomingMessage(chatId, "si asisto");

  assert.doesNotMatch(reply, /gracias por confirmar/i);
  assert.doesNotMatch(reply, /gracias por avisar/i);
  assert.equal(state.notifications.length, 0);
});

test("'quiero reservar hoy 20' no es interceptado por el fallback de asistencia → sigue CREATE_BOOKING", async () => {
  resetState();
  const chatId = "attendance-create-booking";
  sessionService.clearHistory(chatId);
  // Incluso con una reserva pendiente, un pedido de reserva no es asistencia.
  state.fallbackAttendanceBooking = makeAttendanceBooking();

  const reply = await handleIncomingMessage(chatId, "quiero reservar hoy 20");

  assert.match(reply, /nombre completo/i);
  assert.doesNotMatch(reply, /gracias por confirmar/i);
  assert.equal(state.notifications.length, 0);
});
