import test from "node:test";
import assert from "node:assert/strict";

import { identityReleaseGate } from "../src/staffWorkflow.js";

test("standard-risk identity attestation proceeds directly to reservation", () => {
  assert.equal(identityReleaseGate({
    state: "IDENTITY_ATTESTED",
    riskTier: "STANDARD",
    approvalRecorded: false,
  }), "RESERVE");
});

test("valuable-risk identity attestation remains supervisor gated", () => {
  assert.equal(identityReleaseGate({
    state: "IDENTITY_ATTESTED",
    riskTier: "VALUABLE",
    approvalRecorded: false,
  }), "SUPERVISOR_APPROVAL");
});
