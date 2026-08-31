import assert from "node:assert/strict";
import test from "node:test";

import {
  configureRuntimeSession,
  projectClaimantCase,
  projectCustodySnapshot,
  recoverConnectedActionFailure,
  ServiceDemoClient,
} from "../src/serviceDemoClient.js";

function authoritativeSnapshot() {
  return {
    case: {
      id: "FR-service",
      state: "RESERVED",
      version: 19,
      wrong_answer_count: 2,
      accepted_claim_evidence: true,
      identity_attested: true,
      approval_recorded: true,
      current_holder: "Northport Air",
      updated_at: "2026-08-29T10:20:00Z",
    },
    events: [{
      id: "event-19",
      sequence: 19,
      type: "ONE_TIME_CREDENTIALS_ISSUED",
      reason: "The service issued two short-lived credentials.",
      actor: "service:token-vault",
      occurred_at: "2026-08-29T10:20:00Z",
      event_hash: "hash-19",
    }],
    handoff: {
      id: "handoff-12345678",
      reservation_id: "reservation-service",
      item_id: "NA-PCH-231",
      provider: "Relay Post (SIMULATED)",
      status: "HELD",
      expires_at: "2026-08-29T10:30:00Z",
      remote_etag: "etag-service",
      remote_version: 4,
      claimant_attested: false,
      custodian_attested: true,
      tokens_issued: true,
      simulated: true,
    },
    candidates: [{ id: "NA-PCH-231" }],
    execution: { analyst_mode: "fixture" },
  };
}

test("structured custody errors preserve code and status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: "stale_case_version", message: "The case moved." } }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
  try {
    const client = new ServiceDemoClient("https://custody.example");
    await assert.rejects(
      client.request("/api/v1/passports/example"),
      (error) => error.code === "stale_case_version" && error.status === 409,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the projection copies authoritative case, event, handoff, and manifest fields", () => {
  const snapshot = authoritativeSnapshot();
  const manifest = { manifest_id: "manifest-service", final_version: 29, event_count: 29 };
  const intakeEvidence = { id: "evd-preview", src: "blob:staff-preview" };
  const projected = projectCustodySnapshot(snapshot, { manifest, intakeEvidence });
  assert.equal(projected.authoritative, true);
  assert.equal(projected.state, snapshot.case.state);
  assert.equal(projected.version, snapshot.case.version);
  assert.deepEqual(projected.authoritativeCase, snapshot.case);
  assert.deepEqual(projected.handoff, snapshot.handoff);
  assert.deepEqual(projected.manifest, manifest);
  assert.deepEqual(projected.intakeEvidence, intakeEvidence);
  assert.equal(projected.events[0].id, snapshot.events[0].id);
  assert.equal(projected.events[0].event_hash, snapshot.events[0].event_hash);
  assert.equal(projected.events[0].detail, snapshot.events[0].reason);
  assert.equal(projected.reservation.remoteEtag, snapshot.handoff.remote_etag);
});

test("raw token values appear only when supplied from the service issuance session", () => {
  const snapshot = authoritativeSnapshot();
  const afterReload = projectCustodySnapshot(snapshot);
  assert.equal(afterReload.claimantToken.status, "ISSUED");
  assert.equal(afterReload.custodianToken.status, "USED");
  assert.equal(afterReload.claimantToken.value, null);
  assert.equal(afterReload.custodianToken.value, null);

  const issued = projectCustodySnapshot(snapshot, {
    tokens: { claimant: "raw-from-service-claimant", custodian: "raw-from-service-custodian" },
  });
  assert.equal(issued.claimantToken.value, "raw-from-service-claimant");
  assert.equal(issued.custodianToken.value, "raw-from-service-custodian");
});

test("the claimant projection contains only the purpose-built link view", () => {
  const safeCase = {
    id: "FR-claimant-safe",
    state: "CLARIFICATION_REQUIRED",
    version: 5,
    public_description: "Small black camera pouch.",
    found_date_label: "Aug 29, 2026",
    route_label: "3 participating custodians checked",
    synthetic_custodian_label: "Participating custodian (SIMULATED)",
    next_question: "What color is the repaired inner seam?",
    attempt_count: 1,
    link: { active: true, issued_case_version: 5, expires_at: "2026-08-29T10:20:00Z" },
  };
  const projected = projectClaimantCase(safeCase, {
    claimLink: { token: "frcl_tab-memory-only", expiresAt: "2026-08-29T10:20:00Z", issuedCaseVersion: 5 },
  });

  assert.deepEqual(projected.claimantCase, safeCase);
  assert.equal(projected.authoritativeCase, null);
  assert.deepEqual(projected.candidates, []);
  assert.deepEqual(projected.events, []);
  assert.equal(projected.claimLink.value, "frcl_tab-memory-only");
  assert.equal(JSON.stringify(projected).includes("current_holder"), false);
  assert.equal(JSON.stringify(projected).includes("remote_etag"), false);
});

test("claimant bootstrap uses only the scoped link endpoint and no staff credential", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setCaseId("FR-claimant-safe");
  client.setClaimLinkToken("frcl_scoped-tab-token-123456789012345678901234567890");
  const calls = [];
  client.request = async (path, options) => {
    calls.push({ path, options });
    return {
      case_id: "FR-claimant-safe",
      issued_case_version: 5,
      expires_at: "2026-08-29T10:20:00Z",
      active: true,
      case: {
        id: "FR-claimant-safe",
        state: "CLARIFICATION_REQUIRED",
        version: 5,
        public_description: "Small black camera pouch.",
        found_date_label: "Aug 29, 2026",
        route_label: "3 participating custodians checked",
        synthetic_custodian_label: "Participating custodian (SIMULATED)",
        next_question: "What color is the repaired inner seam?",
        attempt_count: 0,
        link: { active: true, issued_case_version: 5, expires_at: "2026-08-29T10:20:00Z" },
      },
    };
  };

  const projection = await client.loadClaimantProjection();

  assert.equal(calls[0].path, "/api/v1/passports/FR-claimant-safe/claim-link");
  assert.equal(calls[0].options.headers["X-Found-Roll-Claim-Link"], "frcl_scoped-tab-token-123456789012345678901234567890");
  assert.equal(calls[0].options.headers["X-Found-Roll-Staff-Token"], undefined);
  assert.equal(projection.claimantCase.id, "FR-claimant-safe");
  assert.equal(projection.authoritativeCase, null);
});

