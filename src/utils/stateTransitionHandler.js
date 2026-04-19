const resolveStrictStateTransition = ({
  state = null,
  isAllowedInput = true,
  globalIntentAction = "",
} = {}) => {
  if (!state) {
    return { decision: "ALLOW" };
  }

  if (isAllowedInput) {
    return { decision: "ALLOW" };
  }

  const action = String(globalIntentAction || "").trim();
  if (action === "RESET_FLOW") {
    return { decision: "RESET_FLOW" };
  }

  const canInterruptWithGlobalIntent =
    action === "CANCEL_BOOKING" || action === "CHECK_AVAILABILITY";

  if (state === "FULL_NAME_CAPTURE") {
    if (canInterruptWithGlobalIntent) {
      return { decision: "RESET_AND_INTERRUPT", action };
    }
    return { decision: "REQUIRE_STATE_INPUT" };
  }

  if (state === "OFFER_CONFIRMATION") {
    if (canInterruptWithGlobalIntent) {
      return { decision: "RESET_AND_INTERRUPT", action };
    }
    return { decision: "REQUIRE_STATE_INPUT" };
  }

  return { decision: "REQUIRE_STATE_INPUT" };
};

module.exports = {
  resolveStrictStateTransition,
};
