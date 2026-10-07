const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseAttendanceAnswer,
  looksLikeAttendanceAnswer,
  isRecentAttendancePrompt,
  ATTENDANCE_FALLBACK_WINDOW_MS,
} = require("../whatsapp/domain/attendanceAnswer");

test("parseAttendanceAnswer reconoce variantes afirmativas reales", () => {
  const accepted = [
    "1",
    "1)",
    "SI ASISTO",
    "si asisto",
    "sí, asisto",
    "si voy",
    "si, voy",
    "si voy a ir",
    "si voy a asistir",
    "si quiero ir",
    "si quiero asistir",
    "si asistiré",
    "voy",
    "voy a ir",
    "voy a asistir",
    "quiero ir",
    "quiero asistir",
    "asisto",
    "confirmo",
    "confirmo asistencia",
    "sí",
    "¡SI!",
  ];

  for (const text of accepted) {
    assert.equal(parseAttendanceAnswer(text), "YES", `Debe aceptar como YES: ${text}`);
  }
});

test("parseAttendanceAnswer reconoce variantes negativas reales", () => {
  const accepted = [
    "2",
    "2)",
    "NO ASISTO",
    "no asisto",
    "no, no voy",
    "no voy",
    "no voy a ir",
    "no puedo",
    "no puedo ir",
    "no quiero ir",
    "no quiero asistir",
    "no asistiré",
    "baja",
    "NO",
    "n",
  ];

  for (const text of accepted) {
    assert.equal(parseAttendanceAnswer(text), "NO", `Debe aceptar como NO: ${text}`);
  }
});

test("parseAttendanceAnswer devuelve null ante mensajes que no son respuestas de asistencia", () => {
  const rejected = [
    "",
    "   ",
    "hola",
    "buenas tardes",
    "no entendí",
    "no sé",
    "si mañana",
    "quiero reservar hoy 20",
    "mi reserva",
    "que horarios hay",
    "tal vez",
  ];

  for (const text of rejected) {
    assert.equal(parseAttendanceAnswer(text), null, `No debe clasificar: ${text}`);
  }
});

test("looksLikeAttendanceAnswer detecta frases de asistencia aunque el parser estricto no las resuelva", () => {
  for (const text of ["si asisto", "no puedo ir", "quiero asistir mañana", "confirmo asistencia", "voy a ir"]) {
    assert.equal(looksLikeAttendanceAnswer(text), true, `Debe parecer asistencia: ${text}`);
  }

  for (const text of ["quiero reservar hoy 20", "mi reserva", "hola", ""]) {
    assert.equal(looksLikeAttendanceAnswer(text), false, `No debe parecer asistencia: ${text}`);
  }
});

test("isRecentAttendancePrompt acepta recordatorios dentro de la ventana y rechaza viejos/ausentes", () => {
  const now = Date.now();
  const recent = new Date(now - 30 * 60 * 1000);
  const old = new Date(now - (ATTENDANCE_FALLBACK_WINDOW_MS + 60 * 1000));

  assert.equal(isRecentAttendancePrompt(recent, now), true);
  assert.equal(isRecentAttendancePrompt(old, now), false);
  assert.equal(isRecentAttendancePrompt(null, now), false);
  assert.equal(isRecentAttendancePrompt("not-a-date", now), false);
});