test("staff snapshots attach only the distinct staff read credential", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setDemoToken("operator-must-not-authorize-reads");
  client.setStaffToken("staff-read-runtime-token");
  let captured;
  client.request = async (path, options) => {
    captured = { path, options };
    return authoritativeSnapshot();
  };

  await client.snapshot();

  assert.equal(captured.options.headers["X-Found-Roll-Staff-Token"], "staff-read-runtime-token");
  assert.equal(captured.options.headers["X-Found-Roll-Demo-Token"], undefined);
});

test("a connected analysis action resolves to a fresh authoritative projection without browser reset authority", async () => {
  const client = new ServiceDemoClient();
  const calls = [];
  client.case = { state: "RECEIVED", version: 1 };
  client.beginAnalysis = async () => {
    calls.push("begin-analysis");
    client.case = { state: "CLARIFICATION_REQUIRED", version: 5 };
  };
  client.loadProjection = async () => {
    calls.push("projection");
    return { authoritative: true, state: client.case.state, version: client.case.version };
  };

  const projected = await client.perform({ type: "ANALYZE" });
  assert.deepEqual(calls, ["begin-analysis", "projection"]);
  assert.deepEqual(projected, { authoritative: true, state: "CLARIFICATION_REQUIRED", version: 5 });
});

test("a queued Cloud Tasks receipt polls without requiring an inline payload", async () => {
  const client = new ServiceDemoClient();
  const calls = [];
  client.waitForState = async (expectedState) => {
    calls.push(expectedState);
    return { case: { state: expectedState, version: 8 } };
  };

  const completed = await client.completeTask({
    task: {
      mode: "cloud_tasks",
      queued: true,
      task_name: "projects/demo/locations/us-central1/queues/found-roll/tasks/analyze-8",
      idempotent_replay: false,
    },
  }, "CLARIFICATION_REQUIRED");

  assert.deepEqual(calls, ["CLARIFICATION_REQUIRED"]);
  assert.equal(completed.case.state, "CLARIFICATION_REQUIRED");
});

test("the replay control queues a bounded duplicate delivery instead of reusing an inline-only receipt", async () => {
  const client = new ServiceDemoClient("https://custody.example.test");
  client.caseId = "FR-20260829-0042";
  client.demoToken = "demo-role-token";
  client.staffToken = "staff-role-token";
  client.releaseOutbox = { id: "out-release-001" };
  const calls = [];
  client.request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/release-task-replays")) {
      return {
        baseline_replay_count: 0,
        task: {
          mode: "inline",
          queued: false,
          task_name: "fr-replay-inline-001",
          payload: { case_id: client.caseId, outbox_id: client.releaseOutbox.id },
        },
      };
    }
    return { replayed: true, outbox: { id: client.releaseOutbox.id, replay_count: 1 } };
  };

  const replayed = await client.replayReleaseTask();

  assert.equal(replayed.replayed, true);
  assert.equal(calls[0].path, `/api/v1/passports/${client.caseId}/release-task-replays`);
  assert.equal(calls[0].options.headers["X-Found-Roll-Demo-Token"], "demo-role-token");
  assert.equal(calls[0].options.headers["X-Found-Roll-Staff-Token"], "staff-role-token");
  assert.equal(calls[1].path, "/tasks/outbox");
  assert.equal(calls[1].options.headers["X-CloudTasks-TaskName"], "fr-replay-inline-001");
});

test("a cloud replay receipt waits for an observed duplicate task delivery without a browser payload", async () => {
  const client = new ServiceDemoClient("https://custody.example.test");
  client.caseId = "FR-20260829-0042";
  client.demoToken = "demo-role-token";
  client.staffToken = "staff-role-token";
  client.releaseOutbox = { id: "out-release-cloud-001" };
  client.request = async () => ({
    baseline_replay_count: 2,
    task: {
      mode: "cloud_tasks",
      queued: true,
      task_name: "projects/p/locations/l/queues/q/tasks/fr-replay-cloud-001",
    },
  });
  client.snapshot = async () => ({
    case: { id: client.caseId, state: "CLOSED" },
    outbox: [{ id: client.releaseOutbox.id, replay_count: 3 }],
  });

  const replayed = await client.replayReleaseTask();

  assert.equal(replayed.replayed, true);
  assert.equal(replayed.outbox.replay_count, 3);
  assert.equal(replayed.task.mode, "cloud_tasks");
});

