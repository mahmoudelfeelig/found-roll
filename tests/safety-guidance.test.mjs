import assert from "node:assert/strict";
import test from "node:test";

import { localSafetyGuidance } from "../src/safetyGuidance.js";

test("sensitive categories produce tenant-specific no-upload guidance", () => {
  const categories = ["suspicious_package", "passport", "payment_card", "access_badge", "medication"];
  for (const category of categories) {
    const guidance = localSafetyGuidance(category, "metro-loop");
    assert.equal(guidance.uploadAllowed, false);
    assert.equal(guidance.modelAllowed, false);
    assert.ok(guidance.action.length >= 30);
    assert.ok(guidance.retention.length >= 30);
  }
  assert.match(localSafetyGuidance("payment_card", "metro-loop").action, /Metro Loop/);
  assert.match(localSafetyGuidance("payment_card", "metro-loop").retention, /PAN/);
});
