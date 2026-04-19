const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveStrictStateTransition } = require("../utils/stateTransitionHandler");

test("FULL_NAME_CAPTURE permite cambio global a disponibilidad con reset controlado", () => {
  const result = resolveStrictStateTransition({
    state: "FULL_NAME_CAPTURE",
    isAllowedInput: false,
    globalIntentAction: "CHECK_AVAILABILITY",
  });

  assert.equal(result.decision, "RESET_AND_INTERRUPT");
  assert.equal(result.action, "CHECK_AVAILABILITY");
});

test("FULL_NAME_CAPTURE interpreta input no estricto sin bloquear", () => {
  const result = resolveStrictStateTransition({
    state: "FULL_NAME_CAPTURE",
    isAllowedInput: false,
    globalIntentAction: "",
  });

  assert.equal(result.decision, "ALLOW_INTERPRET");
});

test("OFFER_CONFIRMATION permite CANCELAR con reset controlado", () => {
  const result = resolveStrictStateTransition({
    state: "OFFER_CONFIRMATION",
    isAllowedInput: false,
    globalIntentAction: "CANCEL_BOOKING",
  });

  assert.equal(result.decision, "RESET_AND_INTERRUPT");
  assert.equal(result.action, "CANCEL_BOOKING");
});