test("inline work still requires an opaque payload and unsupported task modes fail closed", async () => {
  const client = new ServiceDemoClient();

  await assert.rejects(
    client.completeTask({ task: { mode: "inline" } }, "RESERVED"),
    /opaque task payload/,
  );
  await assert.rejects(
    client.completeTask({ task: { mode: "unexpected", queued: true, task_name: "task-1" } }, "RESERVED"),
    /Unsupported custody task mode/,
  );
});

test("a consumed one-time credential must be rejected before the projection marks replay evidence", async () => {
  const client = new ServiceDemoClient();
  client.case = { state: "CLAIMANT_PRESENT", version: 20 };
  client.handoff = { id: "handoff-service", claimant_attested: true };
  client.tokens = { claimant: "raw-from-service" };
  client.presentToken = async () => {
    const error = new Error("already consumed");
    error.status = 409;
    throw error;
  };
  client.loadProjection = async () => ({ authoritative: true, tokenReplayRejected: client.tokenReplayRejected });

  const result = await client.perform({ type: "PRESENT_TOKEN", role: "claimant" });
  assert.equal(result.tokenReplayRejected, true);
});

test("the operator demo credential is opt-in, mutation-only, and held in memory", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new ServiceDemoClient("https://custody.example");
    await client.request("/api/v1/healthz");
    assert.equal(client.setDemoToken(" runtime-only "), true);
    await client.post("/api/v1/passports/case/reservations", { approved: true });
    assert.equal(requests[0].options.headers["X-Found-Roll-Demo-Token"], undefined);
    assert.equal(requests[1].options.headers["X-Found-Roll-Demo-Token"], "runtime-only");
    assert.equal(requests[1].options.headers["X-Found-Roll-Admin-Token"], undefined);
    assert.equal(client.setDemoToken(""), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime credential verification sends all three roles in one strict read-only probe", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setDemoToken("operator-runtime-token");
  client.setStaffToken("staff-runtime-token");
  client.setSupervisorToken("supervisor-runtime-token");
  let captured;
  client.request = async (path, options) => {
    captured = { path, options };
    return {
      authenticated: true,
      staff_actor_id: "staff.configured",
      supervisor_actor_id: "supervisor.configured",
    };
  };

  const roles = await client.verifyRuntimeCredentials();

  assert.equal(captured.path, "/api/v1/auth/runtime-roles");
  assert.equal(captured.options.method, "GET");
  assert.equal(captured.options.cache, "no-store");
  assert.deepEqual(captured.options.headers, {
    "X-Found-Roll-Demo-Token": "operator-runtime-token",
    "X-Found-Roll-Staff-Token": "staff-runtime-token",
    "X-Found-Roll-Supervisor-Token": "supervisor-runtime-token",
  });
  assert.deepEqual(client.runtimeRoles, roles);
});

