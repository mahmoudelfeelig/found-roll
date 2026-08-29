import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDemoAction } from "../src/demoController.js";
import { demoReducer, initialDemoState } from "../src/demoMachine.js";
import { ServiceDemoClient } from "../src/serviceDemoClient.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceRoot = path.join(projectRoot, "service");
const simulatorRoot = path.join(projectRoot, "simulator");
const servicePython = path.join(serviceRoot, ".venv", "Scripts", "python.exe");
const simulatorPython = path.join(simulatorRoot, ".venv", "Scripts", "python.exe");
const defaultReceipt = path.join(projectRoot, "artifacts", "verification", "service-client-http-smoke-receipt.json");
const inventoryReceipt = path.join(projectRoot, "artifacts", "verification", "inventory-gateway-http-smoke-receipt.json");
const localCanonicalReceipt = path.join(projectRoot, "artifacts", "verification", "local-canonical-preparation-receipt.json");

// These values are intentionally non-secret, loopback-only test fixtures.
const LOCAL_DEMO_TOKEN = "found-roll-local-demo-token";
const LOCAL_ADMIN_TOKEN = "found-roll-local-admin-token";
const LOCAL_STAFF_TOKEN = "found-roll-local-staff-token";
const LOCAL_SUPERVISOR_TOKEN = "found-roll-local-supervisor-token";
const LOCAL_SIMULATOR_KEY = "found-roll-local-simulator-key";
const LOCAL_SIMULATOR_TOKEN_SECRET = "found-roll-local-simulator-token-secret";
const LOCAL_CALLBACK_SECRET = "found-roll-local-relay-secret";
const LOCAL_FIXTURE_CLAIM_ANSWER = "4118";
const STAFF_READ_OPTIONS = Object.freeze({
  headers: Object.freeze({ "X-Found-Roll-Staff-Token": LOCAL_STAFF_TOKEN }),
});

const children = [];
const sensitiveValues = [
  LOCAL_DEMO_TOKEN,
  LOCAL_ADMIN_TOKEN,
  LOCAL_STAFF_TOKEN,
  LOCAL_SUPERVISOR_TOKEN,
  LOCAL_SIMULATOR_KEY,
  LOCAL_SIMULATOR_TOKEN_SECRET,
  LOCAL_CALLBACK_SECRET,
  LOCAL_FIXTURE_CLAIM_ANSWER,
];

function receiptPathFromArgs() {
  const index = process.argv.indexOf("--receipt");
  if (index === -1) return defaultReceipt;
  if (!process.argv[index + 1]) throw new Error("--receipt requires a file path");
  return path.resolve(process.argv[index + 1]);
}

