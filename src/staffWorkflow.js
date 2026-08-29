export function identityReleaseGate({ state, riskTier, approvalRecorded }) {
  if (state === "IDENTITY_ATTESTED" && riskTier === "STANDARD") return "RESERVE";
  if (["IDENTITY_ATTESTED", "APPROVAL_REQUIRED"].includes(state) && !approvalRecorded) {
    return "SUPERVISOR_APPROVAL";
  }
  if (["APPROVAL_REQUIRED", "RESERVE_REQUESTED"].includes(state) && approvalRecorded) {
    return "RESERVE";
  }
  return null;
}
