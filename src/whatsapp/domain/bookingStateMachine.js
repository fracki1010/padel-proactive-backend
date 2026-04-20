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
  const m = meta || {};
  if (m.awaitingBookingClientNameConfirmation) return STATES.AWAITING_NAME_CONFIRMATION;
  if (m.awaitingFullNameForBooking) return STATES.AWAITING_NAME;
  if (m.pendingBookingOffer?.dateStr && m.pendingBookingOffer?.timeStr) {
    return STATES.AWAITING_FINAL_CONFIRMATION;
  }
  if (m.awaitingCancellationTarget) return STATES.AWAITING_CANCELLATION_TARGET;
  if (m.lastAvailabilityShownAt) return STATES.SHOWING_AVAILABILITY;
  if (m.lastFlowStatus === "completed") return STATES.COMPLETED;
  if (m.lastFlowStatus === "cancelled") return STATES.CANCELLED;
  return STATES.IDLE;
};

const transitionBookingState = ({
  currentState = STATES.IDLE,
  intent = "UNKNOWN",
  hasValidDraft = false,
  hasPersonName = false,
  hasCancellationCandidates = false,
  // hasKnownName: el sistema YA conoce el nombre del cliente (perfil o captura previa)
  // Permite confirmar sin re-pedir nombre aunque estemos en AWAITING_NAME
  hasKnownName = false,
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
    // Si no hay nombre en el mensaje actual ni nombre conocido en el sistema → pedir nombre
    if (!hasPersonName && !hasKnownName) {
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
      // En AWAITING_NAME: solo ejecutar si ya conocemos el nombre del cliente
      // Si no lo conocemos, insistir en pedirlo antes de ejecutar
      if (currentState === STATES.AWAITING_NAME && !hasPersonName && !hasKnownName) {
        return {
          nextState: STATES.AWAITING_NAME,
          nextAction: "ASK_NAME",
          reason: "confirm_needs_name",
        };
      }
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
