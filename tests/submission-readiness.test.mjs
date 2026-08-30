import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  formatReadinessResult,
  verifySubmissionReadiness,
} from "../scripts/verify-submission-readiness.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = path.join(projectRoot, "scripts", "verify-submission-readiness.mjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return Buffer.from(JSON.stringify(stableJsonValue(value)), "utf8");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function fixturePng(width = 960, height = 540) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width + 1);
    scanlines[offset] = 0;
    for (let column = 0; column < width; column += 1) {
      scanlines[offset + column + 1] = (row * 31 + column * 17) & 0xff;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function refreshChainAuditBindings(audit, runReceipt) {
  let previousHash = "0".repeat(64);
  for (const event of audit.events) {
    event.previous_hash = previousHash;
    const unsigned = {
      ...event,
      occurred_at: event.occurred_at.replace(/Z$/, "+00:00"),
    };
    delete unsigned.event_hash;
    event.event_hash = sha256(canonicalJson(unsigned));
    previousHash = event.event_hash;
  }
  const evidenceDigests = [...new Set(audit.events.flatMap((event) => event.evidence_refs))]
    .sort()
    .map((evidenceRef) => sha256(canonicalJson({ evidence_ref: evidenceRef })));
  const manifestBody = {
    case_id: audit.case_id,
    final_version: 19,
    event_hashes: audit.events.map((event) => event.event_hash),
    evidence_digests: evidenceDigests,
  };
  audit.manifest = {
    schema_version: "1",
    manifest_id: `manifest-${sha256(canonicalJson(manifestBody)).slice(0, 24)}`,
    case_id: audit.case_id,
    final_state: "CLOSED",
    final_version: 19,
    event_count: 19,
    first_event_hash: audit.events[0].event_hash,
    final_event_hash: audit.events.at(-1).event_hash,
    event_ids: audit.events.map((event) => event.id),
    evidence_digests: evidenceDigests,
    internally_consistent: true,
    physical_transfer_proven: false,
    disclosure: "This application-enforced manifest checks service event consistency. It does not prove physical possession or a real-world transfer.",
  };
  runReceipt.closure.manifest_id = audit.manifest.manifest_id;
  runReceipt.closure.manifest_sha256 = sha256(canonicalJson(audit.manifest));
  runReceipt.closure.first_event_hash = audit.manifest.first_event_hash;
  runReceipt.closure.final_event_hash = audit.manifest.final_event_hash;
}

function makeChainAudit({ runReceipt, preparationReceipt, commit, tree, ordinal }) {
  const trajectory = [
    ["ITEM_PASSPORT_CREATED", "RECEIVED", "RECEIVED"],
    ["EVIDENCE_PACKET_READY", "RECEIVED", "EVIDENCE_READY"],
    ["ANALYSIS_REQUESTED", "EVIDENCE_READY", "ANALYZING"],
    ["CANDIDATE_PACKET_PROPOSED", "ANALYZING", "CANDIDATES_READY"],
    ["PRIVATE_EVIDENCE_REQUESTED", "CANDIDATES_READY", "CLARIFICATION_REQUIRED"],
    ["PRIVATE_EVIDENCE_RECEIVED", "CLARIFICATION_REQUIRED", "ANALYZING"],
    ["CANDIDATE_PACKET_RECHECKED", "ANALYZING", "CANDIDATES_READY"],
    ["CLAIM_EVIDENCE_ACCEPTED", "CANDIDATES_READY", "CLAIM_EVIDENCE_ACCEPTED"],
    ["IDENTITY_ATTESTED", "CLAIM_EVIDENCE_ACCEPTED", "IDENTITY_ATTESTED"],
    ["SUPERVISOR_APPROVAL_REQUIRED", "IDENTITY_ATTESTED", "APPROVAL_REQUIRED"],
    ["SUPERVISOR_APPROVED", "APPROVAL_REQUIRED", "APPROVAL_REQUIRED"],
    ["RELAY_RESERVATION_REQUESTED", "APPROVAL_REQUIRED", "RESERVE_REQUESTED"],
    ["RELAY_RESERVED", "RESERVE_REQUESTED", "RESERVED"],
    ["ONE_TIME_CREDENTIALS_ISSUED", "RESERVED", "RESERVED"],
    ["TOKEN_PRESENTED", "RESERVED", "RESERVED"],
    ["TOKEN_PRESENTED", "RESERVED", "CLAIMANT_PRESENT"],
    ["RELAY_RELEASE_REQUESTED", "CLAIMANT_PRESENT", "RELEASE_REQUESTED"],
    ["RELAY_RELEASED", "RELEASE_REQUESTED", "RELEASED"],
    ["ITEM_PASSPORT_CLOSED", "RELEASED", "CLOSED"],
  ];
  const evidenceRefs = [
    `evidence://${preparationReceipt.evidence.original_id}?sha256=${preparationReceipt.evidence.original_sha256}`,
    `evidence://${preparationReceipt.evidence.preview_id}?sha256=${preparationReceipt.evidence.preview_sha256}`,
  ];
  const events = [];
  for (let index = 0; index < 19; index += 1) {
    const occurredAt = `2026-08-29T20:0${ordinal}:${String(21 + index).padStart(2, "0")}Z`;
    const [type, fromState, toState] = trajectory[index];
    const actor = new Map([
      [8, preparationReceipt.staff_actor_id],
      [10, preparationReceipt.supervisor_actor_id],
      [12, "simulator:relay-post"],
      [14, "simulator:custodian-scanner"],
      [15, "simulator:claimant-scanner"],
      [16, preparationReceipt.staff_actor_id],
      [17, "simulator:relay-post"],
    ]).get(index) ?? "service:workflow";
    const event = {
      id: `evt-${ordinal}-${String(index + 1).padStart(2, "0")}`,
      case_id: runReceipt.case_id,
      sequence: index + 1,
      type,
      actor,
      from_state: fromState,
      to_state: toState,
      reason: `Synthetic canonical audit event ${index + 1}.`,
      evidence_refs: index === 1 ? evidenceRefs : [],
      tool: index === 3 ? "case_analyst.submit_observations" : index === 4 ? "propose_discriminator" : null,
      task_id: index === 16 || index === 17 ? runReceipt.cloud_boundary.task_name : null,
      model_run_id: index === 3 || index === 4 ? runReceipt.live_agent.model_run_id : null,
      simulator_attestation_id: index === 17 ? runReceipt.cloud_boundary.attestation_id : null,
      idempotency_key: `canonical:${ordinal}:event:${index + 1}`,
      occurred_at: occurredAt,
      previous_hash: "0".repeat(64),
      event_hash: "0".repeat(64),
    };
    events.push(event);
  }
  const audit = {
    schema_version: "1",
    kind: "found-roll-chain-audit",
    status: "PASS",
    run_id: runReceipt.run_id,
    case_id: runReceipt.case_id,
    workflow_epoch: runReceipt.workflow_epoch,
    submitted_commit: commit,
    tree_sha: tree,
    manifest: null,
    events,
  };
  refreshChainAuditBindings(audit, runReceipt);
  return audit;
}

async function writeJson(filePath, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, raw, "utf8");
  return { raw, digest: sha256(raw) };
}

