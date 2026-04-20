const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STATES,
  deriveStateFromMeta,
  transitionBookingState,
} = require("../whatsapp/domain/bookingStateMachine");

test("deriveStateFromMeta mapea pending offer a AWAITING_FINAL_CONFIRMATION", () => {
  const state = deriveStateFromMeta({
    pendingBookingOffer: { dateStr: "2026-04-20", timeStr: "20:00" },
  });
  assert.equal(state, STATES.AWAITING_FINAL_CONFIRMATION);
});

test("CONFIRM con draft válido ejecuta", () => {
  const result = transitionBookingState({
    currentState: STATES.AWAITING_FINAL_CONFIRMATION,
    intent: "CONFIRM",
    hasValidDraft: true,
    hasPersonName: true,
  });

  assert.equal(result.nextState, STATES.COMPLETED);
  assert.equal(result.nextAction, "EXECUTE_DRAFT");
});

test("CANCEL_BOOKING global disponible siempre", () => {
  const result = transitionBookingState({
    currentState: STATES.AWAITING_NAME,
    intent: "CANCEL_BOOKING",
    hasValidDraft: false,
    hasCancellationCandidates: true,
  });

  assert.equal(result.nextState, STATES.AWAITING_CANCELLATION_TARGET);
  assert.equal(result.nextAction, "START_CANCELLATION");
});

test("CREATE_BOOKING sin nombre pide nombre", () => {
  const result = transitionBookingState({
    currentState: STATES.IDLE,
    intent: "CREATE_BOOKING",
    hasValidDraft: false,
    hasPersonName: false,
  });

  assert.equal(result.nextState, STATES.AWAITING_NAME);
  assert.equal(result.nextAction, "ASK_NAME");
});
