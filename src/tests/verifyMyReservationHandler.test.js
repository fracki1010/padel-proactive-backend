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

const { getTodayIsoArgentina } = require("../whatsapp/domain/bookingDateTime");

const state = {
  activeBookings: { success: true, data: [] },
  availableSlots: {
    success: true,
    slots: [{ time: "18:30", availableCourts: 1, totalCourts: 1, price: 5000, courtTypes: [] }],
  },
  groqReply: null, // null → lanzar error (la IA no debe llamarse en intentos determinísticos)
  getActiveBookingsCalls: 0,
  getAvailableSlotsCalls: 0,
};

const timeSlotStub = () => ({
  _id: "ts-stub",
  startTime: "18:30",
  endTime: "19:30",
  price: 5000,
  select: () => ({
    lean: async () => ({ _id: "ts-stub", endTime: "19:30", price: 5000 }),
  }),
});

stubModule("../services/bookingService", {
  getActiveBookingsForClient: async () => {
    state.getActiveBookingsCalls += 1;
    return state.activeBookings;
  },
  getAvailableSlots: async () => {
    state.getAvailableSlotsCalls += 1;
    return state.availableSlots;
  },
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
  sendAdminNotification: async () => undefined,
});
stubModule("../utils/getNumberByUser", {
  getNumberByUser: async () => "5491100000000",
});
stubModule("../services/groqService", {
  getChatResponse: async () => {
    if (state.groqReply === null) {
      throw new Error("groqService should not be called for deterministic intents");
    }
    return state.groqReply;
  },
});
stubModule("../models/booking.model", {
  findOne: async () => null,
  findOneAndUpdate: async () => null,
  updateOne: async () => ({}),
  find: () => ({ lean: async () => [] }),
});
stubModule("../models/user.model", {
  findOne: async () => null,
  findOneAndUpdate: async () => null,
});
stubModule("../models/timeSlot.model", {
  // NO async: el handler encadena TimeSlot.findOne({...}).select().lean(),
  // como en producción (Query de Mongoose). Devolvemos el objeto encadenable.
  findOne: (query = {}) => {
    if (query?.startTime === "18:30") return timeSlotStub();
    return null;
  },
  find: () => ({ lean: async () => [] }),
});

const sessionService = require("../services/sessionService");
const { handleIncomingMessage } = require("../handlers/messageHandler");

const makeBooking = (overrides = {}) => ({
  type: "individual",
  date: getTodayIsoArgentina(),
  startTime: "18:30",
  endTime: "19:30",
  courtName: "Cancha 1",
  status: "confirmado",
  ...overrides,
});

const resetState = () => {
  state.activeBookings = { success: true, data: [] };
  state.groqReply = null;
  state.getActiveBookingsCalls = 0;
  state.getAvailableSlotsCalls = 0;
};

const availabilityIntentFromAI = (date) =>
  JSON.stringify({ action: "CHECK_AVAILABILITY", date, time: "18:30" });

// ============================================================
// Caso real 1 y 4: "quiero saber si mi reserva está confirmada"
// y "mi reserva" → muestra sus reservas vigentes de inmediato.
// ============================================================
test("'quiero saber si mi reserva está confirmada' → lista sus reservas vigentes", async () => {
  resetState();
  const chatId = "verify-reservation-confirmation-phrase";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };

  const reply = await handleIncomingMessage(chatId, "Quiero saber si mi reserva está confirmada");

  assert.match(reply, /reservas vigentes/i);
  assert.match(reply, /Cancha 1/);
  assert.equal(state.getActiveBookingsCalls, 1);
  assert.equal(state.getAvailableSlotsCalls, 0);
});

test("'mi reserva' → lista sus reservas vigentes, NO 'para reservar necesito día y hora'", async () => {
  resetState();
  const chatId = "verify-reservation-singular";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };

  const reply = await handleIncomingMessage(chatId, "Mi reserva");

  assert.match(reply, /reservas vigentes/i);
  assert.match(reply, /Cancha 1/);
  assert.doesNotMatch(reply, /Para reservar necesito/i);
});

