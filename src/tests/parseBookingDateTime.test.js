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

const tz = "America/Argentina/Buenos_Aires";
// Lunes 2026-11-02 12:00 ART
const monday = new Date("2026-11-02T15:00:00.000Z");
// Jueves 2026-11-05 12:00 ART
const thursday = new Date("2026-11-05T15:00:00.000Z");

test("jueves pedido un lunes resuelve al jueves de esa semana y no marca ambigüedad", () => {
  const result = parseBookingDateTime("turno para el jueves", monday, tz);
  assert.equal(result.date, "2026-11-05");
  assert.equal(result.weekday, "jueves");
  assert.equal(result.weekdayToday, false);
});

test("jueves pedido un jueves resuelve al proximo jueves y marca ambigüedad", () => {
  const result = parseBookingDateTime("turno para el jueves", thursday, tz);
  assert.equal(result.date, "2026-11-12");
  assert.equal(result.weekday, "jueves");
  assert.equal(result.weekdayToday, true);
});

test("viernes pedido un jueves resuelve al viernes siguiente y no marca ambigüedad", () => {
  const result = parseBookingDateTime("turno para el viernes", thursday, tz);
  assert.equal(result.date, "2026-11-06");
  assert.equal(result.weekdayToday, false);
});

test("una fecha relativa explicita (hoy) nunca marca ambigüedad de dia de semana", () => {
  const result = parseBookingDateTime("quiero reservar hoy 20:00", thursday, tz);
  assert.equal(result.relativeDate, "HOY");
  assert.equal(result.weekdayToday, false);
});