test("clearing a runtime session disposes every secret and revokes evidence only once", () => {
  const client = new ServiceDemoClient();
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = (value) => revoked.push(value);
  try {
    client.demoToken = "operator-secret";
    client.staffToken = "staff-secret";
    client.supervisorToken = "supervisor-secret";
    client.runtimeRoles = { staff_actor_id: "staff.configured" };
    client.case = { id: "FR-sensitive" };
    client.handoff = { id: "handoff-sensitive" };
    client.claimLink = { token: "claim-link-secret" };
    client.tokens = { claimant: "claimant-secret", custodian: "custodian-secret" };
    client.releaseTask = { payload: { outbox_id: "secret-task" } };
    client.releaseOutbox = { id: "outbox-sensitive" };
    client.manifest = { manifest_id: "manifest-sensitive" };
    client.pendingIntake = { idempotencyKey: "pending-sensitive" };
    client.pendingClaim = {
      path: "/api/v1/passports/FR-sensitive/claim-evidence",
      token: "claim-link-secret",
      body: { answer: "pending-private-answer" },
    };
    client.intakeEvidence = { objectUrl: "blob:staff-preview", src: "blob:staff-preview" };

    client.clearSession();
    client.clearSession();

    assert.equal(client.demoToken, "");
    assert.equal(client.staffToken, "");
    assert.equal(client.supervisorToken, "");
    assert.equal(client.runtimeRoles, null);
    assert.equal(client.case, null);
    assert.equal(client.handoff, null);
    assert.equal(client.claimLink, null);
    assert.equal(client.tokens, null);
    assert.equal(client.releaseTask, null);
    assert.equal(client.releaseOutbox, null);
    assert.equal(client.manifest, null);
    assert.equal(client.pendingIntake, null);
    assert.equal(client.pendingClaim, null);
    assert.equal(client.intakeEvidence, null);
    assert.equal(client.tokenReplayRejected, false);
    assert.equal(client.callbackReplayHandled, false);
    assert.deepEqual(revoked, ["blob:staff-preview"]);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});

test("claimant and direct-relay action failures never refresh a rich projection", async () => {
  const calls = [];
  const client = {
    caseId: "FR-claimant-recovery",
    async loadProjection() {
      calls.push("rich");
      return { authoritative: true, source: "service" };
    },
    async loadClaimantProjection() {
      calls.push("claimant");
      return { authoritative: true, source: "claimant_service" };
    },
  };

  const ambiguous = await recoverConnectedActionFailure(
    client,
    "claimant",
    new TypeError("claim response lost"),
  );
  const rejected = new Error("claim link expired");
  rejected.status = 409;
  const definitive = await recoverConnectedActionFailure(client, "claimant", rejected);

  assert.deepEqual(ambiguous, { kind: "preserve_claimant" });
  assert.deepEqual(definitive, {
    kind: "claimant_unavailable",
    caseId: "FR-claimant-recovery",
  });
  assert.deepEqual(calls, []);

  const relay = await recoverConnectedActionFailure(
    client,
    "relay",
    new TypeError("relay response lost"),
  );
  assert.deepEqual(relay, { kind: "preserve_relay" });
  assert.deepEqual(calls, []);

  const staff = await recoverConnectedActionFailure(client, "staff", new TypeError("staff refresh"));
  assert.equal(staff.kind, "projection");
  assert.equal(staff.projection.source, "service");
  assert.deepEqual(calls, ["rich"]);
});

test("runtime session bootstrap clears empty partial and rejected credential sets", async () => {
  const client = new ServiceDemoClient();
  client.claimLink = { token: "old-claim-secret" };
  client.tokens = { claimant: "old-claimant-secret" };

  const empty = await configureRuntimeSession(client, {});
  assert.deepEqual(empty, { configured: false, projection: null, roles: null });
  assert.equal(client.claimLink, null);
  assert.equal(client.tokens, null);

  await assert.rejects(
    configureRuntimeSession(client, { demoToken: "operator-only" }),
    /all three distinct runtime role credentials/i,
  );
  assert.equal(client.demoToken, "");
  assert.equal(client.staffToken, "");
  assert.equal(client.supervisorToken, "");

  client.verifyRuntimeCredentials = async () => {
    const error = new Error("The service rejected these runtime credentials.");
    error.status = 403;
    throw error;
  };
  await assert.rejects(
    configureRuntimeSession(client, {
      demoToken: "operator-rejected",
      staffToken: "staff-rejected",
      supervisorToken: "supervisor-rejected",
    }),
    /rejected these runtime credentials/i,
  );
  assert.equal(client.demoToken, "");
  assert.equal(client.staffToken, "");
  assert.equal(client.supervisorToken, "");
  assert.equal(client.runtimeRoles, null);
});

test("runtime session bootstrap verifies roles before loading the staff projection", async () => {
  const client = new ServiceDemoClient();
  const calls = [];
  client.verifyRuntimeCredentials = async () => {
    calls.push("verify");
    return { authenticated: true, staff_actor_id: "staff.configured", supervisor_actor_id: "supervisor.configured" };
  };
  client.loadProjection = async () => {
    calls.push("projection");
    return { authoritative: true, caseId: "FR-runtime" };
  };

  const configured = await configureRuntimeSession(client, {
    demoToken: "operator-runtime",
    staffToken: "staff-runtime",
    supervisorToken: "supervisor-runtime",
  });

  assert.deepEqual(calls, ["verify", "projection"]);
  assert.equal(configured.configured, true);
  assert.equal(configured.projection.caseId, "FR-runtime");
});

test("accountable identity, approval, and release mutations use distinct role credentials", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.case = { id: "FR-role-boundary", state: "CLAIM_EVIDENCE_ACCEPTED", version: 7 };
  client.setDemoToken("operator-token-must-not-cross-role-boundaries");
  client.setStaffToken("staff-role-runtime-token");
  client.setSupervisorToken("supervisor-role-runtime-token");
  const calls = [];
  client.request = async (path, options = {}) => {
    calls.push({ path, options, body: options.body ? JSON.parse(options.body) : null });
    if (path.endsWith("/releases")) {
      return {
        case: { id: "FR-role-boundary", state: "RELEASE_REQUESTED", version: 10 },
        task: { mode: "inline", payload: { operation: "release" } },
      };
    }
    if (path.endsWith("/close")) return { manifest_id: "manifest-role-boundary" };
    return { case: { id: "FR-role-boundary", state: "ROLE_STEP", version: client.case.version + 1 } };
  };
  client.completeTask = async () => ({ case: client.case });

  await client.attestIdentity();
  await client.approve();
  await client.releaseAndClose();

  assert.equal(calls[0].options.headers["X-Found-Roll-Staff-Token"], "staff-role-runtime-token");
  assert.equal(calls[0].options.headers["X-Found-Roll-Demo-Token"], undefined);
  assert.equal(calls[0].body.staff_user_id, undefined);
  assert.equal(calls[1].options.headers["X-Found-Roll-Supervisor-Token"], "supervisor-role-runtime-token");
  assert.equal(calls[1].options.headers["X-Found-Roll-Demo-Token"], undefined);
  assert.equal(calls[1].body.supervisor_user_id, undefined);
  assert.equal(calls[2].options.headers["X-Found-Roll-Staff-Token"], "staff-role-runtime-token");
  assert.equal(calls[2].options.headers["X-Found-Roll-Demo-Token"], undefined);
  assert.equal(calls[2].body.staff_user_id, undefined);
  assert.equal(calls[3].options.headers["X-Found-Roll-Demo-Token"], "operator-token-must-not-cross-role-boundaries");
});

