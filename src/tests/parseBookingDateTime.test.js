const test = require("node:test");
const assert = require("node:assert/strict");

const { parseBookingDateTime } = require("../whatsapp/domain/parseBookingDateTime");

const now = new Date("2026-04-20T18:00:00.000Z");

test("parsea hoy 20:00", () => {
  const result = parseBookingDateTime("quiero reservar hoy 20:00", now, "America/Argentina/Buenos_Aires");
  assert.equal(result.date, "2026-04-20");
  assert.equal(result.time, "20:00");
});

test("parsea mañana 21", () => {
  const result = parseBookingDateTime("mañana 21", now, "America/Argentina/Buenos_Aires");
  assert.equal(result.date, "2026-04-21");
  assert.equal(result.time, "21:00");
});

test("8 de la noche => 20:00", () => {
  const result = parseBookingDateTime("hoy 8 de la noche", now, "America/Argentina/Buenos_Aires");
  assert.equal(result.time, "20:00");
});

test("si no hay 8, dame 9 -> prioriza noche en contexto de reserva", () => {
  const result = parseBookingDateTime("si no hay 8, dame 9 para reservar", now, "America/Argentina/Buenos_Aires");
  assert.equal(result.time, "21:00");
});

test("invalid time 99:99", () => {
  const result = parseBookingDateTime("quiero hoy 99:99", now, "America/Argentina/Buenos_Aires");
  assert.equal(result.invalidTime, true);
});