function validPreparationReceipt(versions, workflowEpoch = "epoch-20260829-0042") {
  return {
    schema_version: "2",
    status: "PREPARED_FOR_ANALYSIS",
    canonical: true,
    prepared_at: "2026-08-29T20:00:00Z",
    preparation_script_sha256: "a".repeat(64),
    case_id: "FR-20260829-0042",
    workflow_epoch: workflowEpoch,
    case_version: 1,
    case_state: "RECEIVED",
    fixture_version: "camera-pouch-v1",
    analyst_mode: "vertex_adk",
    inventory_mode: "http",
    inventory_gateway_ready: true,
    model_name: "gemini-3.5-flash",
    prompt_version: versions.prompt,
    output_schema_version: versions.output_schema,
    policy_version: versions.policy,
    app_environment: "production",
    demo_mutation_auth_required: true,
    admin_reset_auth_required: true,
    staff_read_auth_required: true,
    task_header_required: true,
    task_oidc_required: true,
    runtime_roles_authenticated: true,
    staff_actor_id: "staff.northport",
    supervisor_actor_id: "supervisor.northport",
    inventory_legacy_health_compatibility: false,
    repository: "firestore",
    evidence_store: "gcs",
    tasks_mode: "cloud",
    relay_mode: "http",
    evidence: {
      source_file: "pouch-front.jpg",
      original_id: "evd-original-0042",
      original_sha256: "b".repeat(64),
      original_generation: 7,
      preview_id: "evd-preview-0042",
      preview_sha256: "c".repeat(64),
      preview_generation: 9,
      preview_visibility: "MODEL_AUTHORIZED",
      active_pair_ids: ["evd-original-0042", "evd-preview-0042"],
      current_epoch_record_count: 2,
      active_for_analysis: true,
      exact_retry_same_pair: true,
      changed_consent_conflict_verified: true,
      changed_consent_conflict_code: "evidence_idempotency_conflict",
    },
    simulator_disclosure: "SIMULATED",
    simulator_environment: "production",
    reset_event_count: 1,
  };
}

function validRunReceipt({ commit, tree, versions, runId, ordinal, workflowEpoch, preparationDigest, fixtureDigest, privacyDigest, frontendDigest }) {
  const manifestDigest = ordinal.toString(16).repeat(64);
  const firstEventHash = (ordinal + 5).toString(16).repeat(64);
  const finalEventHash = (ordinal + 10).toString(16).repeat(64);
  return {
    schema_version: "2",
    kind: "found-roll-canonical-run",
    status: "CANONICAL_PASS",
    canonical: true,
    run_id: runId,
    ordinal,
    started_at_utc: `2026-08-29T20:0${ordinal}:10Z`,
    ended_at_utc: `2026-08-29T20:0${ordinal}:59Z`,
    submitted_commit: commit,
    tree_sha: tree,
    preparation_receipt_sha256: preparationDigest,
    project_id: "found-roll-demo-123",
    hosted_url: "https://found-roll.web.app",
    case_id: "FR-20260829-0042",
    workflow_epoch: workflowEpoch,
    fixture_version: "camera-pouch-v1",
    fixture_sha256: fixtureDigest,
    app_origin: "https://found-roll-api-abc.a.run.app",
    simulator_origin: "https://found-roll-sim-abc.a.run.app",
    app_revision: "found-roll-app-00042-abc",
    simulator_revision: "found-roll-simulator-00042-def",
    model_name: "gemini-3.5-flash",
    prompt_version: versions.prompt,
    output_schema_version: versions.output_schema,
    policy_version: versions.policy,
    production: {
      app_environment: "production",
      analyst_mode: "vertex_adk",
      inventory_mode: "http",
      inventory_gateway_ready: true,
      inventory_legacy_health_compatibility: false,
      repository: "firestore",
      evidence_store: "gcs",
      tasks_mode: "cloud",
      relay_mode: "http",
      simulator_environment: "production",
      demo_mutation_auth_required: true,
      admin_reset_auth_required: true,
      staff_read_auth_required: true,
      task_header_required: true,
      task_oidc_required: true,
    },
    live_agent: {
      model_run_id: `model-run-00${ordinal}`,
      trace_id: `trace-run-00${ordinal}`,
      invocation_count: 4,
      tool_trajectory: [
        { name: "search_custodian", outcome: "success" },
        { name: "load_candidate", outcome: "success" },
        { name: "submit_observations", outcome: "success" },
        { name: "propose_discriminator", outcome: "success" },
      ],
      typed_output_valid: true,
    },
    cloud_boundary: {
      firestore_namespace: "found-roll-submission",
      firestore_transaction_contention_verified: true,
      evidence_bucket: "found-roll-demo-evidence",
      evidence_generations_verified: true,
      task_name: `release-task-00${ordinal}`,
      task_oidc_verified: true,
      task_delivery_attempts: 2,
      task_duplicate_side_effect_delta: 0,
      production_payload_omitted: true,
      simulator_request_id: `sim-request-00${ordinal}`,
      reservation_id: `reservation-00${ordinal}`,
      attestation_id: `attestation-00${ordinal}`,
      simulator_https_verified: true,
      simulator_api_auth_verified: true,
      callback_signature_verified: true,
      simulator_etag: `etag-00${ordinal}`,
      callback_replay_outcome: "duplicate-noop",
      callback_replay_side_effect_delta: 0,
    },
    closure: {
      final_state: "CLOSED",
      final_version: 19,
      event_count: 19,
      manifest_id: `manifest-00${ordinal}`,
      manifest_sha256: manifestDigest,
      first_event_hash: firstEventHash,
      final_event_hash: finalEventHash,
      hash_chain_valid: true,
      manifest_internally_consistent: true,
      reservation_count: 1,
      release_count: 1,
      closure_count: 1,
      physical_transfer_proven: false,
      manual_datastore_repair: false,
    },
    outcomes: {
      failures: [],
      retries: ["deliberate-task-duplicate", "deliberate-callback-replay"],
      exclusions: ["physical-transfer-proof"],
    },
    privacy: {
      receipt_sha256: privacyDigest,
      unresolved_findings: 0,
      binary_media_review_confirmed: true,
    },
    frontend_manifest_sha256: frontendDigest,
    clean_browser_verified: true,
  };
}