test("network failures during a replay check are never treated as proof of rejection", async () => {
  const client = new ServiceDemoClient();
  client.case = { state: "CLAIMANT_PRESENT", version: 20 };
  client.handoff = { id: "handoff-service", claimant_attested: true };
  client.tokens = { claimant: "raw-from-service" };
  client.presentToken = async () => {
    throw new TypeError("network unavailable");
  };

  await assert.rejects(
    client.perform({ type: "PRESENT_TOKEN", role: "claimant" }),
    /network unavailable/,
  );
});

test("claimant evidence uses only the one-time case link and rotates it after rejection", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.case = { state: "CLARIFICATION_REQUIRED", version: 5 };
  client.setDemoToken("operator-token-must-not-cross-claim-boundary");
  client.setClaimLinkToken("frcl_scoped-claim-token-value-12345678901234567890");
  const calls = [];
  client.request = async (path, options) => {
    calls.push({ path, options, body: JSON.parse(options.body) });
    return {
      accepted: false,
      case: {
        id: "FR-20260829-0042",
        state: "CLARIFICATION_REQUIRED",
        version: 6,
        public_description: "Small black camera pouch.",
        found_date_label: "Aug 29, 2026",
        route_label: "3 participating custodians checked",
        synthetic_custodian_label: "Participating custodian (SIMULATED)",
        next_question: "What are the last four digits?",
        attempt_count: 1,
        link: { active: false, issued_case_version: 5 },
      },
      replacement_claim_link: {
        token: "frcl_rotated-claim-token-value-123456789012345678",
        expires_at: "2026-08-29T10:20:00Z",
        issued_case_version: 6,
      },
    };
  };

  const rejected = await client.submitClaim("0000");

  assert.equal(calls[0].path, "/api/v1/passports/FR-20260829-0042/claim-evidence");
  assert.equal(calls[0].options.headers["X-Found-Roll-Claim-Link"], "frcl_scoped-claim-token-value-12345678901234567890");
  assert.equal(calls[0].options.headers["X-Found-Roll-Demo-Token"], undefined);
  assert.equal(calls[0].body.answer, "0000");
  assert.equal(client.claimLink.token, "frcl_rotated-claim-token-value-123456789012345678");
  assert.equal(client.claimLink.issuedCaseVersion, 6);
  assert.equal(rejected.projection.claimLink.available, true);
});

test("an ambiguous claimant response reuses the exact pending command", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.caseId = "FR-claim-retry";
  client.case = { id: "FR-claim-retry", state: "CLARIFICATION_REQUIRED", version: 5 };
  client.setClaimLinkToken("frcl_original-response-loss-token-12345678901234567890");
  const calls = [];
  client.request = async (path, options) => {
    calls.push({ path, headers: { ...options.headers }, body: JSON.parse(options.body) });
    if (calls.length === 1) throw new TypeError("response lost after commit");
    return {
      accepted: false,
      case: {
        id: "FR-claim-retry",
        state: "CLARIFICATION_REQUIRED",
        version: 6,
        public_description: "Small black camera pouch.",
        found_date_label: "Aug 29, 2026",
        route_label: "3 participating custodians checked",
        synthetic_custodian_label: "Participating custodian (SIMULATED)",
        next_question: "What is the requested private detail?",
        attempt_count: 1,
        link: { active: false, issued_case_version: 5 },
      },
      replacement_claim_link: {
        token: "frcl_recovered-rotated-token-123456789012345678901",
        expires_at: "2026-08-29T10:20:00Z",
        issued_case_version: 6,
      },
    };
  };

  await assert.rejects(client.submitClaim("first-private-detail"), /response lost after commit/);
  const recovered = await client.submitClaim("different-input-must-not-replace-the-pending-command");

  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[0].body.answer, "first-private-detail");
  assert.equal(calls[0].body.expected_version, 5);
  assert.match(calls[0].body.idempotency_key, /^ui:claim:/);
  assert.equal(
    calls[0].headers["X-Found-Roll-Claim-Link"],
    "frcl_original-response-loss-token-12345678901234567890",
  );
  assert.equal(recovered.projection.claimLink.value, "frcl_recovered-rotated-token-123456789012345678901");
  assert.equal(client.pendingClaim, null);
});

test("a definitive claimant rejection clears the pending private command", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.caseId = "FR-claim-definitive";
  client.case = { id: "FR-claim-definitive", state: "CLARIFICATION_REQUIRED", version: 5 };
  client.setClaimLinkToken("frcl_definitive-token-1234567890123456789012345");
  client.request = async () => {
    const error = new Error("This claimant proof link has expired.");
    error.status = 409;
    error.code = "claim_link_expired";
    throw error;
  };

  await assert.rejects(client.submitClaim("private-detail"), /expired/);

  assert.equal(client.pendingClaim, null);
});

