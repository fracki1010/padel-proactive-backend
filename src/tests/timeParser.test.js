const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTime, hasInvalidTimeInput } = require("../utils/timeParser");

test("parseTime valida formato HH:mm de 00:00 a 23:59", () => {
  assert.equal(parseTime("00:00"), "00:00");
  assert.equal(parseTime("23:59"), "23:59");
  assert.equal(parseTime("8"), "08:00");
  assert.equal(parseTime("18.30"), "18:30");
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("99:99"), null);
});

test("hasInvalidTimeInput detecta hora inválida y evita fallback a disponibilidad general", () => {
  assert.equal(hasInvalidTimeInput("tenes hoy 24:00"), true);
  assert.equal(hasInvalidTimeInput("tenes hoy 18:30"), false);
});
