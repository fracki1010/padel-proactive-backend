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

  const globalAlwaysActions = new Set([
    "CANCEL_BOOKING",
    "CHECK_AVAILABILITY",
    "LIST_ACTIVE_BOOKINGS",
    "CREATE_BOOKING",
    "TALK_TO_ADMIN",
  ]);

  if (state !== "ATTENDANCE_CONFIRMATION" && globalAlwaysActions.has(action)) {
    return { decision: "RESET_AND_INTERRUPT", action };
  }

  const canInterruptWithGlobalIntent =
    action === "CANCEL_BOOKING" ||
    action === "CHECK_AVAILABILITY" ||
    action === "LIST_ACTIVE_BOOKINGS" ||
    action === "CREATE_BOOKING";

  if (state === "FULL_NAME_CAPTURE") {
    if (canInterruptWithGlobalIntent) {
      return { decision: "RESET_AND_INTERRUPT", action };
    }
    return { decision: "ALLOW_INTERPRET" };
  }

  if (state === "OFFER_CONFIRMATION") {
    if (canInterruptWithGlobalIntent) {
      return { decision: "RESET_AND_INTERRUPT", action };
    }
    return { decision: "ALLOW_INTERPRET" };
  }

  return { decision: "REQUIRE_STATE_INPUT" };
};

module.exports = {
  resolveStrictStateTransition,
};