test("claim-link issuance requires operator and staff credentials without crossing the supervisor boundary", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setCaseId("FR-claim-link-boundary");
  client.case = { id: "FR-claim-link-boundary", state: "CLARIFICATION_REQUIRED", version: 5 };
  client.setStaffToken("staff-role-runtime-token");
  await assert.rejects(client.issueClaimLink(), /operator demo credential/);

  client.setDemoToken("operator-runtime-token");
  client.setSupervisorToken("supervisor-token-must-not-cross-link-boundary");
  const calls = [];
  client.request = async (path, options) => {
    calls.push({ path, options, body: JSON.parse(options.body) });
    return {
      token: "frcl_case-scoped-runtime-token-12345678901234567890",
      expires_at: "2026-08-29T10:20:00Z",
      issued_case_version: 5,
    };
  };

  await client.issueClaimLink();

  assert.equal(calls[0].path, "/api/v1/passports/FR-claim-link-boundary/claim-links");
  assert.equal(calls[0].options.headers["X-Found-Roll-Demo-Token"], "operator-runtime-token");
  assert.equal(calls[0].options.headers["X-Found-Roll-Staff-Token"], "staff-role-runtime-token");
  assert.equal(calls[0].options.headers["X-Found-Roll-Supervisor-Token"], undefined);
  assert.equal(calls[0].body.expected_version, 5);
});

test("connected intake uses separate operator and staff boundaries while the server queues analysis", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setDemoToken("operator-runtime-token");
  client.setStaffToken("staff-evidence-runtime-token");
  const calls = [];
  client.request = async (path, options) => {
    calls.push({ kind: "request", path, options });
    if (path === "/api/v1/intakes") {
      return {
        case: {
          id: "case-imported-001",
          state: "RECEIVED",
          version: 1,
        },
      };
    }
    if (path === "/api/v1/passports/case-imported-001") {
      return { case: { id: "case-imported-001", state: "RECEIVED", version: 1 } };
    }
    return {
      original: { id: "evd-original" },
      preview: { id: "evd-preview", mime_type: "image/jpeg", sha256: "preview-sha" },
      analysis_job: {
        case: { id: "case-imported-001", state: "ANALYZING", version: 3 },
        task: { mode: "cloud_tasks", queued: true, task_name: "projects/demo/locations/us/queues/found-roll/tasks/analysis-001" },
      },
    };
  };
  let releaseQueuedTask;
  const queuedTaskCompletion = new Promise((resolve) => { releaseQueuedTask = resolve; });
  let markQueuedTaskStarted;
  const queuedTaskStarted = new Promise((resolve) => { markQueuedTaskStarted = resolve; });
  client.completeTask = async (analysisJob, expectedState) => {
    calls.push({ kind: "queued-analysis", analysisJob, expectedState });
    markQueuedTaskStarted();
    await queuedTaskCompletion;
    client.case = { id: client.caseId, state: "CLARIFICATION_REQUIRED", version: 5 };
  };
  client.readStaffEvidence = async (evidenceId) => {
    calls.push({ kind: "evidence-read", evidenceId });
    return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  };
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "intake.jpg", { type: "image/jpeg" });
  const queuedProjections = [];

  const importPromise = client.importIntake({
    assignedTenant: "northport-air",
    currentHolder: "Northport Air secure dropbox",
    publicDescription: "Synthetic camera pouch used for connected intake testing.",
    foundAt: "2026-08-29T10:00:00Z",
    foundZone: "Terminal C",
    reportRoute: ["Metro Loop", "Northport Air"],
    authorizePreviewForModel: true,
    file,
  }, {
    onQueuedProjection: (projection) => queuedProjections.push(projection),
  });
  await queuedTaskStarted;

  assert.equal(calls[0].path, "/api/v1/intakes");
  assert.equal(JSON.parse(calls[0].options.body).safety_result, "ORDINARY_ITEM");
  assert.equal(JSON.parse(calls[0].options.body).actor, undefined);
  assert.equal(calls[0].options.headers["X-Found-Roll-Demo-Token"], "operator-runtime-token");
  assert.equal(calls[0].options.headers["X-Found-Roll-Staff-Token"], "staff-evidence-runtime-token");
  assert.equal(calls[1].path, "/api/v1/staff/passports/case-imported-001/evidence");
  assert.equal(calls[1].options.headers["X-Found-Roll-Staff-Token"], "staff-evidence-runtime-token");
  assert.equal(calls[1].options.headers["X-Found-Roll-Demo-Token"], undefined);
  assert.equal(calls[1].options.body instanceof FormData, true);
  assert.equal(calls[1].options.body.get("authorize_preview_for_model"), "true");
  assert.match(calls[1].options.body.get("idempotency_key"), /^ui:evidence:[a-f0-9]{64}$/);
  assert.deepEqual(calls[2], { kind: "evidence-read", evidenceId: "evd-preview" });
  assert.equal(calls[3].kind, "queued-analysis");
  assert.equal(calls[3].expectedState, "CLARIFICATION_REQUIRED");
  assert.equal(calls.some((call) => call.path === "/api/v1/passports/case-imported-001/analysis-jobs"), false);
  assert.equal(client.intakeEvidence.id, "evd-preview");
  assert.equal(client.intakeEvidence.originalId, "evd-original");
  assert.equal(client.intakeEvidence.filename, "intake.jpg");
  assert.equal(client.intakeEvidence.displaySource, "server-derived-preview");
  assert.match(client.intakeEvidence.src, /^blob:/);
  assert.deepEqual(queuedProjections.map((projection) => ({
    authoritative: projection.authoritative,
    source: projection.source,
    caseId: projection.caseId,
    state: projection.state,
    version: projection.version,
  })), [{
    authoritative: true,
    source: "service",
    caseId: "case-imported-001",
    state: "ANALYZING",
    version: 3,
  }]);
  let importSettled = false;
  void importPromise.then(() => { importSettled = true; });
  await Promise.resolve();
  assert.equal(importSettled, false, "the queued projection must render before task completion settles the intake command");
  releaseQueuedTask();
  await importPromise;
});