async function createFixture(t) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "found-roll-readiness-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  for (const directory of [
    "docs",
    "artifacts/private",
    "artifacts/verification",
    "service/app",
    "simulator",
    "evaluation",
    "scripts",
    "dist/client/assets",
  ]) await mkdir(path.join(repoRoot, directory), { recursive: true });
  const readmeSource = await readFile(path.join(projectRoot, "README.md"), "utf8");
  const readme = readmeSource.replace(
    /## Submission blockers that cannot be fabricated[\s\S]*$/,
    "## Submission blockers that cannot be fabricated\n\nAll entrant-controlled confirmations in this isolated passing fixture are represented by the bound private release record.\n",
  );
  const architectureDocument = await readFile(path.join(projectRoot, "docs", "architecture.md"), "utf8");
  const deploymentDocument = await readFile(path.join(projectRoot, "docs", "deployment.md"), "utf8");
  const projectLicense = await readFile(path.join(projectRoot, "LICENSE"), "utf8");
  const projectNotice = await readFile(path.join(projectRoot, "NOTICE.md"), "utf8");
  const thirdPartyNotices = await readFile(path.join(projectRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const hostedLicense = await readFile(path.join(projectRoot, "public", "legal", "FOUND-ROLL-LICENSE.txt"), "utf8");
  const hostedThirdPartyLicenses = await readFile(path.join(projectRoot, "public", "legal", "THIRD-PARTY-LICENSES.txt"), "utf8");
  await writeFile(path.join(repoRoot, "README.md"), readme, "utf8");
  await writeFile(path.join(repoRoot, "docs", "release.md"), "# Release\nCanonical evidence is bound by digest.\n", "utf8");

  const versions = {
    prompt: "found-roll-case-analyst-prompt-v1",
    output_schema: "found-roll-analysis-proposal-v1",
    policy: "found-roll-release-v1",
  };
  const sourceContents = {
    prompt: `CASE_ANALYST_PROMPT_VERSION = '${versions.prompt}'\n`,
    output_schema: `ANALYSIS_PROPOSAL_SCHEMA_VERSION = '${versions.output_schema}'\n`,
    policy: `POLICY_VERSION = '${versions.policy}'\n`,
  };
  const sourcePaths = {
    prompt: "service/app/agent_contract.py",
    output_schema: "service/app/domain.py",
    policy: "service/app/policy.py",
  };
  for (const key of Object.keys(sourcePaths)) {
    await writeFile(path.join(repoRoot, sourcePaths[key]), sourceContents[key], "utf8");
  }

  const architectureSource = `flowchart LR
    Product[Found Roll] --> Analyst[Google ADK Case Analyst]
    Analyst --> Gemini[Gemini 3.5]
    Product --> Run[Cloud Run]
    Run --> Firestore
    Run --> Storage[Cloud Storage]
    Run --> Tasks[Cloud Tasks]
    Run --> Relay[SIMULATED Relay]
`;
  const architectureRender = fixturePng();
  const frontendFiles = new Map([
    ["dist/client/index.html", Buffer.from("<!doctype html><title>Found Roll</title><script src=\"/assets/app.js\"></script>\n")],
    ["dist/client/assets/app.js", Buffer.from("console.log('found-roll-ready');\n")],
    ["dist/client/legal/FOUND-ROLL-LICENSE.txt", Buffer.from(hostedLicense)],
    ["dist/client/legal/THIRD-PARTY-LICENSES.txt", Buffer.from(hostedThirdPartyLicenses)],
  ]);
  for (const [relativePath, content] of frontendFiles) {
    await mkdir(path.dirname(path.join(repoRoot, relativePath)), { recursive: true });
    await writeFile(path.join(repoRoot, relativePath), content);
  }
  const frontendManifest = {
    schema_version: "1",
    kind: "found-roll-frontend-build",
    entrypoint: "dist/client/index.html",
    file_count: frontendFiles.size,
    total_bytes: [...frontendFiles.values()].reduce((total, content) => total + content.byteLength, 0),
    files: [...frontendFiles]
      .map(([relativePath, content]) => ({ path: relativePath, bytes: content.byteLength, sha256: sha256(content) }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
  const frontendManifestRaw = `${JSON.stringify(frontendManifest, null, 2)}\n`;
  const localRunners = [
    "full_happy_path",
    "state_graph",
    "visual_only_policy",
    "valuable_human_gates",
    "sensitive_policy",
    "dangerous_pre_intake",
    "wrong_answer_review",
    "fixture_analyst_canonical",
    "fixture_analyst_route_conflict",
    "fixture_analyst_no_eligible",
    "stale_case_version",
    "duplicate_analysis_task",
    "publication_privacy",
    "token_replay",
    "ambiguous_relay_reconciliation",
  ];
  const localFixtureRows = localRunners.map((runner, index) => ({
    id: `FR-${String(index + 1).padStart(3, "0")}`,
    title: `Local fixture ${index + 1}`,
    runner,
  }));
  const localExecutionBoundary = {
    repository: "in-memory",
    analyst: "deterministic FixtureCaseAnalyst",
    tasks: "inline",
    relay: "in-process fixture",
    network: "FastAPI TestClient in-process",
    gemini_calls: 0,
    google_cloud_calls: 0,
    claim: "Local deterministic behavior only.",
  };
  const localFixtureManifestRaw = `${JSON.stringify({
    schema_version: "2.0",
    suite_id: "found-roll-local-safety-v2",
    execution_boundary: localExecutionBoundary,
    fixtures: localFixtureRows,
    live_only_requirements: ["Live Google Cloud evidence remains required."],
  })}\n`;
  const localEvaluationRaw = `${JSON.stringify({
    schema_version: "2.0",
    suite_id: "found-roll-local-safety-v2",
    status: "LOCAL_PASS_CANONICAL_INCOMPLETE",
    fixture_count: 15,
    passed_count: 15,
    failed_count: 0,
    execution_boundary: localExecutionBoundary,
    results: localFixtureRows.map((fixture) => ({
      id: fixture.id,
      title: fixture.title,
      runner: fixture.runner,
      execution_mode: "local_deterministic_fixture",
      passed: true,
      observed: fixture.id === "FR-008"
        ? { local_adk_construction_contract: { max_llm_calls_cap: 8, max_output_tokens_cap: 2048, live_trajectory_observed: false } }
        : fixture.id === "FR-015"
          ? { final_state: "RECONCILIATION_REQUIRED", outbox_status: "FAILED", relay_calls: 1, retry_event_delta: 0, terminal_ack_status: 200, terminal_failure_acknowledged: true, retryable: false, manual_action_required: true }
          : {},
    })),
  })}\n`;
  const privacyCanaryManifest = '{"schema_version":"1","canaries":[]}\n';
  const privacyCanaryManifestSha256 = sha256(privacyCanaryManifest);
  const localPrivacyScanReceipt = `${JSON.stringify({
    schema_version: "1.0",
    status: "PASS",
    canary_count: 0,
    finding_count: 0,
    finding_values_included: false,
    findings_by_rule: {},
    recorded_findings: [],
    scanned_byte_count: 1,
    scanned_file_count: 1,
    skipped_large_file_count: 0,
    decode_replacement_count: 0,
    manifest_sha256: privacyCanaryManifestSha256,
  })}\n`;
  const preparationScript = "param()\n# frozen preparation source\n";
  const localInventoryReceipt = `${JSON.stringify({
    schema_version: "1",
    result: "passed",
    gateway_mode: "http",
    transport: "real_loopback_http",
    simulator_disclosure_required: "SIMULATED",
    authorized_tenant_count: 3,
    authorized_candidate_ids: ["GH-PCH-104", "ML-PCH-219", "NA-PCH-231"],
    restricted_fields_included: false,
    unauthorized_candidate_denied: true,
    unauthorized_tenant_denied: true,
  })}\n`;
  const localPreparationReceipt = `${JSON.stringify({
    schema_version: "2",
    status: "PREPARED_FOR_ANALYSIS",
    canonical: false,
    preparation_script_sha256: sha256(preparationScript),
    case_id: "FR-20260829-0042",
    case_state: "RECEIVED",
    analyst_mode: "fixture",
    inventory_mode: "http",
    inventory_gateway_ready: true,
    repository: "memory",
    evidence_store: "memory",
    tasks_mode: "inline",
    relay_mode: "http",
    app_environment: "development",
    runtime_roles_authenticated: true,
    staff_actor_id: "staff.northport",
    supervisor_actor_id: "supervisor.northport",
    simulator_disclosure: "SIMULATED",
    simulator_environment: "development",
    reset_event_count: 1,
    evidence: {
      source_file: "pouch-front.jpg",
      original_sha256: sha256("pouch-front-fixture"),
      preview_sha256: "a".repeat(64),
      preview_visibility: "MODEL_AUTHORIZED",
      current_epoch_record_count: 2,
      active_for_analysis: true,
      exact_retry_same_pair: true,
      changed_consent_conflict_verified: true,
    },
  })}\n`;
  const localWorkflowReceipt = `${JSON.stringify({
    schema_version: "1",
    result: "passed",
    run_id: "fixture-local-run",
    case_id: "FR-20260829-0042",
    handoff_id: "handoff-fixture",
    reservation_id: "reservation-fixture",
    manifest_id: "manifest-fixture",
    final_state: "CLOSED",
    final_version: 19,
    event_count: 19,
    first_event_hash: "b".repeat(64),
    final_event_hash: "c".repeat(64),
    hash_chain_valid: true,
    inventory_gateway_loopback_http: true,
    inventory_gateway_authorized_candidate_count: 3,
    imported_evidence_count: 2,
    imported_evidence_provenance_verified: true,
    runtime_role_probe_authenticated: true,
    runtime_staff_actor_id: "staff.northport",
    runtime_supervisor_actor_id: "supervisor.northport",
    service_projection_authoritative: true,
    token_replay_rejected: true,
    token_replay_boundary_unchanged: true,
    release_task_replayed: true,
    release_task_boundary_unchanged: true,
    manifest_internally_consistent: true,
    physical_transfer_proven: false,
    local_canonical_preparation_verified: true,
  })}\n`;
  const frozenContents = new Map([
    ["README.md", readme],
    ["LICENSE", projectLicense],
    ["NOTICE.md", projectNotice],
    ["THIRD_PARTY_NOTICES.md", thirdPartyNotices],
    ["package.json", '{"name":"found-roll","license":"MIT"}\n'],
    ["package-lock.json", "{}\n"],
    ["public/legal/FOUND-ROLL-LICENSE.txt", hostedLicense],
    ["public/legal/THIRD-PARTY-LICENSES.txt", hostedThirdPartyLicenses],
    ["service/requirements.lock", "service-runtime==1\n"],
    ["service/requirements-dev.lock", "service-dev==1\n"],
    ["simulator/requirements.lock", "simulator-runtime==1\n"],
    ["simulator/requirements-dev.lock", "simulator-dev==1\n"],
    ["public/assets/README.md", "# Synthetic fixture media\n"],
    ["public/assets/claimant-match.jpg", "claimant-match-fixture"],
    ["public/assets/northport-intake.jpg", "northport-intake-fixture"],
    ["public/assets/pouch-front.jpg", "pouch-front-fixture"],
    ["public/assets/pouch-interior.jpg", "pouch-interior-fixture"],
    ["public/assets/pouch-rear.jpg", "pouch-rear-fixture"],
    ["public/assets/pouch-serial-detail.jpg", "pouch-serial-detail-fixture"],
    ["evaluation/fixtures.json", localFixtureManifestRaw],
    ["evaluation/privacy-canaries.json", privacyCanaryManifest],
    ["evaluation/results.json", localEvaluationRaw],
    ["evaluation/privacy-scan-results.json", localPrivacyScanReceipt],
    ["evaluation/privacy-scan-docs-results.json", localPrivacyScanReceipt],
    ["artifacts/verification/inventory-gateway-http-smoke-receipt.json", localInventoryReceipt],
    ["artifacts/verification/local-canonical-preparation-receipt.json", localPreparationReceipt],
    ["artifacts/verification/service-client-http-smoke-receipt.json", localWorkflowReceipt],
    ["artifacts/verification/frontend-build-manifest.json", frontendManifestRaw],
    ["scripts/prepare-canonical-run.ps1", preparationScript],
    ["docs/architecture.md", architectureDocument],
    ["docs/architecture-diagram.mmd", architectureSource],
    ["docs/architecture-diagram.png", architectureRender],
    ["docs/deployment.md", deploymentDocument],
    ["docs/devpost-submission.md", "# Devpost copy\nCanonical evidence is attached.\n"],
    ["docs/demo-script.md", "# Demo script\nContinuous live run.\n"],
  ]);
  frozenContents.set("docs/architecture-diagram.manifest.json", `${JSON.stringify({
    schema_version: "1",
    source_sha256: sha256(architectureSource),
    render_sha256: sha256(architectureRender),
    width: 960,
    height: 540,
  })}\n`);
  const frozenFiles = [];
  for (const [relativePath, content] of frozenContents) {
    const absolute = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    frozenFiles.push({ path: relativePath, sha256: sha256(content) });
  }

  const commit = "1".repeat(40);
  const tree = "2".repeat(40);
  const runIds = Array.from({ length: 5 }, (_value, index) => `canonical-run-00${index + 1}`);
  const privacyReceipt = {
    schema_version: "1",
    kind: "found-roll-canonical-privacy",
    status: "PASS",
    submitted_commit: commit,
    run_ids: runIds,
    unresolved_findings: 0,
    binary_media_review_confirmed: true,
    raw_sensitive_content_included: false,
    log_trace_ranges_covered: true,
  };
  const privacyPath = path.join(repoRoot, "artifacts", "private", "canonical-privacy-receipt.json");
  const privacyFile = await writeJson(privacyPath, privacyReceipt);
  const fixtureDigest = frozenFiles.find((binding) => binding.path === "evaluation/fixtures.json").sha256;
  const frontendDigest = frozenFiles.find((binding) => binding.path === "artifacts/verification/frontend-build-manifest.json").sha256;
  const preparationScriptDigest = frozenFiles.find((binding) => binding.path === "scripts/prepare-canonical-run.ps1").sha256;
  const pouchFrontDigest = frozenFiles.find((binding) => binding.path === "public/assets/pouch-front.jpg").sha256;
  const preparationReceipts = [];
  const runReceipts = [];
  const chainAudits = [];
  const canonicalRuns = [];
  const preparationPaths = [];
  const runPaths = [];
  const chainAuditPaths = [];
  for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
    const workflowEpoch = `epoch-20260829-0042-${ordinal}`;
    const preparationReceipt = validPreparationReceipt(versions, workflowEpoch);
    preparationReceipt.prepared_at = `2026-08-29T20:0${ordinal}:00Z`;
    preparationReceipt.preparation_script_sha256 = preparationScriptDigest;
    preparationReceipt.evidence.original_id = `evd-original-0042-${ordinal}`;
    preparationReceipt.evidence.preview_id = `evd-preview-0042-${ordinal}`;
    preparationReceipt.evidence.active_pair_ids = [
      preparationReceipt.evidence.original_id,
      preparationReceipt.evidence.preview_id,
    ];
    preparationReceipt.evidence.original_sha256 = pouchFrontDigest;
    const preparationRelative = `artifacts/private/canonical-preparation-${ordinal}.json`;
    const preparationPath = path.join(repoRoot, preparationRelative);
    const preparationFile = await writeJson(preparationPath, preparationReceipt);
    const runReceipt = validRunReceipt({
      commit,
      tree,
      versions,
      runId: runIds[ordinal - 1],
      ordinal,
      workflowEpoch,
      preparationDigest: preparationFile.digest,
      fixtureDigest,
      privacyDigest: privacyFile.digest,
      frontendDigest,
    });
    const chainAudit = makeChainAudit({
      runReceipt,
      preparationReceipt,
      commit,
      tree,
      ordinal,
    });
    const runRelative = `artifacts/private/canonical-run-${ordinal}.json`;
    const runPath = path.join(repoRoot, runRelative);
    const runFile = await writeJson(runPath, runReceipt);
    const chainAuditRelative = `artifacts/private/canonical-chain-audit-${ordinal}.json`;
    const chainAuditPath = path.join(repoRoot, chainAuditRelative);
    const chainAuditFile = await writeJson(chainAuditPath, chainAudit);
    preparationReceipts.push(preparationReceipt);
    runReceipts.push(runReceipt);
    chainAudits.push(chainAudit);
    preparationPaths.push(preparationPath);
    runPaths.push(runPath);
    chainAuditPaths.push(chainAuditPath);
    canonicalRuns.push({
      run_id: runIds[ordinal - 1],
      ordinal,
      preparation_path: preparationRelative,
      preparation_sha256: preparationFile.digest,
      run_path: runRelative,
      run_sha256: runFile.digest,
      chain_audit_path: chainAuditRelative,
      chain_audit_sha256: chainAuditFile.digest,
    });
  }
  const cleanBrowserReceipt = {
    schema_version: "1",
    kind: "found-roll-clean-browser",
    status: "PASS",
    verified_at_utc: "2026-08-29T20:30:00Z",
    submitted_commit: commit,
    hosted_url: "https://found-roll.web.app",
    app_revision: "found-roll-app-00042-abc",
    simulator_revision: "found-roll-simulator-00042-def",
    frontend_manifest_sha256: frontendDigest,
    judge_access_verified: true,
    current_rendered_design_verified: true,
  };
  const cleanBrowserPath = path.join(repoRoot, "artifacts", "private", "clean-browser-receipt.json");
  const cleanBrowserFile = await writeJson(cleanBrowserPath, cleanBrowserReceipt);
  const record = {
    schema_version: "2",
    kind: "found-roll-submission-release",
    status: "FROZEN",
    created_at_utc: "2026-08-29T21:00:00Z",
    category: "Taskmaster",
    eligibility: {
      entrant_eligible_confirmed: true,
      team_eligibility_confirmed: true,
      official_rules_accepted_confirmed: true,
      ownership_confirmed: true,
      third_party_authorizations_confirmed: true,
      new_project_confirmed: true,
    },
    friction_story: {
      mode: "research_informed",
      truthful_mode_confirmed: true,
    },
    google_cloud: {
      project_id: "found-roll-demo-123",
      dedicated_project_confirmed: true,
      billing_enabled_confirmed: true,
      billing_account_type: "free_trial",
      free_trial_remaining_credit_confirmed: true,
      free_trial_remaining_time_confirmed: true,
      paid_activation_absent_confirmed: true,
      cloud_run_spend_cap_confirmed: true,
      agent_platform_spend_cap_confirmed: true,
      required_apis_enabled_confirmed: true,
      iam_ready_confirmed: true,
      quota_ready_confirmed: true,
    },
    hosted_project: {
      url: "https://found-roll.web.app",
      clean_browser_verified: true,
      judge_access_verified: true,
    },
    repository: {
      url: "https://github.com/example/found-roll",
      commit_sha: commit,
      tree_sha: tree,
      release_tag: "submission-v1",
      visibility: "public",
      judge_access_verified: true,
      testing_devpost_access_confirmed: false,
      google_hackathons_access_confirmed: false,
      release_tag_published_confirmed: true,
    },
    receipts: {
      canonical_runs: canonicalRuns,
      canonical_privacy_path: "artifacts/private/canonical-privacy-receipt.json",
      canonical_privacy_sha256: privacyFile.digest,
      clean_browser_path: "artifacts/private/clean-browser-receipt.json",
      clean_browser_sha256: cleanBrowserFile.digest,
    },
    frozen_contracts: {
      prompt: {
        version: versions.prompt,
        source_path: sourcePaths.prompt,
        source_sha256: sha256(sourceContents.prompt),
      },
      output_schema: {
        version: versions.output_schema,
        source_path: sourcePaths.output_schema,
        source_sha256: sha256(sourceContents.output_schema),
      },
      policy: {
        version: versions.policy,
        source_path: sourcePaths.policy,
        source_sha256: sha256(sourceContents.policy),
      },
    },
    frozen_files: frozenFiles,
    frontend_artifact: {
      path: "artifacts/verification/frontend-build-manifest.json",
      sha256: frontendDigest,
    },
    video: {
      url: "https://www.youtube.com/watch?v=foundroll0042",
      duration_seconds: 215,
      canonical_run_id: runIds[0],
      public_confirmed: true,
      english_audio_or_subtitles_confirmed: true,
      visible_google_cloud_confirmed: true,
      unedited_continuous_live_run_confirmed: true,
      privacy_review_confirmed: true,
    },
    publication_review: {
      current_rendered_design_qa_confirmed: true,
      publication_review_confirmed: true,
      repository_privacy_review_confirmed: true,
      binary_media_review_confirmed: true,
      claims_disclosures_consistent_confirmed: true,
      synthetic_data_only_confirmed: true,
    },
    license: {
      decision: "open_source",
      spdx_identifier: "MIT",
    },
  };
  const recordPath = path.join(repoRoot, "artifacts", "private", "submission-release.json");
  await writeJson(recordPath, record);
  const gitState = {
    available: true,
    headCommit: commit,
    headTree: tree,
    tagCommit: commit,
    tagTree: tree,
    remoteUrls: ["git@github.com:example/found-roll.git"],
    remotePushUrls: ["git@github.com:example/found-roll.git"],
    privateArtifactsSafe: true,
    clean: true,
  };
  return {
    repoRoot,
    record,
    recordPath,
    gitState,
    preparationReceipts,
    runReceipts,
    chainAudits,
    preparationPaths,
    runPaths,
    chainAuditPaths,
    privacyReceipt,
    privacyPath,
    cleanBrowserReceipt,
    cleanBrowserPath,
  };
}

function failureCodes(result) {
  return new Set(result.failures.map((failure) => failure.code));
}

test("a fully bound offline release record passes without network activity", async (t) => {
  const fixture = await createFixture(t);
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.deepEqual(result, { ok: true, failures: [] });
});

test("cloud readiness requires an active free trial and both service spend caps", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.google_cloud.billing_account_type = "paid";
  let result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("FREE_TRIAL_REQUIRED"), true);

  fixture.record.google_cloud.billing_account_type = "free_trial";
  for (const field of [
    "free_trial_remaining_credit_confirmed",
    "free_trial_remaining_time_confirmed",
    "paid_activation_absent_confirmed",
    "cloud_run_spend_cap_confirmed",
    "agent_platform_spend_cap_confirmed",
  ]) {
    fixture.record.google_cloud[field] = false;
    result = await verifySubmissionReadiness(fixture.record, fixture);
    assert.equal(
      result.failures.some((failure) => failure.code === "CONFIRMATION_REQUIRED" && failure.message.includes(`google_cloud.${field}`)),
      true,
      `${field} must fail closed`,
    );
    fixture.record.google_cloud[field] = true;
  }

  delete fixture.record.google_cloud.agent_platform_spend_cap_confirmed;
  result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(
    result.failures.some((failure) => failure.code === "RECORD_MISSING_FIELD" && failure.message.includes("google_cloud.agent_platform_spend_cap_confirmed")),
    true,
  );
});

test("human confirmations, URLs, duration, placeholders, and Git state fail together", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.eligibility.ownership_confirmed = false;
  fixture.record.google_cloud.billing_enabled_confirmed = false;
  fixture.record.hosted_project.url = "http://localhost:8080";
  fixture.record.repository.url = "https://example.com/private/repo";
  fixture.record.video.duration_seconds = 241;
  fixture.record.publication_review.current_rendered_design_qa_confirmed = false;
  fixture.record.license.decision = "unset";
  fixture.gitState.clean = false;
  fixture.gitState.headCommit = "2".repeat(40);
  await writeFile(path.join(fixture.repoRoot, "docs", "blocked.md"), "[SUBMISSION BLOCKER: fill after publication]\n", "utf8");

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(result.ok, false);
  for (const code of ["CONFIRMATION_REQUIRED", "HTTPS_URL_REQUIRED", "VIDEO_DURATION", "LICENSE_DECISION", "SUBMISSION_PLACEHOLDER", "HEAD_MISMATCH", "REMOTE_MISMATCH", "WORKTREE_DIRTY"]) {
    assert.equal(codes.has(code), true, `missing ${code}`);
  }
});

