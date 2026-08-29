import { caseId, initialEvents } from "./demoData.js";

function emptyCredential(role) {
  return {
    id: `${role.toUpperCase()} · NOT ISSUED`,
    value: null,
    status: "NOT_ISSUED",
    usedAt: null,
    available: false,
  };
}

export const initialDemoState = {
  caseId,
  source: "offline_fixture",
  authoritative: false,
  state: "CLARIFICATION_REQUIRED",
  version: 5,
  claimAnswer: "",
  answerAttempts: 0,
  claimAcceptedAt: null,
  identity: null,
  approval: null,
  reservation: null,
  claimantToken: emptyCredential("claimant"),
  custodianToken: emptyCredential("custodian"),
  callback: { status: "WAITING", replayHandled: false },
  tokenReplayRejected: false,
  handoff: null,
  manifest: null,
  authoritativeCase: null,
  claimantCase: null,
  events: initialEvents,
  lastNotice: "Offline fixture only. Connect the custody service to verify private evidence or change custody state.",
};

export function demoReducer(state, action) {
  switch (action.type) {
    case "RESET":
      return initialDemoState;
    case "HYDRATE_SERVICE":
      if (!action.payload?.authoritative) return state;
      return {
        ...initialDemoState,
        ...action.payload,
        source: "service",
        authoritative: true,
        claimAnswer: "",
      };
    case "OFFLINE_ACTION_BLOCKED":
      return {
        ...state,
        lastNotice: "Offline fixture only. No private answer was checked and no custody state changed.",
      };
    case "CLAIMANT_LINK_UNAVAILABLE":
      return {
        ...initialDemoState,
        caseId: action.caseId || initialDemoState.caseId,
        source: "claimant_service",
        authoritative: false,
        events: [],
        claimLink: null,
        lastNotice: "The claimant proof link is missing, expired, consumed, or invalid.",
      };
    case "CLEAR_SESSION_SECRETS":
      return {
        ...state,
        claimantToken: { ...state.claimantToken, value: null, available: false },
        custodianToken: { ...state.custodianToken, value: null, available: false },
        lastNotice: "Runtime demo authorization and in-memory relay credentials were cleared from this tab.",
      };
    default:
      return state;
  }
}