test("'mi reserva' sin reservas → aviso de que no encontró reservas vigentes", async () => {
  resetState();
  const chatId = "verify-reservation-singular-empty";
  sessionService.clearHistory(chatId);

  const reply = await handleIncomingMessage(chatId, "Mi reserva");

  assert.match(reply, /No encontré reservas vigentes/i);
  assert.doesNotMatch(reply, /Para reservar necesito/i);
});

// ============================================================
// Caso real 2, 3 y 5: fecha+hora con reserva existente en ese slot.
// El AI clasifica el mensaje como CHECK_AVAILABILITY (como en
// producción: "¿Techada o Descubierta?"), y ahora el handler debe
// responder el estado de ESA reserva en vez de sugerir canchas.
// ============================================================
test("'6/10 18:30' con reserva del cliente en ese slot → estado de esa reserva", async () => {
  resetState();
  const chatId = "verify-reservation-exact-slot";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };
  state.groqReply = availabilityIntentFromAI(getTodayIsoArgentina());

  const reply = await handleIncomingMessage(chatId, "6/10 18:30");

  assert.match(reply, /Ya tenés una reserva/i);
  assert.match(reply, /Cancha 1/);
  assert.match(reply, /Confirmada/);
  assert.doesNotMatch(reply, /No entendí/i);
  assert.doesNotMatch(reply, /disponibilidad/i);
  assert.equal(state.getAvailableSlotsCalls, 0);
});

test("'hoy a las 18:30' con reserva del cliente en ese slot → estado de esa reserva", async () => {
  resetState();
  const chatId = "verify-reservation-today-time";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };
  state.groqReply = availabilityIntentFromAI(getTodayIsoArgentina());

  const reply = await handleIncomingMessage(chatId, "Hoy a las 18:30");

  assert.match(reply, /Ya tenés una reserva/i);
  assert.match(reply, /Cancha 1/);
  assert.doesNotMatch(reply, /Techada|Descubierta/i);
  assert.equal(state.getAvailableSlotsCalls, 0);
});

test("'hoy 6 de octubre horario 18:30hs' con reserva en ese slot → estado de esa reserva", async () => {
  resetState();
  const chatId = "verify-reservation-long-form";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };
  state.groqReply = availabilityIntentFromAI(getTodayIsoArgentina());

  const reply = await handleIncomingMessage(chatId, "Hoy 6 de octubre horario 18:30hs");

  assert.match(reply, /Ya tenés una reserva/i);
  assert.match(reply, /Cancha 1/);
  assert.doesNotMatch(reply, /No entendí/i);
});

test("'hoy a las 18:30' SIN reserva en ese slot → flujo normal de disponibilidad", async () => {
  resetState();
  const chatId = "verify-reservation-no-match";
  sessionService.clearHistory(chatId);
  state.groqReply = availabilityIntentFromAI(getTodayIsoArgentina());

  const reply = await handleIncomingMessage(chatId, "Hoy a las 18:30");

  assert.match(reply, /disponibilidad/i);
  assert.doesNotMatch(reply, /Ya tenés una reserva/i);
  assert.equal(state.getActiveBookingsCalls, 1);
  assert.equal(state.getAvailableSlotsCalls, 1);
});

// ============================================================
// Prioridad de reserva existente sobre CREATE_BOOKING
// ============================================================
test("'quiero reservar hoy a las 18:30' con reserva en ese slot → estado, no agendar", async () => {
  resetState();
  const chatId = "verify-reservation-create-priority";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };

  const reply = await handleIncomingMessage(chatId, "Quiero reservar hoy a las 18:30");

  assert.match(reply, /Ya tenés una reserva/i);
  assert.match(reply, /Cancha 1/);
  assert.doesNotMatch(reply, /nombre completo/i);
  assert.equal(state.getAvailableSlotsCalls, 0);
});

test("'quiero reservar hoy a las 20:00' sin reserva → sigue siendo CREATE_BOOKING", async () => {
  resetState();
  const chatId = "verify-reservation-create-normal";
  sessionService.clearHistory(chatId);

  const reply = await handleIncomingMessage(chatId, "Quiero reservar hoy a las 20:00");

  assert.match(reply, /nombre completo/i);
  assert.doesNotMatch(reply, /Ya tenés una reserva/i);
  assert.doesNotMatch(reply, /reservas vigentes/i);
});