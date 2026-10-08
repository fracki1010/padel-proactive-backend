const test = require("node:test");
const assert = require("node:assert/strict");

// Inject service/model stubs BEFORE requiring the handler so the handler binds
// to the mocks and does not touch the database or the WhatsApp worker.
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
  activeBookings: { success: true, data: [] },
  availableSlots: {
    success: true,
    slots: [{ time: "18:00", availableCourts: 2, price: 5000, courtTypes: [] }],
  },
  getActiveBookingsCalls: 0,
  getAvailableSlotsCalls: 0,
};

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
  getUserByIdentity: async () => null,
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
    throw new Error("groqService should not be called for deterministic intents");
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
  findOne: async () => null,
  find: () => ({ lean: async () => [] }),
});

const sessionService = require("../services/sessionService");
const { handleIncomingMessage } = require("../handlers/messageHandler");

const makeBooking = () => ({
  type: "one-off",
  startTime: "18:00",
  endTime: "19:00",
  courtName: "Cancha 1",
  date: "2099-01-01",
});

const resetState = () => {
  state.activeBookings = { success: true, data: [] };
  state.getActiveBookingsCalls = 0;
  state.getAvailableSlotsCalls = 0;
};

test("ambiguo ('turnos disponibles') + cliente con reservas → muestra sus reservas", async () => {
  resetState();
  const chatId = "test-my-turns-with-bookings";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };

  const reply = await handleIncomingMessage(chatId, "turnos disponibles");

  assert.match(reply, /reservas vigentes/i);
  assert.match(reply, /Cancha 1/);
  assert.equal(state.getActiveBookingsCalls, 1);
  assert.equal(state.getAvailableSlotsCalls, 0);
});

test("ambiguo ('turnos') + cliente sin reservas → muestra disponibilidad del club", async () => {
  resetState();
  const chatId = "test-my-turns-without-bookings";
  sessionService.clearHistory(chatId);

  const reply = await handleIncomingMessage(chatId, "turnos");

  assert.match(reply, /Libres para/i);
  assert.equal(state.getActiveBookingsCalls, 1);
  assert.equal(state.getAvailableSlotsCalls, 1);
});

test("'turnos para mañana' trae fecha → disponibilidad aunque tenga reservas", async () => {
  resetState();
  const chatId = "test-my-turns-explicit-date";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };

  const reply = await handleIncomingMessage(chatId, "turnos para mañana");

  assert.match(reply, /Libres para/i);
  assert.doesNotMatch(reply, /reservas vigentes/i);
  assert.equal(state.getAvailableSlotsCalls, 1);
});

test("'tengo turnos' → lista las reservas del cliente", async () => {
  resetState();
  const chatId = "test-my-turns-phrase";
  sessionService.clearHistory(chatId);
  state.activeBookings = { success: true, data: [makeBooking()] };

  const reply = await handleIncomingMessage(chatId, "tengo turnos");

  assert.match(reply, /reservas vigentes/i);
  assert.match(reply, /Cancha 1/);
});