function redact(value) {
  return sensitiveValues.reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    String(value || ""),
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startPythonService({ name, python, cwd, port, env }) {
  const child = spawn(
    python,
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning", "--no-access-log"],
    {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const record = { name, child, tail: "" };
  const collect = (chunk) => {
    record.tail = `${record.tail}${chunk.toString("utf8")}`.slice(-12_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  children.push(record);
  return record;
}

function runPythonScript({ python, cwd, args, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Inventory gateway smoke failed with exit code ${code}. ${redact(stderr)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Inventory gateway smoke returned invalid JSON. ${redact(stdout)} ${error.message}`));
      }
    });
  });
}

function runCommand({ command, cwd, args, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} failed with exit code ${code}. ${redact(stderr)} ${redact(stdout)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function stopChild(record) {
  const hasExited = () => record.child.exitCode !== null || record.child.signalCode !== null;
  if (!record || hasExited()) return;
  record.child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => record.child.once("exit", () => resolve(true))),
    delay(3_000).then(() => false),
  ]);
  if (!exited && !hasExited()) {
    record.child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => record.child.once("exit", resolve)),
      delay(2_000),
    ]);
  }
  if (!hasExited()) throw new Error(`${record.name} did not stop after the smoke run.`);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(8_000),
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).pathname}: ${payload?.error?.code || payload?.error?.message || "request failed"}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function waitForHealth(record, url) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (record.child.exitCode !== null) {
      throw new Error(`${record.name} exited before health check passed. ${redact(record.tail)}`);
    }
    try {
      return await jsonRequest(url, { signal: AbortSignal.timeout(1_000) });
    } catch {
      await delay(150);
    }
  }
  throw new Error(`${record.name} did not become healthy. ${redact(record.tail)}`);
}

function idempotency(label) {
  return `service-client-smoke:${label}:${randomUUID()}`;
}

function eventBoundary(eventsPayload) {
  const items = eventsPayload.items || [];
  return {
    count: items.length,
    finalHash: items.at(-1)?.event_hash || null,
  };
}

function assertAuthoritativeProjection(ui, snapshot) {
  assert.equal(ui.authoritative, true);
  assert.equal(ui.source, "service");
  assert.equal(ui.caseId, snapshot.case.id);
  assert.equal(ui.state, snapshot.case.state);
  assert.equal(ui.version, snapshot.case.version);
  assert.deepEqual(ui.handoff, snapshot.handoff);
  assert.deepEqual(ui.events.map((event) => event.id), snapshot.events.map((event) => event.id));
  assert.deepEqual(ui.events.map((event) => event.event_hash), snapshot.events.map((event) => event.event_hash));
}

async function main() {
  await Promise.all([access(servicePython), access(simulatorPython)]);
  const receiptPath = receiptPathFromArgs();
  const [simulatorPort, servicePort] = await Promise.all([freeLoopbackPort(), freeLoopbackPort()]);
  assert.notEqual(servicePort, simulatorPort);
  const simulatorUrl = `http://127.0.0.1:${simulatorPort}`;
  const serviceUrl = `http://127.0.0.1:${servicePort}`;

  const simulator = startPythonService({
    name: "relay simulator",
    python: simulatorPython,
    cwd: simulatorRoot,
    port: simulatorPort,
    env: {
      SIMULATOR_API_KEY: LOCAL_SIMULATOR_KEY,
      SIMULATOR_TOKEN_SECRET: LOCAL_SIMULATOR_TOKEN_SECRET,
      SIMULATOR_CALLBACK_SECRET: LOCAL_CALLBACK_SECRET,
    },
  });

  try {
    const simulatorHealth = await waitForHealth(simulator, `${simulatorUrl}/healthz`);
    assert.equal(simulatorHealth.data.service, "found-roll-simulator");

    const service = startPythonService({
      name: "custody service",
      python: servicePython,
      cwd: serviceRoot,
      port: servicePort,
      env: {
        FOUND_ROLL_ENV: "development",
        FOUND_ROLL_REPOSITORY: "memory",
        FOUND_ROLL_EVIDENCE_STORE: "memory",
        FOUND_ROLL_ANALYST_MODE: "fixture",
        FOUND_ROLL_INVENTORY_MODE: "http",
        FOUND_ROLL_INVENTORY_BASE_URL: simulatorUrl,
        FOUND_ROLL_INVENTORY_TIMEOUT_SECONDS: "3.0",
        FOUND_ROLL_RELAY_MODE: "http",
        FOUND_ROLL_TASKS_MODE: "inline",
        FOUND_ROLL_DEMO_MODE: "true",
        FOUND_ROLL_RELAY_BASE_URL: simulatorUrl,
        FOUND_ROLL_RELAY_API_KEY: LOCAL_SIMULATOR_KEY,
        FOUND_ROLL_RELAY_SHARED_SECRET: LOCAL_CALLBACK_SECRET,
        FOUND_ROLL_SECRET_PEPPER: "found-roll-local-fixture-pepper",
        FOUND_ROLL_DEMO_ACCESS_TOKEN: LOCAL_DEMO_TOKEN,
        FOUND_ROLL_ADMIN_TOKEN: LOCAL_ADMIN_TOKEN,
        FOUND_ROLL_EVIDENCE_STAFF_TOKEN: LOCAL_STAFF_TOKEN,
        FOUND_ROLL_SUPERVISOR_TOKEN: LOCAL_SUPERVISOR_TOKEN,
        FOUND_ROLL_PUBLIC_BASE_URL: serviceUrl,
      },
    });

    const serviceHealth = await waitForHealth(service, `${serviceUrl}/healthz`);
    assert.equal(serviceHealth.service, "found-roll-custody");
    assert.equal(serviceHealth.inventory_mode, "http");
    assert.equal(serviceHealth.inventory_base_url_configured, true);
    assert.equal(serviceHealth.relay_mode, "http");
    assert.equal(serviceHealth.tasks_mode, "inline");

    await jsonRequest(`${simulatorUrl}/v1/admin/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LOCAL_SIMULATOR_KEY}` },
      body: JSON.stringify({
        confirmation: "RESET_SIMULATED_FIXTURE",
        actor: "verification:service-client-http-smoke",
        reason: "Start a fresh loopback-only cross-service verification run.",
      }),
    });

    const inventoryGateway = await runPythonScript({
      python: servicePython,
      cwd: projectRoot,
      args: [
        path.join(projectRoot, "scripts", "inventory-gateway-http-smoke.py"),
        "--simulator-url",
        simulatorUrl,
        "--output",
        inventoryReceipt,
      ],
    });
    assert.equal(inventoryGateway.result, "passed");
    assert.equal(inventoryGateway.transport, "real_loopback_http");
    assert.equal(inventoryGateway.restricted_fields_included, false);

    // Reset/recovery is exercised outside ServiceDemoClient with the distinct
    // local admin contract. The browser client never receives this credential.
    await jsonRequest(`${serviceUrl}/api/v1/demo/reset`, {
      method: "POST",
      headers: { "X-Found-Roll-Admin-Token": LOCAL_ADMIN_TOKEN },
      body: JSON.stringify({}),
    });

    const importClient = new ServiceDemoClient(serviceUrl);
    importClient.setDemoToken(LOCAL_DEMO_TOKEN);
    importClient.setStaffToken(LOCAL_STAFF_TOKEN);
    const importBytes = await readFile(path.join(projectRoot, "public", "assets", "pouch-front.jpg"));
    await importClient.importIntake({
      assignedTenant: "northport-air",
      currentHolder: "Northport Air secure dropbox",
      publicDescription: "Owned synthetic camera pouch imported by the real loopback browser client.",
      foundAt: "2026-08-29T10:00:00Z",
      foundZone: "Terminal C verification desk",
      reportRoute: ["Metro Loop", "Northport Air"],
      authorizePreviewForModel: true,
      file: new File([importBytes], "loopback-import.jpg", { type: "image/jpeg" }),
    });
    const importedCaseId = importClient.caseId;
    assert.notEqual(importedCaseId, initialDemoState.caseId);
    const importedSnapshot = await jsonRequest(`${serviceUrl}/api/v1/passports/${importedCaseId}`, STAFF_READ_OPTIONS);
    assert.equal(importedSnapshot.case.state, "CLARIFICATION_REQUIRED");
    const importedEvidence = await jsonRequest(`${serviceUrl}/api/v1/staff/passports/${importedCaseId}/evidence`, {
      headers: { "X-Found-Roll-Staff-Token": LOCAL_STAFF_TOKEN },
    });
    assert.equal(importedEvidence.items.length, 2);
    const importedEvidenceEvent = importedSnapshot.events.find((event) => event.type === "EVIDENCE_PACKET_READY");
    assert.ok(importedEvidenceEvent);
    assert.equal(importedEvidenceEvent.evidence_refs.length, 2);
    assert.equal(importedEvidenceEvent.evidence_refs.every((reference) => reference.startsWith("evidence://evd-")), true);
    assert.equal(importedEvidenceEvent.evidence_refs.some((reference) => reference.startsWith("fixture://")), false);

    const client = new ServiceDemoClient(serviceUrl);
    assert.equal(client.setDemoToken(LOCAL_DEMO_TOKEN), true);
    assert.equal(client.setStaffToken(LOCAL_STAFF_TOKEN), true);
    assert.equal(client.setSupervisorToken(LOCAL_SUPERVISOR_TOKEN), true);
    const runtimeRoles = await client.verifyRuntimeCredentials();
    assert.equal(runtimeRoles.authenticated, true);
    assert.equal(runtimeRoles.staff_actor_id, "staff.northport");
    assert.equal(runtimeRoles.supervisor_actor_id, "supervisor.northport");
    let ui = demoReducer(initialDemoState, {
      type: "HYDRATE_SERVICE",
      payload: await client.loadProjection(),
    });
    let snapshot = await jsonRequest(`${serviceUrl}/api/v1/passports/${initialDemoState.caseId}`, STAFF_READ_OPTIONS);
    assertAuthoritativeProjection(ui, snapshot);
    assert.equal(ui.state, "RECEIVED");

    async function step(action) {
      const resolved = await resolveDemoAction({ action, connected: true, client });
      assert.equal(resolved.type, "HYDRATE_SERVICE");
      ui = demoReducer(ui, resolved);
      snapshot = await jsonRequest(`${serviceUrl}/api/v1/passports/${initialDemoState.caseId}`, STAFF_READ_OPTIONS);
      assertAuthoritativeProjection(ui, snapshot);
      return ui;
    }

    await step({ type: "ANALYZE" });
    assert.equal(ui.state, "CLARIFICATION_REQUIRED");
    const analysisOutbox = snapshot.outbox.find((row) => row.kind === "ANALYZE_CASE");
    assert.equal(analysisOutbox.status, "COMPLETE");

    await step({ type: "OPEN_CLAIMANT_PROOF" });
    assert.equal(ui.claimLink.available, true);
    await step({ type: "SUBMIT_CLAIM", answer: LOCAL_FIXTURE_CLAIM_ANSWER });
    assert.equal(ui.state, "CLAIM_EVIDENCE_ACCEPTED");
    assert.equal(ui.authoritativeCase.accepted_claim_evidence, true);

    await step({ type: "ATTEST_IDENTITY" });
    assert.equal(ui.state, "APPROVAL_REQUIRED");
    assert.equal(ui.authoritativeCase.identity_attested, true);

    await step({ type: "APPROVE" });
    assert.equal(ui.state, "APPROVAL_REQUIRED");
    assert.equal(ui.authoritativeCase.approval_recorded, true);

    await step({ type: "RESERVE" });
    assert.equal(ui.state, "RESERVED");
    assert.equal(ui.handoff.status, "HELD");
    assert.equal(ui.handoff.tokens_issued, true);
    const reservationOutbox = snapshot.outbox.find((row) => row.kind === "RESERVE_RELAY");
    assert.equal(reservationOutbox.status, "COMPLETE");
    assert.equal(typeof client.tokens.claimant, "string");
    assert.equal(typeof client.tokens.custodian, "string");
    assert.notEqual(client.tokens.claimant, client.tokens.custodian);
    assert.equal(ui.claimantToken.value, client.tokens.claimant);
    assert.equal(ui.custodianToken.value, client.tokens.custodian);

    await step({ type: "PRESENT_TOKEN", role: "custodian" });
    assert.equal(ui.custodianToken.status, "USED");
    const beforeTokenReplay = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}/events`, STAFF_READ_OPTIONS);
    const tokenBoundaryBefore = eventBoundary(beforeTokenReplay);
    await step({ type: "PRESENT_TOKEN", role: "custodian" });
    const afterTokenReplay = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}/events`, STAFF_READ_OPTIONS);
    const tokenBoundaryAfter = eventBoundary(afterTokenReplay);
    assert.equal(ui.tokenReplayRejected, true);
    assert.equal(afterTokenReplay.hash_chain_valid, true);
    assert.deepEqual(tokenBoundaryAfter, tokenBoundaryBefore);

    await step({ type: "PRESENT_TOKEN", role: "claimant" });
    assert.equal(ui.state, "CLAIMANT_PRESENT");
    assert.equal(ui.claimantToken.status, "USED");
    assert.equal(ui.custodianToken.status, "USED");

    await step({ type: "CONFIRM_HANDOFF" });
    assert.equal(ui.state, "CLOSED");
    assert.equal(ui.manifest.internally_consistent, true);
    assert.equal(ui.manifest.physical_transfer_proven, false);
    const releaseOutbox = snapshot.outbox.find((row) => row.kind === "RELEASE_RELAY");
    assert.equal(releaseOutbox.status, "COMPLETE");

    const beforeTaskReplay = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}/events`, STAFF_READ_OPTIONS);
    const taskBoundaryBefore = eventBoundary(beforeTaskReplay);
    let taskReplayResponse = null;
    const replayCompletedTask = client.replayReleaseTask.bind(client);
    client.replayReleaseTask = async () => {
      taskReplayResponse = await replayCompletedTask();
      return taskReplayResponse;
    };
    await step({ type: "REPLAY_CALLBACK" });
    const afterTaskReplay = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}/events`, STAFF_READ_OPTIONS);
    const taskBoundaryAfter = eventBoundary(afterTaskReplay);
    assert.equal(taskReplayResponse.replayed, true);
    assert.equal(ui.callback.replayHandled, true);
    assert.equal(afterTaskReplay.hash_chain_valid, true);
    assert.deepEqual(taskBoundaryAfter, taskBoundaryBefore);

    const finalSnapshot = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}`, STAFF_READ_OPTIONS);
    const finalEvents = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}/events`, STAFF_READ_OPTIONS);
    const finalManifest = await jsonRequest(`${serviceUrl}/api/v1/passports/${ui.caseId}/manifest`, STAFF_READ_OPTIONS);
    assertAuthoritativeProjection(ui, finalSnapshot);
    assert.equal(finalEvents.hash_chain_valid, true);
    assert.equal(finalSnapshot.case.state, "CLOSED");
    assert.equal(finalSnapshot.case.version, ui.version);
    assert.equal(finalSnapshot.case.event_count, finalEvents.items.length);
    assert.equal(finalManifest.manifest_id, ui.manifest.manifest_id);
    assert.equal(finalManifest.event_count, finalEvents.items.length);
    assert.equal(finalManifest.final_event_hash, finalEvents.items.at(-1).event_hash);

    const preparationOutput = await runCommand({
      command: "pwsh",
      cwd: projectRoot,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-File",
        path.join(projectRoot, "scripts", "prepare-canonical-run.ps1"),
        "-AppUrl",
        serviceUrl,
        "-SimulatorUrl",
        simulatorUrl,
        "-ReceiptPath",
        localCanonicalReceipt,
        "-AllowLocalFixture",
      ],
      env: {
        FOUND_ROLL_DEMO_ACCESS_TOKEN: LOCAL_DEMO_TOKEN,
        FOUND_ROLL_ADMIN_TOKEN: LOCAL_ADMIN_TOKEN,
        FOUND_ROLL_EVIDENCE_STAFF_TOKEN: LOCAL_STAFF_TOKEN,
        FOUND_ROLL_SUPERVISOR_TOKEN: LOCAL_SUPERVISOR_TOKEN,
        FOUND_ROLL_RELAY_API_KEY: LOCAL_SIMULATOR_KEY,
      },
    });
    const preparationReceipt = JSON.parse(preparationOutput);
    assert.equal(preparationReceipt.status, "PREPARED_FOR_ANALYSIS");
    assert.equal(preparationReceipt.canonical, false);
    assert.equal(preparationReceipt.runtime_roles_authenticated, true);
    assert.equal(preparationReceipt.evidence.active_for_analysis, true);
    assert.equal(preparationReceipt.evidence.current_epoch_record_count, 2);

    const receipt = {
      schema_version: "1",
      result: "passed",
      run_id: randomUUID(),
      case_id: ui.caseId,
      handoff_id: ui.handoff.id,
      reservation_id: ui.handoff.reservation_id,
      analysis_outbox_id: analysisOutbox.id,
      reservation_outbox_id: reservationOutbox.id,
      release_outbox_id: releaseOutbox.id,
      release_task_name: client.releaseTask.task_name,
      manifest_id: finalManifest.manifest_id,
      final_state: finalSnapshot.case.state,
      final_version: finalSnapshot.case.version,
      final_event_id: finalEvents.items.at(-1).id,
      event_count: finalEvents.items.length,
      first_event_hash: finalManifest.first_event_hash,
      final_event_hash: finalManifest.final_event_hash,
      hash_chain_valid: finalEvents.hash_chain_valid,
      inventory_gateway_loopback_http: inventoryGateway.result === "passed",
      inventory_gateway_authorized_candidate_count: inventoryGateway.authorized_candidate_ids.length,
      imported_case_id: importedCaseId,
      imported_evidence_count: importedEvidence.items.length,
      imported_evidence_provenance_verified: true,
      runtime_role_probe_authenticated: runtimeRoles.authenticated,
      runtime_staff_actor_id: runtimeRoles.staff_actor_id,
      runtime_supervisor_actor_id: runtimeRoles.supervisor_actor_id,
      service_projection_authoritative: ui.authoritative,
      token_replay_rejected: ui.tokenReplayRejected,
      token_replay_boundary_unchanged: JSON.stringify(tokenBoundaryBefore) === JSON.stringify(tokenBoundaryAfter),
      release_task_replayed: taskReplayResponse.replayed,
      release_task_boundary_unchanged: JSON.stringify(taskBoundaryBefore) === JSON.stringify(taskBoundaryAfter),
      manifest_internally_consistent: finalManifest.internally_consistent,
      physical_transfer_proven: finalManifest.physical_transfer_proven,
      local_canonical_preparation_verified: true,
    };
    const rendered = `${JSON.stringify(receipt, null, 2)}\n`;
    for (const sensitive of [...sensitiveValues, client.tokens.claimant, client.tokens.custodian]) {
      assert.equal(rendered.includes(sensitive), false, "Receipt must not contain fixture credentials, the private answer, or raw relay tokens.");
    }
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, rendered, "utf8");
    process.stdout.write(rendered);
  } finally {
    await Promise.all(children.toReversed().map(stopChild));
  }
}

await main().catch(async (error) => {
  await Promise.allSettled(children.toReversed().map(stopChild));
  process.stderr.write(`${redact(error?.stack || error)}\n`);
  process.exitCode = 1;
});