test("receipt digests, canonical modes, completion status, and frozen source hashes fail closed", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.receipts.canonical_runs[0].preparation_sha256 = "0".repeat(64);
  fixture.runReceipts[0].status = "PREPARED_FOR_ANALYSIS";
  fixture.runReceipts[0].production.analyst_mode = "fixture";
  const rewrittenRun = await writeJson(fixture.runPaths[0], fixture.runReceipts[0]);
  fixture.record.receipts.canonical_runs[0].run_sha256 = rewrittenRun.digest;
  await appendFile(path.join(fixture.repoRoot, "service", "app", "agent_contract.py"), "# drift\n", "utf8");

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("RECEIPT_DIGEST_MISMATCH"), true);
  assert.equal(codes.has("CANONICAL_RECEIPT_MODE"), true);
  assert.equal(codes.has("CONTRACT_SOURCE_DIGEST_MISMATCH"), true);
});

test("secret-bearing receipt fields and values are rejected without echoing them", async (t) => {
  const fixture = await createFixture(t);
  const secretValue = "frcl_never-print-this-value";
  fixture.runReceipts[0].claimant_token = secretValue;
  fixture.runReceipts[0].answer_digest = "e".repeat(64);
  fixture.runReceipts[0].staff_snapshot = { case_id: "FR-20260829-0042" };
  fixture.runReceipts[0].external_url = `https://storage.example.com/object?X-Goog-Signature=${secretValue}`;
  const rewrittenRun = await writeJson(fixture.runPaths[0], fixture.runReceipts[0]);
  fixture.record.receipts.canonical_runs[0].run_sha256 = rewrittenRun.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const output = formatReadinessResult(result);
  assert.equal(result.ok, false);
  assert.equal(failureCodes(result).has("SENSITIVE_FIELD"), true);
  assert.equal(failureCodes(result).has("SENSITIVE_VALUE"), true);
  assert.equal(failureCodes(result).has("RICH_ARTIFACT_CONTENT"), true);
  assert.equal(output.includes(secretValue), false);
});