test("retrying a failed evidence upload resumes the same intake command and case", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setDemoToken("operator-runtime-token");
  client.setStaffToken("staff-evidence-runtime-token");
  const createBodies = [];
  const evidenceKeys = [];
  let uploadAttempts = 0;
  let queuedAnalysisCalls = 0;
  client.request = async (path, options = {}) => {
    if (path === "/api/v1/intakes") {
      createBodies.push(JSON.parse(options.body));
      return { case: { id: "case-resumable-001", state: "RECEIVED", version: 1 } };
    }
    if (path === "/api/v1/staff/passports/case-resumable-001/evidence") {
      uploadAttempts += 1;
      evidenceKeys.push(options.body.get("idempotency_key"));
      if (uploadAttempts === 1) throw new TypeError("upload connection interrupted");
      return {
        original: { id: "evd-resume-original" },
        preview: { id: "evd-resume-preview", mime_type: "image/jpeg", sha256: "preview-sha" },
        analysis_job: {
          case: { id: "case-resumable-001", state: "ANALYZING", version: 3 },
          task: { mode: "cloud_tasks", queued: true, task_name: "projects/demo/locations/us/queues/found-roll/tasks/resume-001" },
        },
      };
    }
    if (path === "/api/v1/passports/case-resumable-001") {
      return { case: { id: "case-resumable-001", state: "RECEIVED", version: 1 } };
    }
    throw new Error(`Unexpected test path: ${path}`);
  };
  client.readStaffEvidence = async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  client.completeTask = async (analysisJob, expectedState) => {
    queuedAnalysisCalls += 1;
    assert.equal(analysisJob.task.mode, "cloud_tasks");
    assert.equal(expectedState, "CLARIFICATION_REQUIRED");
  };
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "resume.jpg", { type: "image/jpeg" });
  const intake = {
    assignedTenant: "northport-air",
    currentHolder: "Northport Air secure dropbox",
    publicDescription: "Black camera pouch with a repaired seam.",
    foundAt: "2026-08-29T10:00:00Z",
    foundZone: "Terminal C",
    reportRoute: ["Metro Loop", "Northport Air"],
    authorizePreviewForModel: true,
    file,
  };

  await assert.rejects(client.importIntake(intake), /upload connection interrupted/);
  await client.importIntake(intake);

  assert.equal(createBodies.length, 2);
  assert.equal(createBodies[0].idempotency_key, createBodies[1].idempotency_key);
  assert.equal(evidenceKeys[0], evidenceKeys[1]);
  assert.equal(uploadAttempts, 2);
  assert.equal(queuedAnalysisCalls, 1);
  assert.equal(client.caseId, "case-resumable-001");
  assert.equal(client.pendingIntake, null);
});

test("an ambiguous intake upload observes an already-queued analysis without posting an analysis job", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setDemoToken("operator-runtime-token");
  client.setStaffToken("staff-evidence-runtime-token");
  const calls = [];
  client.request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === "/api/v1/intakes") {
      return { case: { id: "case-ambiguous-001", state: "RECEIVED", version: 1, analysis_auto_start_armed: true } };
    }
    if (path === "/api/v1/staff/passports/case-ambiguous-001/evidence") {
      // Model a lost server response that was retried after the service had
      // already committed the queued command but could not include its receipt.
      return {
        original: { id: "evd-ambiguous-original" },
        preview: { id: "evd-ambiguous-preview", mime_type: "image/jpeg", sha256: "preview-sha" },
      };
    }
    if (path === "/api/v1/passports/case-ambiguous-001") {
      return { case: { id: "case-ambiguous-001", state: "ANALYZING", version: 3, analysis_auto_start_armed: true } };
    }
    throw new Error(`Unexpected test path: ${path}`);
  };
  client.readStaffEvidence = async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  let observedState = null;
  client.waitForState = async (expectedState) => {
    observedState = expectedState;
    client.case = { id: "case-ambiguous-001", state: expectedState, version: 5, analysis_auto_start_armed: true };
  };
  client.beginAnalysis = async () => {
    throw new Error("The browser must not create an analysis command after an ambiguous upload.");
  };
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "ambiguous.jpg", { type: "image/jpeg" });
  const queuedProjections = [];

  await client.importIntake({
    assignedTenant: "northport-air",
    currentHolder: "Northport Air secure dropbox",
    publicDescription: "Synthetic camera pouch used for recovery testing.",
    foundAt: "2026-08-29T10:00:00Z",
    foundZone: "Terminal C",
    reportRoute: ["Metro Loop", "Northport Air"],
    authorizePreviewForModel: true,
    file,
  }, {
    onQueuedProjection: (projection) => queuedProjections.push(projection),
  });

  assert.equal(observedState, "CLARIFICATION_REQUIRED");
  assert.equal(calls.some((call) => call.path.endsWith("/analysis-jobs")), false);
  assert.deepEqual(queuedProjections.map((projection) => ({
    authoritative: projection.authoritative,
    caseId: projection.caseId,
    state: projection.state,
    version: projection.version,
  })), [{
    authoritative: true,
    caseId: "case-ambiguous-001",
    state: "ANALYZING",
    version: 3,
  }]);
});

