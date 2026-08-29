import assert from "node:assert/strict";
import test from "node:test";

import { demoReducer, initialDemoState } from "../src/demoMachine.js";

test("the offline fixture cannot invent a custody transition", () => {
  const attempted = demoReducer(initialDemoState, { type: "OFFLINE_ACTION_BLOCKED" });
  assert.equal(attempted.state, initialDemoState.state);
  assert.equal(attempted.version, initialDemoState.version);
  assert.equal(attempted.events.length, initialDemoState.events.length);
  assert.equal(attempted.authoritative, false);
  assert.match(attempted.lastNotice, /no private answer was checked/i);
});

test("an authoritative service projection replaces state, version, events, handoff, manifest, and credentials", () => {
  const projection = {
    authoritative: true,
    source: "service",
    caseId: "service-case",
    state: "CLOSED",
    version: 29,
    events: [{ id: "service-event", label: "Passport Closed" }],
    handoff: { id: "service-handoff", status: "RELEASED" },
    manifest: { manifest_id: "service-manifest", final_version: 29 },
    claimantToken: { id: "claimant", value: "service-raw-claimant", status: "USED", available: true },
    custodianToken: { id: "custodian", value: "service-raw-custodian", status: "USED", available: true },
  };
  const hydrated = demoReducer(initialDemoState, { type: "HYDRATE_SERVICE", payload: projection });
  assert.equal(hydrated.state, projection.state);
  assert.equal(hydrated.version, projection.version);
  assert.deepEqual(hydrated.events, projection.events);
  assert.deepEqual(hydrated.handoff, projection.handoff);
  assert.deepEqual(hydrated.manifest, projection.manifest);
  assert.equal(hydrated.claimantToken.value, projection.claimantToken.value);
  assert.equal(hydrated.custodianToken.value, projection.custodianToken.value);
  assert.equal(hydrated.claimAnswer, "");
  assert.equal(hydrated.authoritative, true);
});

test("a payload without the authoritative marker cannot hydrate the UI", () => {
  const state = demoReducer(initialDemoState, {
    type: "HYDRATE_SERVICE",
    payload: { state: "CLOSED", version: 999 },
  });
  assert.strictEqual(state, initialDemoState);
});

test("local action names do not advance a service projection", () => {
  const connected = demoReducer(initialDemoState, {
    type: "HYDRATE_SERVICE",
    payload: { authoritative: true, state: "APPROVAL_REQUIRED", version: 13 },
  });
  for (const type of ["APPROVE", "RESERVE", "PRESENT_TOKEN", "CONFIRM_HANDOFF", "REPLAY_CALLBACK"]) {
    assert.strictEqual(demoReducer(connected, { type }), connected);
  }
});

test("reset returns to the explicitly labeled offline fixture", () => {
  const connected = demoReducer(initialDemoState, {
    type: "HYDRATE_SERVICE",
    payload: { authoritative: true, state: "RESERVED", version: 18 },
  });
  const reset = demoReducer(connected, { type: "RESET" });
  assert.strictEqual(reset, initialDemoState);
  assert.equal(reset.source, "offline_fixture");
});

test("an invalid claimant link exposes no retained staff projection", () => {
  const connected = demoReducer(initialDemoState, {
    type: "HYDRATE_SERVICE",
    payload: {
      authoritative: true,
      caseId: "FR-staff-only",
      authoritativeCase: { current_holder: "staff-only-slot" },
      candidates: [{ remote_etag: "staff-etag" }],
    },
  });
  const unavailable = demoReducer(connected, {
    type: "CLAIMANT_LINK_UNAVAILABLE",
    caseId: "FR-claimant-link",
  });

  assert.equal(unavailable.caseId, "FR-claimant-link");
  assert.equal(unavailable.authoritativeCase, null);
  assert.deepEqual(unavailable.events, []);
  assert.equal(JSON.stringify(unavailable).includes("staff-only-slot"), false);
  assert.equal(JSON.stringify(unavailable).includes("staff-etag"), false);
});