test("record-supplied frozen paths cannot leak secret-looking filenames", async (t) => {
  const fixture = await createFixture(t);
  const secretValue = "frcl_never-print-this-value";
  fixture.record.frozen_files[0].path = `docs/${secretValue}.md`;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const output = formatReadinessResult(result);
  assert.equal(result.ok, false);
  assert.equal(output.includes(secretValue), false);
  assert.equal(failureCodes(result).has("FROZEN_FILE_UNREADABLE"), true);
});

test("five canonical runs require unique preparations, fixed revisions, and a filmed member", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.receipts.canonical_runs[4].run_id = fixture.record.receipts.canonical_runs[0].run_id;
  fixture.preparationReceipts[4].workflow_epoch = fixture.preparationReceipts[0].workflow_epoch;
  const rewrittenPreparation = await writeJson(fixture.preparationPaths[4], fixture.preparationReceipts[4]);
  fixture.record.receipts.canonical_runs[4].preparation_sha256 = rewrittenPreparation.digest;
  fixture.runReceipts[4].workflow_epoch = fixture.preparationReceipts[0].workflow_epoch;
  fixture.runReceipts[4].preparation_receipt_sha256 = rewrittenPreparation.digest;
  fixture.runReceipts[4].app_revision = "found-roll-app-drifted-999";
  const rewrittenRun = await writeJson(fixture.runPaths[4], fixture.runReceipts[4]);
  fixture.record.receipts.canonical_runs[4].run_sha256 = rewrittenRun.digest;
  fixture.record.video.canonical_run_id = "canonical-run-not-present";

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("CANONICAL_RUN_UNIQUENESS"), true);
  assert.equal(codes.has("CANONICAL_REVISION_DRIFT"), true);
  assert.equal(codes.has("VIDEO_RUN_BINDING"), true);
});

