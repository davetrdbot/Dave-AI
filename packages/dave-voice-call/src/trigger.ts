/**
 * Update 6 trigger conditions, verbatim from the master plan: "user
 * unresponsive on Telegram for configurable duration AND Dave has
 * something to tell them, OR Dave has an urgent question and isn't
 * getting a Telegram response." Pure logic, real and fully testable --
 * no network/timer dependency here, just the decision itself.
 */
export interface CallTriggerState {
  lastUserTelegramActivityAt: number;
  now: number;
  unresponsiveMinutes: number;
  daveHasSomethingToTell: boolean;
  daveHasUrgentUnansweredQuestion: boolean;
}

export interface CallTriggerDecision {
  shouldCall: boolean;
  reason: "unresponsive_with_news" | "urgent_unanswered_question" | "none";
  minutesSinceLastActivity: number;
}

export function evaluateCallTrigger(state: CallTriggerState): CallTriggerDecision {
  const minutesSinceLastActivity = (state.now - state.lastUserTelegramActivityAt) / 60000;
  const isUnresponsive = minutesSinceLastActivity >= state.unresponsiveMinutes;

  if (isUnresponsive && state.daveHasSomethingToTell) {
    return { shouldCall: true, reason: "unresponsive_with_news", minutesSinceLastActivity };
  }
  if (state.daveHasUrgentUnansweredQuestion && isUnresponsive) {
    return { shouldCall: true, reason: "urgent_unanswered_question", minutesSinceLastActivity };
  }
  return { shouldCall: false, reason: "none", minutesSinceLastActivity };
}
