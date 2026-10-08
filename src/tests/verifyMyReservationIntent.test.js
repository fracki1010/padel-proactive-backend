const test = require("node:test");
const assert = require("node:assert/strict");

const { detectIntent, INTENTS } = require("../whatsapp/domain/messageInterpreter");
const {
  findActiveBookingForRequestedSlot,
  buildExistingBookingStatusReply,
} = require("../whatsapp/domain/bookingSlotMatch");

// ============================================================
// Part 2.1 — El matcher de LIST_ACTIVE_BOOKINGS debe cubrir
// "mi reserva" / "mi turno" / frases de verificación (normalizadas).
// ============================================================
test("detecta frases de verificación de la propia reserva como LIST_ACTIVE_BOOKINGS", () => {
  const accepted = [
    "mi reserva",
    "mi turno",
    "quiero saber si mi reserva está confirmada",
    "quiero saber si mi reserva esta confirmada",
    "esta confirmada mi reserva",
    "esta confirmado mi turno",
    "mi reserva esta confirmada",
    "mi turno esta confirmado",
    "saber si tengo reserva",
    "saber si tengo turno",
    "verificar mi reserva",
    "verificar mi turno",
    "confirmada mi reserva",
    "confirmado mi turno",
    "quiero saber si tengo una reserva",
    "quiero saber si tengo turno",
    "como está mi reserva",
    "estado de mi reserva",
    "tengo una reserva",
    "quiero ver mi reserva",
    "sigue en pie mi reserva",
  ];
  for (const text of accepted) {
    assert.equal(
      detectIntent(text),
      INTENTS.LIST_ACTIVE_BOOKINGS,
      `Debe detectar como reservas propias: ${text}`,
    );
  }
});

test("no roba a CREATE_BOOKING las frases con verbo reservar", () => {
  assert.equal(detectIntent("quiero reservar hoy a las 20:00"), INTENTS.CREATE_BOOKING);
  assert.equal(detectIntent("quiero reservar"), INTENTS.CREATE_BOOKING);
  assert.equal(detectIntent("quiero reservar el 6/10 a las 18:30"), INTENTS.CREATE_BOOKING);
  assert.equal(detectIntent("anotame"), INTENTS.CREATE_BOOKING);
  assert.equal(detectIntent("haceme la reserva mañana"), INTENTS.CREATE_BOOKING);
});

test("no roba a CHECK_AVAILABILITY / CANCEL_BOOKING / CONFIRM sus frases", () => {
  assert.equal(detectIntent("disponibilidad"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("turnos disponibles"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("hay lugar mañana"), INTENTS.CHECK_AVAILABILITY);
  assert.equal(detectIntent("cancelar mi reserva"), INTENTS.CANCEL_BOOKING);
  assert.equal(detectIntent("confirmar reserva"), INTENTS.CONFIRM);
});

// ============================================================
// Part 2.3 — helpers puros de coincidencia de slot.
// ============================================================
const individualBooking = {
  type: "individual",
  date: "2026-10-06",
  startTime: "18:00",
  endTime: "19:00",
  courtName: "Cancha 1",
  status: "confirmado",
};

test("findActiveBookingForRequestedSlot: misma fecha + startTime exacto", () => {
  const exact = { ...individualBooking, startTime: "18:30", endTime: "19:30" };
  const match = findActiveBookingForRequestedSlot({
    activeBookings: [exact],
    date: "2026-10-06",
    time: "18:30",
  });
  assert.equal(match, exact);
});

test("findActiveBookingForRequestedSlot: hora dentro del rango del slot", () => {
  const match = findActiveBookingForRequestedSlot({
    activeBookings: [individualBooking],
    date: "2026-10-06",
    time: "18:30",
  });
  assert.equal(match, individualBooking);
});

test("findActiveBookingForRequestedSlot: no empareja fecha u hora distinta", () => {
  const resultWrongDate = findActiveBookingForRequestedSlot({
    activeBookings: [individualBooking],
    date: "2026-10-07",
    time: "18:30",
  });
  assert.equal(resultWrongDate, null);
  const resultWrongTime = findActiveBookingForRequestedSlot({
    activeBookings: [individualBooking],
    date: "2026-10-06",
    time: "20:00",
  });
  assert.equal(resultWrongTime, null);
});

test("findActiveBookingForRequestedSlot: empareja turno fijo por día de semana", () => {
  const fixed = {
    type: "fixed",
    dayOfWeek: 2, // 2026-10-06 es martes
    startTime: "18:00",
    endTime: "19:00",
    courtName: "Cancha 2",
    status: "confirmado",
  };
  const matched = findActiveBookingForRequestedSlot({
    activeBookings: [fixed],
    date: "2026-10-06",
    time: "18:30",
  });
  assert.equal(matched, fixed);
  const notMatched = findActiveBookingForRequestedSlot({
    activeBookings: [fixed],
    date: "2026-10-07", // miércoles
    time: "18:30",
  });
  assert.equal(notMatched, null);
});

test("buildExistingBookingStatusReply: fecha legible, cancha, hora y estado", () => {
  const reply = buildExistingBookingStatusReply(individualBooking);
  assert.match(reply, /Ya tenés una reserva/);
  assert.match(reply, /6 de octubre/i);
  assert.match(reply, /18:00 - 19:00/);
  assert.match(reply, /Cancha 1/);
  assert.match(reply, /Confirmada/);
});

test("buildExistingBookingStatusReply: estado reservado + pago pendiente", () => {
  const reply = buildExistingBookingStatusReply({
    ...individualBooking,
    status: "reservado",
    paymentStatus: "pendiente",
  });
  assert.match(reply, /pendiente/i);
  assert.doesNotMatch(reply, /Estado: Confirmada/);
});

test("buildExistingBookingStatusReply: hold pendiente_seña renders the unpaid seña state", () => {
  const reply = buildExistingBookingStatusReply({
    ...individualBooking,
    status: "pendiente_seña",
    paymentStatus: "pendiente",
  });
  assert.match(reply, /Pendiente de seña/i);
  assert.doesNotMatch(reply, /Estado: Confirmada/);
});

test("buildExistingBookingStatusReply: turno fijo muestra el día recurrente", () => {
  const reply = buildExistingBookingStatusReply({
    type: "fixed",
    dayOfWeek: 2,
    startTime: "18:00",
    endTime: "19:00",
    courtName: "Cancha 2",
    status: "confirmado",
  });
  assert.match(reply, /Todos los Martes/);
  assert.match(reply, /Cancha 2/);
});