test("cloud, trajectory, closure, and privacy proof cannot be reduced to a pass label", async (t) => {
  const fixture = await createFixture(t);
  const run = fixture.runReceipts[0];
  run.production.tasks_mode = "inline";
  run.live_agent.tool_trajectory = [{ name: "request_manual_review", outcome: "success" }];
  run.cloud_boundary.task_delivery_attempts = 1;
  run.cloud_boundary.task_duplicate_side_effect_delta = 1;
  run.closure.manual_datastore_repair = true;
  run.privacy.unresolved_findings = 1;
  const rewrittenRun = await writeJson(fixture.runPaths[0], run);
  fixture.record.receipts.canonical_runs[0].run_sha256 = rewrittenRun.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("CANONICAL_RECEIPT_MODE"), true);
  assert.equal(codes.has("LIVE_AGENT_TRAJECTORY"), true);
  assert.equal(codes.has("CLOUD_DUPLICATE_PROOF"), true);
  assert.equal(codes.has("CANONICAL_PRIVACY"), true);
});

test("a hash-bound chain audit is recomputed instead of trusted by label", async (t) => {
  const fixture = await createFixture(t);
  fixture.chainAudits[0].events[5].reason = "Tampered after the service hash was issued.";
  const rewritten = await writeJson(fixture.chainAuditPaths[0], fixture.chainAudits[0]);
  fixture.record.receipts.canonical_runs[0].chain_audit_sha256 = rewritten.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(result.ok, false);
  assert.equal(failureCodes(result).has("CHAIN_AUDIT_HASH"), true);
});