test("manual analysis remains available only for the deliberately unarmed fixture", async () => {
  const client = new ServiceDemoClient();
  client.case = { id: "FR-20260829-0042", state: "RECEIVED", version: 1, analysis_auto_start_armed: false };
  let manualStarts = 0;
  client.beginAnalysis = async () => {
    manualStarts += 1;
  };
  client.loadProjection = async () => ({ case: client.case });

  await client.perform({ type: "ANALYZE" });
  assert.equal(manualStarts, 1);

  client.case = { ...client.case, analysis_auto_start_armed: true };
  await assert.rejects(client.perform({ type: "ANALYZE" }), /server-queued/);
  assert.equal(manualStarts, 1);
});

test("correcting an invalid image keeps the intake case but creates a new evidence command", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setDemoToken("operator-runtime-token");
  client.setStaffToken("staff-evidence-runtime-token");
  const createBodies = [];
  const evidenceKeys = [];
  let uploadAttempts = 0;
  client.request = async (path, options = {}) => {
    if (path === "/api/v1/intakes") {
      createBodies.push(JSON.parse(options.body));
      return { case: { id: "case-corrected-001", state: "RECEIVED", version: 1 } };
    }
    if (path === "/api/v1/staff/passports/case-corrected-001/evidence") {
      uploadAttempts += 1;
      evidenceKeys.push(options.body.get("idempotency_key"));
      if (uploadAttempts === 1) {
        const error = new Error("The declared evidence type does not match the decoded image.");
        error.status = 415;
        throw error;
      }
      return {
        original: { id: "evd-corrected-original" },
        preview: { id: "evd-corrected-preview", mime_type: "image/jpeg", sha256: "preview-sha" },
      };
    }
    if (path === "/api/v1/passports/case-corrected-001") {
      return { case: { id: "case-corrected-001", state: "RECEIVED", version: 1 } };
    }
    throw new Error(`Unexpected test path: ${path}`);
  };
  client.readStaffEvidence = async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  client.beginAnalysis = async () => {};
  const metadata = {
    assignedTenant: "northport-air",
    currentHolder: "Northport Air secure dropbox",
    publicDescription: "Black camera pouch with a repaired seam.",
    foundAt: "2026-08-29T10:00:00Z",
    foundZone: "Terminal C",
    reportRoute: ["Metro Loop", "Northport Air"],
    authorizePreviewForModel: true,
  };
  const invalidFile = new File([new Uint8Array([0x00, 0x01])], "bad.jpg", { type: "image/jpeg" });
  const correctedFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "good.jpg", { type: "image/jpeg" });

  await assert.rejects(client.importIntake({ ...metadata, file: invalidFile }), /does not match/);
  await client.importIntake({ ...metadata, file: correctedFile });

  assert.equal(createBodies[0].idempotency_key, createBodies[1].idempotency_key);
  assert.notEqual(evidenceKeys[0], evidenceKeys[1]);
  assert.equal(client.caseId, "case-corrected-001");
});

test("clearing the staff role credential revokes the in-memory intake preview", () => {
  const client = new ServiceDemoClient();
  const originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = (value) => revoked.push(value);
  try {
    client.intakeEvidence = { id: "evd-preview", objectUrl: "blob:staff-preview", src: "blob:staff-preview" };
    client.setStaffToken("");
    assert.equal(client.intakeEvidence, null);
    assert.deepEqual(revoked, ["blob:staff-preview"]);
  } finally {
    URL.revokeObjectURL = originalRevoke;
  }
});

test("staff evidence preview selects only the active pair from the current workflow epoch", async () => {
  const client = new ServiceDemoClient("https://custody.example");
  client.setStaffToken("staff-evidence-runtime-token");
  client.request = async (path) => {
    assert.equal(path, "/api/v1/staff/passports/FR-current/evidence");
    return {
      workflow_epoch: "epoch-current",
      active_pair_ids: ["evd-current-original", "evd-current-preview"],
      items: [
        {
          id: "evd-old-preview",
          workflow_epoch: "epoch-old",
          mime_type: "image/jpeg",
          sha256: "old-sha",
          provenance: { origin: "DERIVED", source_evidence_id: "evd-old-original" },
        },
        {
          id: "evd-current-original",
          workflow_epoch: "epoch-current",
          mime_type: "image/jpeg",
          sha256: "original-sha",
          provenance: { origin: "ORIGINAL", source_evidence_id: null },
        },
        {
          id: "evd-current-preview",
          workflow_epoch: "epoch-current",
          mime_type: "image/jpeg",
          sha256: "current-sha",
          provenance: { origin: "DERIVED", source_evidence_id: "evd-current-original" },
        },
      ],
    };
  };
  const reads = [];
  client.readStaffEvidence = async (evidenceId) => {
    reads.push(evidenceId);
    return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  };

  const evidence = await client.loadCurrentEvidencePreview({
    id: "FR-current",
    workflow_epoch: "epoch-current",
  });

  assert.deepEqual(reads, ["evd-current-preview"]);
  assert.equal(evidence.id, "evd-current-preview");
  assert.equal(evidence.originalId, "evd-current-original");
  assert.equal(evidence.workflowEpoch, "epoch-current");
  assert.equal(evidence.displaySource, "server-derived-preview");
});
