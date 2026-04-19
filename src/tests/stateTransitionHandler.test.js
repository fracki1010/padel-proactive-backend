const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveStrictStateTransition,
} = require("../utils/stateTransitionHandler");

test("FULL_NAME_CAPTURE permite cambio global a disponibilidad con reset controlado", () => {
  const result = resolveStrictStateTransition({
    state: "FULL_NAME_CAPTURE",
    isAllowedInput: false,
    globalIntentAction: "CHECK_AVAILABILITY",
  });

  assert.equal(result.decision, "RESET_AND_INTERRUPT");
  assert.equal(result.action, "CHECK_AVAILABILITY");
});

test("FULL_NAME_CAPTURE exige nombre cuando no hay intent global válido", () => {
  const result = resolveStrictStateTransition({
    state: "FULL_NAME_CAPTURE",
    isAllowedInput: false,
    globalIntentAction: "CREATE_BOOKING",
  });

  assert.equal(result.decision, "REQUIRE_STATE_INPUT");
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