test("a fully rehashed chain cannot substitute a semantically false custody trajectory", async (t) => {
  const fixture = await createFixture(t);
  const audit = fixture.chainAudits[0];
  const run = fixture.runReceipts[0];
  for (const event of audit.events) {
    event.from_state = "RECEIVED";
    event.to_state = "RECEIVED";
  }
  refreshChainAuditBindings(audit, run);
  const rewrittenRun = await writeJson(fixture.runPaths[0], run);
  fixture.record.receipts.canonical_runs[0].run_sha256 = rewrittenRun.digest;
  const rewrittenAudit = await writeJson(fixture.chainAuditPaths[0], audit);
  fixture.record.receipts.canonical_runs[0].chain_audit_sha256 = rewrittenAudit.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(result.ok, false);
  assert.equal(codes.has("CHAIN_AUDIT_TRAJECTORY"), true);
  assert.equal(codes.has("CHAIN_AUDIT_HASH"), false);
  assert.equal(codes.has("CHAIN_AUDIT_MANIFEST"), false);
});

test("the frontend manifest must exactly cover the current build tree", async (t) => {
  const fixture = await createFixture(t);
  await appendFile(path.join(fixture.repoRoot, "dist", "client", "assets", "app.js"), "drift\n", "utf8");

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(result.ok, false);
  assert.equal(failureCodes(result).has("FRONTEND_BUILD_DRIFT"), true);
});

test("reserved public origins, insecure remotes, and unsafe private Git artifacts fail closed", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.hosted_project.url = "https://found-roll.example.com";
  fixture.gitState.remoteUrls = ["file:///tmp/found-roll"];
  fixture.gitState.remotePushUrls = ["file:///tmp/found-roll"];
  fixture.gitState.privateArtifactsSafe = false;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("HTTPS_URL_REQUIRED"), true);
  assert.equal(codes.has("REMOTE_MISMATCH"), true);
  assert.equal(codes.has("PRIVATE_ARTIFACT_GIT_STATE"), true);
});

test("loopback, private, documentation, and reserved-name HTTPS origins are not public proof", async (t) => {
  const fixture = await createFixture(t);
  for (const origin of [
    "https://127.0.0.1",
    "https://10.12.0.4",
    "https://[::1]",
    "https://203.0.113.42",
    "https://found-roll.test",
  ]) {
    fixture.record.hosted_project.url = origin;
    const result = await verifySubmissionReadiness(fixture.record, fixture);
    assert.equal(failureCodes(result).has("HTTPS_URL_REQUIRED"), true, origin);
  }
});

test("frozen local evidence must match current bytes and retain its truthful incomplete boundary", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.repoRoot, "evaluation", "results.json"),
    '{"status":"CANONICAL_PASS","fixture_count":15,"passed_count":15,"failed_count":0}\n',
    "utf8",
  );

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("FROZEN_FILE_DIGEST_MISMATCH"), true);
  assert.equal(codes.has("LOCAL_EVALUATION_INCOMPLETE"), true);
});

test("setup instructions and the architecture render must be substantive artifacts", async (t) => {
  const fixture = await createFixture(t);
  const shortReadme = "# Found Roll\n\nBuild notes only.\n";
  await writeFile(path.join(fixture.repoRoot, "README.md"), shortReadme, "utf8");
  fixture.record.frozen_files.find((binding) => binding.path === "README.md").sha256 = sha256(shortReadme);

  const invalidPng = Buffer.from("renamed-non-png-bytes");
  await writeFile(path.join(fixture.repoRoot, "docs", "architecture-diagram.png"), invalidPng);
  fixture.record.frozen_files.find((binding) => binding.path === "docs/architecture-diagram.png").sha256 = sha256(invalidPng);
  const manifestPath = path.join(fixture.repoRoot, "docs", "architecture-diagram.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.render_sha256 = sha256(invalidPng);
  const manifestRaw = `${JSON.stringify(manifest)}\n`;
  await writeFile(manifestPath, manifestRaw, "utf8");
  fixture.record.frozen_files.find((binding) => binding.path === "docs/architecture-diagram.manifest.json").sha256 = sha256(manifestRaw);

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("README_SETUP"), true);
  assert.equal(codes.has("ARCHITECTURE_BINDING"), true);
});

test("the bound deployment runbook must retain the zero-money retry safeguards", async (t) => {
  const fixture = await createFixture(t);
  const deploymentPath = path.join(fixture.repoRoot, "docs", "deployment.md");
  const deployment = await readFile(deploymentPath, "utf8");
  const unboundedDeployment = deployment.replaceAll("--max-retry-duration=1s", "--max-retry-duration=0s");
  assert.notEqual(unboundedDeployment, deployment);
  await writeFile(deploymentPath, unboundedDeployment, "utf8");
  fixture.record.frozen_files.find((binding) => binding.path === "docs/deployment.md").sha256 = sha256(unboundedDeployment);

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("DEPLOYMENT_SETUP"), true);
});

