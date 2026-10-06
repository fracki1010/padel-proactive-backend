const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWeekdayDisambiguationQuestion,
  resolveWeekdayChoiceReply,
  resolveWeekdayChoiceDate,
} = require("../whatsapp/domain/weekdayDisambiguation");
const {
  parseBookingDateTime,
} = require("../whatsapp/domain/parseBookingDateTime");

const TZ = "America/Argentina/Buenos_Aires";
const TODAY_ISO = "2026-11-05";
const NEXT_ISO = "2026-11-12";

test("la pregunta de desambiguacion menciona hoy y el proximo jueves con sus fechas", () => {
  const question = buildWeekdayDisambiguationQuestion({
    weekdayName: "jueves",
    todayIso: TODAY_ISO,
    nextIso: NEXT_ISO,
  });
  assert.match(question, /hoy/i);
  assert.match(question, /jueves que viene/i);
  assert.match(question, /jueves 5 de noviembre/i);
  assert.match(question, /jueves 12 de noviembre/i);
});

test("respuestas de hoy se resuelven como TODAY", () => {
  for (const reply of ["hoy", "hoy mismo", "para hoy", "el de hoy"]) {
    assert.equal(resolveWeekdayChoiceReply(reply), "TODAY", `reply: ${reply}`);
  }
});

test("respuestas de proximo se resuelven como NEXT", () => {
  for (const reply of [
    "el proximo",
    "el que viene",
    "siguiente",
    "la semana que viene",
    "el proximo jueves",
  ]) {
    assert.equal(resolveWeekdayChoiceReply(reply), "NEXT", `reply: ${reply}`);
  }
});

test("respuestas ininteligibles no resuelven ninguna opcion", () => {
  assert.equal(resolveWeekdayChoiceReply("cualquiera"), null);
  assert.equal(resolveWeekdayChoiceReply(""), null);
});

test("resolver 'hoy' devuelve la fecha de hoy", () => {
  const result = resolveWeekdayChoiceDate("hoy", {
    todayIso: TODAY_ISO,
    nextIso: NEXT_ISO,
  });
  assert.deepEqual(result, { matched: true, choice: "TODAY", date: TODAY_ISO });
});

test("resolver 'el que viene' devuelve la fecha siguiente", () => {
  const result = resolveWeekdayChoiceDate("el que viene", {
    todayIso: TODAY_ISO,
    nextIso: NEXT_ISO,
  });
  assert.deepEqual(result, { matched: true, choice: "NEXT", date: NEXT_ISO });
});

test("resolver una respuesta ininteligible no devuelve fecha", () => {
  const result = resolveWeekdayChoiceDate("ni idea", {
    todayIso: TODAY_ISO,
    nextIso: NEXT_ISO,
  });
  assert.deepEqual(result, { matched: false, choice: null, date: null });
});

test("flujo: el parser marca ambiguedad y la respuesta 'hoy' resuelve a hoy", () => {
  const thursday = new Date("2026-11-05T15:00:00.000Z");
  const parsed = parseBookingDateTime("turno para el jueves", thursday, TZ);
  assert.equal(parsed.weekdayToday, true);

  const question = buildWeekdayDisambiguationQuestion({
    weekdayName: parsed.weekday,
    todayIso: "2026-11-05",
    nextIso: parsed.date,
  });
  assert.match(question, /hoy/i);

  const resolved = resolveWeekdayChoiceDate("hoy", {
    todayIso: "2026-11-05",
    nextIso: parsed.date,
  });
  assert.equal(resolved.date, "2026-11-05");
});

test("flujo: una fecha sin ambiguedad no genera pregunta", () => {
  const monday = new Date("2026-11-02T15:00:00.000Z");
  const parsed = parseBookingDateTime("turno para el jueves", monday, TZ);
  assert.equal(parsed.weekdayToday, false);
  assert.equal(parsed.date, "2026-11-05");
});
