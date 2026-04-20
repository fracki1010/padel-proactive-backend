const STATES = {
  IDLE: "IDLE",
  AWAITING_NAME: "AWAITING_NAME",
  AWAITING_NAME_CONFIRMATION: "AWAITING_NAME_CONFIRMATION",
  AWAITING_FINAL_CONFIRMATION: "AWAITING_FINAL_CONFIRMATION",
  AWAITING_CANCELLATION_TARGET: "AWAITING_CANCELLATION_TARGET",
  SHOWING_AVAILABILITY: "SHOWING_AVAILABILITY",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

const deriveStateFromMeta = (meta = {}) => {
  if (meta.awaitingBookingClientNameConfirmation) return STATES.AWAITING_NAME_CONFIRMATION;
  if (meta.awaitingFullNameForBooking) return STATES.AWAITING_NAME;
  if (meta.pendingBookingOffer?.dateStr && meta.pendingBookingOffer?.timeStr) {
    return STATES.AWAITING_FINAL_CONFIRMATION;
  }
  if (meta.awaitingCancellationTarget) return STATES.AWAITING_CANCELLATION_TARGET;
  if (meta.lastAvailabilityShownAt) return STATES.SHOWING_AVAILABILITY;
  if (meta.lastFlowStatus === "completed") return STATES.COMPLETED;
  if (meta.lastFlowStatus === "cancelled") return STATES.CANCELLED;
  return STATES.IDLE;
};

const transitionBookingState = ({
  currentState = STATES.IDLE,
  intent = "UNKNOWN",
  hasValidDraft = false,
  hasPersonName = false,
  hasCancellationCandidates = false,
} = {}) => {
  if (intent === "RESTART") {
    return { nextState: STATES.IDLE, nextAction: "RESET_FLOW", reason: "global_restart" };
  }

  if (intent === "CANCEL_BOOKING") {
    if (hasValidDraft) {
      return {
        nextState: STATES.CANCELLED,
        nextAction: "CANCEL_DRAFT_OR_BOOKING",
        reason: "global_cancel",
      };
    }
    return {
      nextState: hasCancellationCandidates ? STATES.AWAITING_CANCELLATION_TARGET : STATES.IDLE,
      nextAction: "START_CANCELLATION",
      reason: "global_cancel",
    };
  }

  if (intent === "CHECK_AVAILABILITY") {
    return {
      nextState: STATES.SHOWING_AVAILABILITY,
      nextAction: "SHOW_AVAILABILITY",
      reason: "availability_intent",
    };
  }

  if (intent === "CREATE_BOOKING") {
    if (!hasPersonName) {
      return {
        nextState: STATES.AWAITING_NAME,
        nextAction: "ASK_NAME",
        reason: "missing_name",
      };
    }
    if (hasValidDraft) {
      return {
        nextState: STATES.AWAITING_FINAL_CONFIRMATION,
        nextAction: "ASK_FINAL_CONFIRMATION",
        reason: "draft_ready",
      };
    }
    return {
      nextState: STATES.AWAITING_FINAL_CONFIRMATION,
      nextAction: "BUILD_DRAFT_AND_CONFIRM",
      reason: "booking_intent",
    };
  }

  if (intent === "PROVIDE_NAME") {
    return hasPersonName
      ? {
          nextState: STATES.AWAITING_NAME_CONFIRMATION,
          nextAction: "ASK_NAME_CONFIRMATION",
          reason: "name_detected",
        }
      : {
          nextState: STATES.AWAITING_NAME,
          nextAction: "ASK_NAME",
          reason: "invalid_name",
        };
  }

  if (intent === "CONFIRM") {
    if (hasValidDraft) {
      return {
        nextState: STATES.COMPLETED,
        nextAction: "EXECUTE_DRAFT",
        reason: "confirm_with_draft",
      };
    }
    return {
      nextState: currentState,
      nextAction: "EXPLAIN_MISSING_DRAFT",
      reason: "confirm_without_draft",
    };
  }

  if (intent === "REJECT") {
    if (hasValidDraft) {
      return {
        nextState: STATES.CANCELLED,
        nextAction: "DISCARD_DRAFT",
        reason: "reject_draft",
      };
    }
    return {
      nextState: currentState,
      nextAction: "NOOP",
      reason: "reject_without_draft",
    };
  }

  return {
    nextState: currentState,
    nextAction: "INTERPRET_CONTINUE",
    reason: "default",
  };
};

module.exports = {
  STATES,
  deriveStateFromMeta,
  transitionBookingState,
};