test("local privacy receipts must bind the current canary manifest", async (t) => {
  const fixture = await createFixture(t);
  const receiptPath = path.join(fixture.repoRoot, "evaluation", "privacy-scan-results.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.manifest_sha256 = "f".repeat(64);
  const rewritten = await writeJson(receiptPath, receipt);
  fixture.record.frozen_files.find((binding) => binding.path === "evaluation/privacy-scan-results.json").sha256 = rewritten.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("LOCAL_PRIVACY_CANARY_BINDING"), true);
});

test("local evaluation proof requires every unique frozen fixture row", async (t) => {
  const fixture = await createFixture(t);
  const evaluationPath = path.join(fixture.repoRoot, "evaluation", "results.json");
  const evaluation = JSON.parse(await readFile(evaluationPath, "utf8"));
  evaluation.results = evaluation.results.slice(0, 14);
  const rewritten = await writeJson(evaluationPath, evaluation);
  fixture.record.frozen_files.find((binding) => binding.path === "evaluation/results.json").sha256 = rewritten.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("LOCAL_EVALUATION_INCOMPLETE"), true);
});

test("local workflow proof binds its preparation and inventory receipts", async (t) => {
  const fixture = await createFixture(t);
  const preparationPath = path.join(fixture.repoRoot, "artifacts", "verification", "local-canonical-preparation-receipt.json");
  const preparation = JSON.parse(await readFile(preparationPath, "utf8"));
  preparation.case_id = "FR-different-local-case";
  const rewritten = await writeJson(preparationPath, preparation);
  fixture.record.frozen_files.find((binding) => binding.path === "artifacts/verification/local-canonical-preparation-receipt.json").sha256 = rewritten.digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("LOCAL_WORKFLOW_INCOMPLETE"), true);
});

test("private repository mode requires both official judge accounts while public mode forbids the flags", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.repository.visibility = "private";
  let result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("CONFIRMATION_REQUIRED"), true);

  fixture.record.repository.visibility = "public";
  fixture.record.repository.testing_devpost_access_confirmed = true;
  fixture.record.repository.google_hackathons_access_confirmed = true;
  result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("REPOSITORY_VISIBILITY"), true);
});

test("the intentionally failing JSON template is excluded from Markdown scanning", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.repoRoot, "docs", "submission-release.template.json"),
    '{"note":"[SUBMISSION BLOCKER: template stays false]"}\n',
    "utf8",
  );
  let result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(result.ok, true);

  await writeFile(path.join(fixture.repoRoot, "docs", "submission.md"), "TODO: replace this entire block\n", "utf8");
  result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("SUBMISSION_PLACEHOLDER"), true);
});

test("the checked release template intentionally fails until populated", async (t) => {
  const fixture = await createFixture(t);
  const template = JSON.parse(await readFile(path.join(projectRoot, "docs", "submission-release.template.json"), "utf8"));
  const result = await verifySubmissionReadiness(template, fixture);
  assert.equal(result.ok, false);
  assert.equal(failureCodes(result).has("CONFIRMATION_REQUIRED"), true);
  assert.equal(failureCodes(result).has("IDENTIFIER_REQUIRED"), true);
  assert.equal(failureCodes(result).has("VIDEO_DURATION"), true);
});

test("all private receipt templates parse and remain explicitly blocked", async () => {
  const templates = [
    ["canonical-run.template.json", "found-roll-canonical-run"],
    ["canonical-privacy.template.json", "found-roll-canonical-privacy"],
    ["clean-browser.template.json", "found-roll-clean-browser"],
    ["chain-audit.template.json", "found-roll-chain-audit"],
  ];
  for (const [filename, kind] of templates) {
    const template = JSON.parse(await readFile(path.join(projectRoot, "docs", filename), "utf8"));
    assert.equal(template.kind, kind);
    assert.equal(template.status, "BLOCKED");
  }
});

function git(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("the CLI binds HEAD, local tag, configured remote, and a clean worktree", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.repoRoot, ".gitignore"), "artifacts/private/\n", "utf8");
  git(fixture.repoRoot, ["init", "-q"]);
  git(fixture.repoRoot, ["config", "user.email", "release-test@example.test"]);
  git(fixture.repoRoot, ["config", "user.name", "Release Test"]);
  git(fixture.repoRoot, ["add", "."]);
  git(fixture.repoRoot, ["commit", "-qm", "frozen source"]);
  const headCommit = git(fixture.repoRoot, ["rev-parse", "HEAD"]);
  const headTree = git(fixture.repoRoot, ["rev-parse", "HEAD^{tree}"]);
  git(fixture.repoRoot, ["tag", "submission-v1"]);
  git(fixture.repoRoot, ["remote", "add", "origin", "git@github.com:example/found-roll.git"]);

  fixture.record.repository.commit_sha = headCommit;
  fixture.record.repository.tree_sha = headTree;
  fixture.privacyReceipt.submitted_commit = headCommit;
  const rewrittenPrivacy = await writeJson(fixture.privacyPath, fixture.privacyReceipt);
  fixture.record.receipts.canonical_privacy_sha256 = rewrittenPrivacy.digest;
  for (let index = 0; index < fixture.runReceipts.length; index += 1) {
    fixture.runReceipts[index].submitted_commit = headCommit;
    fixture.runReceipts[index].tree_sha = headTree;
    fixture.runReceipts[index].privacy.receipt_sha256 = rewrittenPrivacy.digest;
    const rewrittenRun = await writeJson(fixture.runPaths[index], fixture.runReceipts[index]);
    fixture.record.receipts.canonical_runs[index].run_sha256 = rewrittenRun.digest;
    fixture.chainAudits[index].submitted_commit = headCommit;
    fixture.chainAudits[index].tree_sha = headTree;
    const rewrittenChainAudit = await writeJson(fixture.chainAuditPaths[index], fixture.chainAudits[index]);
    fixture.record.receipts.canonical_runs[index].chain_audit_sha256 = rewrittenChainAudit.digest;
  }
  fixture.cleanBrowserReceipt.submitted_commit = headCommit;
  const rewrittenBrowser = await writeJson(fixture.cleanBrowserPath, fixture.cleanBrowserReceipt);
  fixture.record.receipts.clean_browser_sha256 = rewrittenBrowser.digest;
  await writeJson(fixture.recordPath, fixture.record);

  let cli = spawnSync(process.execPath, [
    verifierPath,
    "--repo-root",
    fixture.repoRoot,
    "--record",
    fixture.recordPath,
  ], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /SUBMISSION READINESS: PASS/);

  git(fixture.repoRoot, ["add", "-f", "artifacts/private/canonical-run-1.json"]);
  await appendFile(path.join(fixture.repoRoot, "README.md"), "dirty\n", "utf8");
  cli = spawnSync(process.execPath, [
    verifierPath,
    "--repo-root",
    fixture.repoRoot,
    "--record",
    fixture.recordPath,
  ], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /WORKTREE_DIRTY/);
  assert.match(cli.stderr, /PRIVATE_ARTIFACT_GIT_STATE/);
});
