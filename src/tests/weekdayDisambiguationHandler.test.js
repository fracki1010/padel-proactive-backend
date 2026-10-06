const test = require("node:test");
const assert = require("node:assert/strict");

const { handleIncomingMessage } = require("../handlers/messageHandler");
const sessionService = require("../services/sessionService");
const { getTodayIsoArgentina } = require("../whatsapp/domain/bookingDateTime");

const buildPendingWeekdayChoice = () => ({
  action: "CHECK_AVAILABILITY",
  todayIso: "2026-11-05",
  nextIso: "2026-11-12",
  weekdayName: "jueves",
  time: null,
  courtName: null,
});

test("con elección pendiente, una respuesta ininteligible repite la pregunta y conserva el estado", async () => {
  const chatId = "test-weekday-repeat";
  sessionService.clearHistory(chatId);
  sessionService.updateMeta(chatId, {
    lastMessageDate: getTodayIsoArgentina(),
    pendingWeekdayChoice: buildPendingWeekdayChoice(),
  });

  const reply = await handleIncomingMessage(chatId, "no te entiendo nada");

  assert.match(reply, /hoy/i);
  assert.match(reply, /jueves que viene/i);
  assert.deepEqual(sessionService.getMeta(chatId).pendingWeekdayChoice, buildPendingWeekdayChoice());
});
