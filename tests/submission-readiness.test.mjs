import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  formatReadinessResult,
  requiredFrozenFilePaths,
  verifyGoogleCloudPreflight,
  verifyGoogleCloudTeardownIdentity,
  verifySubmissionReadiness,
} from "../scripts/verify-submission-readiness.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = path.join(projectRoot, "scripts", "verify-submission-readiness.mjs");
const approvedEntrantAttestationText = "done free trial active, project linked minimum caps were 10 and 5 euros respectively";
const approvedEntrantAttestationSha256 = "5ab75588420cca012f174e63eba3ca05f83e88cad99f93916543a335171b6a82";

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

function refreshStorageBuildProof(receipt, { refreshAssets = false } = {}) {
  receipt.builds.sort((left, right) => left.build_resource.localeCompare(right.build_resource));
  receipt.cloud_build_inventory_sha256 = sha256(canonicalJson(receipt.builds));
  receipt.completed_build_count = receipt.builds.filter((build) => build.status === "SUCCESS").length;
  const identities = receipt.builds.map((build) => ({
    build_id: build.build_id,
    location: build.location,
    build_resource: build.build_resource,
  }));
  receipt.direct_build_identity_count = identities.length;
  receipt.direct_build_identity_inventory_sha256 = sha256(canonicalJson(identities));
  if (refreshAssets) {
    receipt.cloud_build_assets_before = structuredClone(identities);
    receipt.cloud_build_assets = structuredClone(identities);
    receipt.cloud_build_asset_snapshot_before_count = identities.length;
    receipt.cloud_build_asset_count = identities.length;
    receipt.cloud_build_asset_snapshot_before_sha256 = sha256(canonicalJson(identities));
    receipt.cloud_build_asset_inventory_sha256 = sha256(canonicalJson(identities));
    receipt.cloud_build_asset_inventory_stable = true;
  }
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
    project_id: "found-roll-agentic-20260830",
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
      evidence_bucket: "found-roll-agentic-20260830-found-roll-evidence",
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
  const nowMilliseconds = Date.now();
  const releaseCreatedAt = new Date(nowMilliseconds - 60_000).toISOString();
  const attestedAt = new Date(nowMilliseconds - 4 * 60_000).toISOString();
  const cliCheckedAt = new Date(nowMilliseconds - 2 * 60_000).toISOString();
  const attestationBatchId = "75c5ca24-1961-4ee5-a1c9-a6d847203510";
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
  const verifierSource = await readFile(path.join(projectRoot, "scripts", "verify-submission-readiness.mjs"), "utf8");
  const googleCloudResourceIdentity = await readFile(
    path.join(projectRoot, "docs", "google-cloud-resource-identity.json"),
    "utf8",
  );
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
    ["scripts/verify-submission-readiness.mjs", verifierSource],
    ["docs/architecture.md", architectureDocument],
    ["docs/architecture-diagram.mmd", architectureSource],
    ["docs/architecture-diagram.png", architectureRender],
    ["docs/google-cloud-resource-identity.json", googleCloudResourceIdentity],
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
  const billingPreflightReceipt = {
    schema_version: "2",
    kind: "found-roll-google-cloud-billing-preflight",
    status: "PASS",
    attestation_version: "found-roll-zero-real-money-v1",
    attestation_source: "entrant_direct_confirmation",
    attestation_batch_id: attestationBatchId,
    attestation_text_sha256: approvedEntrantAttestationSha256,
    attested_at_utc: attestedAt,
    cli_checked_at_utc: cliCheckedAt,
    project_id: "found-roll-agentic-20260830",
    billing_account_name_sha256: "a".repeat(64),
    account_type: "free_trial",
    billing_enabled_cli_observed: true,
    billing_account_open_cli_observed: true,
    remaining_credit_greater_than_zero: true,
    remaining_time_greater_than_zero: true,
    paid_activation_absent: true,
    no_paid_upgrade_or_payment_during_release_confirmed: true,
    entrant_attestation_confirmed: true,
  };
  const cloudRunSpendCapReceipt = {
    schema_version: "2",
    kind: "found-roll-google-cloud-spend-cap-preflight",
    status: "PASS",
    attestation_version: "found-roll-zero-real-money-v1",
    attestation_source: "entrant_direct_confirmation",
    attestation_batch_id: attestationBatchId,
    attestation_text_sha256: approvedEntrantAttestationSha256,
    attested_at_utc: attestedAt,
    project_id: "found-roll-agentic-20260830",
    service_target: "cloud_run",
    cap_status: "CONFIGURED",
    cap_amount_minor_units: 1000,
    cap_currency: "EUR",
    project_scope_confirmed: true,
    service_scope_confirmed: true,
    lowest_practical_demo_target_confirmed: true,
    no_cap_change_during_release_confirmed: true,
    entrant_attestation_confirmed: true,
  };
  const agentPlatformSpendCapReceipt = {
    ...cloudRunSpendCapReceipt,
    service_target: "agent_platform",
    cap_amount_minor_units: 500,
  };
  const billingPreflightPath = path.join(repoRoot, "artifacts", "private", "billing-overview-receipt.json");
  const cloudRunSpendCapPath = path.join(repoRoot, "artifacts", "private", "cloud-run-spend-cap-receipt.json");
  const agentPlatformSpendCapPath = path.join(repoRoot, "artifacts", "private", "agent-platform-spend-cap-receipt.json");
  const billingPreflightFile = await writeJson(billingPreflightPath, billingPreflightReceipt);
  const cloudRunSpendCapFile = await writeJson(cloudRunSpendCapPath, cloudRunSpendCapReceipt);
  const agentPlatformSpendCapFile = await writeJson(agentPlatformSpendCapPath, agentPlatformSpendCapReceipt);
  const appSourceRevision = "found-roll-app-00042-abc";
  const canonicalAppRevision = "found-roll-app-00043-ghi";
  const simulatorSourceRevision = "found-roll-simulator-00042-def";
  const projectId = "found-roll-agentic-20260830";
  const projectNumber = "1061926987746";
  const region = "us-central1";
  const appOrigin = "https://found-roll-api-abc.a.run.app";
  const simulatorOrigin = "https://found-roll-sim-abc.a.run.app";
  const appServiceResource = `projects/${projectNumber}/locations/${region}/services/found-roll-app`;
  const simulatorServiceResource = `projects/${projectNumber}/locations/${region}/services/found-roll-simulator`;
  const appImageDigest = `sha256:${"a".repeat(64)}`;
  const simulatorImageDigest = `sha256:${"b".repeat(64)}`;
  const repositoryUri = "us-central1-docker.pkg.dev/found-roll-agentic-20260830/cloud-run-source-deploy";
  const appImagePackage = `${repositoryUri}/found-roll-app`;
  const simulatorImagePackage = `${repositoryUri}/found-roll-simulator`;
  const appImageResource = `${appImagePackage}@${appImageDigest}`;
  const simulatorImageResource = `${simulatorImagePackage}@${simulatorImageDigest}`;
  const currentObjects = [{ object_id_sha256: "8".repeat(64), generation: "1735689600000000", size_bytes: 100 }];
  const allVersionObjects = structuredClone(currentObjects);
  const softDeletedObjects = [];
  const storageBucket = {
    bucket: "found-roll-agentic-20260830-found-roll-evidence",
    project_number: "1061926987746",
    ordinary_bytes: 100,
    soft_deleted_bytes: 0,
    current_object_count: 1,
    all_version_object_count: 1,
    soft_deleted_object_count: 0,
    versioning_enabled: false,
    retention_policy_seconds: 0,
    soft_delete_seconds: 0,
    current_object_inventory_sha256: sha256(canonicalJson(currentObjects)),
    all_version_object_inventory_sha256: sha256(canonicalJson(allVersionObjects)),
    soft_deleted_object_inventory_sha256: sha256(canonicalJson(softDeletedObjects)),
    current_objects: currentObjects,
    all_version_objects: allVersionObjects,
    soft_deleted_objects: softDeletedObjects,
  };
  const appBuild = {
    build_id: "build-app-00042",
    location: "global",
    build_resource: `projects/${projectNumber}/locations/global/builds/build-app-00042`,
    status: "SUCCESS",
    created_at_utc: new Date(nowMilliseconds - 42 * 60_000).toISOString(),
    finished_at_utc: new Date(nowMilliseconds - 41 * 60_000).toISOString(),
    source_location_sha256: "d".repeat(64),
    image_digests: [appImageDigest],
    image_resources: [appImageResource],
  };
  const simulatorBuild = {
    build_id: "build-simulator-00042",
    location: "us-central1",
    build_resource: `projects/${projectNumber}/locations/us-central1/builds/build-simulator-00042`,
    status: "SUCCESS",
    created_at_utc: new Date(nowMilliseconds - 37 * 60_000).toISOString(),
    finished_at_utc: new Date(nowMilliseconds - 36 * 60_000).toISOString(),
    source_location_sha256: "e".repeat(64),
    image_digests: [simulatorImageDigest],
    image_resources: [simulatorImageResource],
  };
  const appImage = {
    repository_uri: repositoryUri,
    package: appImagePackage,
    digest: appImageDigest,
    size_bytes: 2_000,
  };
  const simulatorImage = {
    repository_uri: repositoryUri,
    package: simulatorImagePackage,
    digest: simulatorImageDigest,
    size_bytes: 3_000,
  };
  const makeStorageReceipt = ({ phase, service, revision, revisionImageDigest, revisionImageResource, sourceBuild, createdAt, observedAt, builds, images, revisionImages }) => {
    const repositories = [{
      repository: "cloud-run-source-deploy",
      location: "us-central1",
      format: "DOCKER",
      repository_uri: repositoryUri,
      artifact_count: images.length,
      artifact_size_bytes: images.reduce((sum, image) => sum + image.size_bytes, 0),
    }];
    const buildIdentities = builds.map((build) => ({
      build_id: build.build_id,
      location: build.location,
      build_resource: build.build_resource,
    }));
    const imageSizeBytes = images.reduce((sum, image) => sum + image.size_bytes, 0);
    return {
      schema_version: "1",
      kind: "found-roll-google-cloud-project-storage-audit",
      status: "PASS",
      phase,
      observed_at_utc: observedAt,
      project_id: "found-roll-agentic-20260830",
      project_number: "1061926987746",
      service,
      revision,
      revision_created_at_utc: createdAt,
      revision_image_digest: revisionImageDigest,
      revision_image_resource: revisionImageResource,
      source_deploy_build_id: sourceBuild.build_id,
      source_deploy_build_location: sourceBuild.location,
      source_deploy_build_resource: sourceBuild.build_resource,
      source_deploy_build_binding_source: "cloud-run-build-annotations",
      source_deploy_build_source_location_sha256: sourceBuild.source_location_sha256,
      maximum_bytes_exclusive: 5 * 1024 * 1024 * 1024,
      observed_bytes: storageBucket.ordinary_bytes + imageSizeBytes,
      active_bucket_inventory_sha256: sha256(canonicalJson([storageBucket])),
      soft_deleted_bucket_inventory_sha256: sha256(canonicalJson([])),
      soft_deleted_bucket_count: 0,
      cloud_build_inventory_sha256: sha256(canonicalJson(builds)),
      cloud_build_locations: ["global", "us-central1"],
      cloud_build_locations_source: "cloud-build-v2-paginated-project-locations+global",
      direct_build_identity_inventory_sha256: sha256(canonicalJson(buildIdentities)),
      direct_build_identity_count: buildIdentities.length,
      direct_build_inventory_stable: true,
      cloud_build_asset_snapshot_before_sha256: sha256(canonicalJson(buildIdentities)),
      cloud_build_asset_snapshot_before_count: buildIdentities.length,
      cloud_build_asset_inventory_sha256: sha256(canonicalJson(buildIdentities)),
      cloud_build_asset_count: buildIdentities.length,
      cloud_build_asset_inventory_exhaustive: false,
      cloud_build_asset_snapshot_before_utc: new Date(Date.parse(observedAt) - 2_000).toISOString(),
      cloud_build_asset_snapshot_after_utc: new Date(Date.parse(observedAt) - 1_000).toISOString(),
      cloud_build_asset_inventory_stable: true,
      completed_build_count: builds.length,
      build_inventory_exhaustive: true,
      artifact_repository_inventory_sha256: sha256(canonicalJson(repositories)),
      repository_count: repositories.length,
      repository_inventory_exhaustive: true,
      artifact_image_inventory_sha256: sha256(canonicalJson(images)),
      image_digest_count: images.length,
      image_size_bytes: imageSizeBytes,
      artifact_inventory_exhaustive: true,
      soft_deleted_bucket_inventory_exhaustive: true,
      soft_deleted_object_inventory_exhaustive: true,
      image_digests_and_sizes_included: true,
      buckets: [storageBucket],
      soft_deleted_buckets: [],
      builds,
      cloud_build_assets_before: structuredClone(buildIdentities),
      cloud_build_assets: structuredClone(buildIdentities),
      artifact_repositories: repositories,
      artifact_images: images,
      revision_images: revisionImages,
    };
  };
  const appStorageReceipt = makeStorageReceipt({
    phase: "after_app_source_deploy",
    service: "found-roll-app",
    revision: appSourceRevision,
    revisionImageDigest: appImageDigest,
    revisionImageResource: appImageResource,
    sourceBuild: appBuild,
    createdAt: new Date(nowMilliseconds - 40 * 60_000).toISOString(),
    observedAt: new Date(nowMilliseconds - 39 * 60_000).toISOString(),
    builds: [appBuild],
    images: [appImage],
    revisionImages: [{ service: "found-roll-app", revision: appSourceRevision, image_digest: appImageDigest, image_package: appImagePackage, image_resource: appImageResource }],
  });
  const simulatorStorageReceipt = makeStorageReceipt({
    phase: "after_simulator_source_deploy",
    service: "found-roll-simulator",
    revision: simulatorSourceRevision,
    revisionImageDigest: simulatorImageDigest,
    revisionImageResource: simulatorImageResource,
    sourceBuild: simulatorBuild,
    createdAt: new Date(nowMilliseconds - 35 * 60_000).toISOString(),
    observedAt: new Date(nowMilliseconds - 34 * 60_000).toISOString(),
    builds: [appBuild, simulatorBuild],
    images: [appImage, simulatorImage],
    revisionImages: [
      { service: "found-roll-app", revision: appSourceRevision, image_digest: appImageDigest, image_package: appImagePackage, image_resource: appImageResource },
      { service: "found-roll-simulator", revision: simulatorSourceRevision, image_digest: simulatorImageDigest, image_package: simulatorImagePackage, image_resource: simulatorImageResource },
    ],
  });
  const appStoragePath = path.join(repoRoot, "artifacts", "private", "storage-after-app-source-deploy.json");
  const simulatorStoragePath = path.join(
    repoRoot,
    "artifacts",
    "private",
    "storage-after-simulator-source-deploy.json",
  );
  const appStorageFile = await writeJson(appStoragePath, appStorageReceipt);
  const simulatorStorageFile = await writeJson(simulatorStoragePath, simulatorStorageReceipt);
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
    const preparedMilliseconds = nowMilliseconds - (31 - ordinal * 3) * 60_000;
    preparationReceipt.prepared_at = new Date(preparedMilliseconds).toISOString();
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
    runReceipt.started_at_utc = new Date(preparedMilliseconds + 30_000).toISOString();
    runReceipt.ended_at_utc = new Date(preparedMilliseconds + 90_000).toISOString();
    runReceipt.app_revision = canonicalAppRevision;
    runReceipt.simulator_revision = simulatorSourceRevision;
    const chainAudit = makeChainAudit({
      runReceipt,
      preparationReceipt,
      commit,
      tree,
      ordinal,
    });
    chainAudit.events.forEach((event, eventIndex) => {
      event.occurred_at = new Date(preparedMilliseconds + 32_000 + eventIndex * 2_000).toISOString();
    });
    refreshChainAuditBindings(chainAudit, runReceipt);
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
    verified_at_utc: new Date(nowMilliseconds - 10 * 60_000).toISOString(),
    submitted_commit: commit,
    hosted_url: "https://found-roll.web.app",
    app_revision: canonicalAppRevision,
    simulator_revision: simulatorSourceRevision,
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
    created_at_utc: releaseCreatedAt,
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
      project_id: "found-roll-agentic-20260830",
      project_number: "1061926987746",
      project_created_at_utc: "2026-08-29T22:58:52.064Z",
      evidence_bucket: "found-roll-agentic-20260830-found-roll-evidence",
      dedicated_project_confirmed: true,
      dedicated_project_label_key: "found-roll-purpose",
      dedicated_project_label_value: "dedicated-hackathon-demo",
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
      resource_identity: {
        path: "docs/google-cloud-resource-identity.json",
        sha256: sha256(googleCloudResourceIdentity),
      },
      canonical_revision_images: {
        app: {
          project_id: projectId,
          project_number: projectNumber,
          region,
          service: "found-roll-app",
          service_resource: appServiceResource,
          origin: appOrigin,
          revision: canonicalAppRevision,
          revision_resource: `${appServiceResource}/revisions/${canonicalAppRevision}`,
          revision_created_at_utc: new Date(nowMilliseconds - 30 * 60_000).toISOString(),
          image_digest: appImageDigest,
          image_package: appImagePackage,
          image_resource: appImageResource,
        },
        simulator: {
          project_id: projectId,
          project_number: projectNumber,
          region,
          service: "found-roll-simulator",
          service_resource: simulatorServiceResource,
          origin: simulatorOrigin,
          revision: simulatorSourceRevision,
          revision_resource: `${simulatorServiceResource}/revisions/${simulatorSourceRevision}`,
          revision_created_at_utc: simulatorStorageReceipt.revision_created_at_utc,
          image_digest: simulatorImageDigest,
          image_package: simulatorImagePackage,
          image_resource: simulatorImageResource,
        },
      },
      project_storage_receipts: {
        after_app_source_deploy: {
          path: "artifacts/private/storage-after-app-source-deploy.json",
          sha256: appStorageFile.digest,
        },
        after_simulator_source_deploy: {
          path: "artifacts/private/storage-after-simulator-source-deploy.json",
          sha256: simulatorStorageFile.digest,
        },
      },
      preflight_receipts: {
        billing_overview: {
          path: "artifacts/private/billing-overview-receipt.json",
          sha256: billingPreflightFile.digest,
        },
        cloud_run_spend_cap: {
          path: "artifacts/private/cloud-run-spend-cap-receipt.json",
          sha256: cloudRunSpendCapFile.digest,
        },
        agent_platform_spend_cap: {
          path: "artifacts/private/agent-platform-spend-cap-receipt.json",
          sha256: agentPlatformSpendCapFile.digest,
        },
      },
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
    nowMilliseconds,
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
    billingPreflightReceipt,
    billingPreflightPath,
    cloudRunSpendCapReceipt,
    cloudRunSpendCapPath,
    agentPlatformSpendCapReceipt,
    agentPlatformSpendCapPath,
    appStorageReceipt,
    appStoragePath,
    simulatorStorageReceipt,
    simulatorStoragePath,
  };
}

function failureCodes(result) {
  return new Set(result.failures.map((failure) => failure.code));
}

async function rebindPreflightReceipt(fixture, target) {
  const bindings = {
    billing: [
      fixture.billingPreflightReceipt,
      fixture.billingPreflightPath,
      fixture.record.google_cloud.preflight_receipts.billing_overview,
    ],
    cloud_run: [
      fixture.cloudRunSpendCapReceipt,
      fixture.cloudRunSpendCapPath,
      fixture.record.google_cloud.preflight_receipts.cloud_run_spend_cap,
    ],
    agent_platform: [
      fixture.agentPlatformSpendCapReceipt,
      fixture.agentPlatformSpendCapPath,
      fixture.record.google_cloud.preflight_receipts.agent_platform_spend_cap,
    ],
  };
  const [receipt, receiptPath, binding] = bindings[target];
  binding.sha256 = (await writeJson(receiptPath, receipt)).digest;
}

test("a fully bound offline release record passes without network activity", async (t) => {
  const fixture = await createFixture(t);
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.deepEqual(result, { ok: true, failures: [] });
});

test("only the approved entrant-attestation text digest passes preflight and full readiness", async (t) => {
  assert.equal(sha256(approvedEntrantAttestationText), approvedEntrantAttestationSha256);

  const approved = await createFixture(t);
  assert.deepEqual(await verifyGoogleCloudPreflight(approved.record, approved), { ok: true, failures: [] });
  assert.deepEqual(await verifySubmissionReadiness(approved.record, approved), { ok: true, failures: [] });

  const wrong = await createFixture(t);
  const syntacticallyValidWrongDigest = "e".repeat(64);
  wrong.billingPreflightReceipt.attestation_text_sha256 = syntacticallyValidWrongDigest;
  wrong.cloudRunSpendCapReceipt.attestation_text_sha256 = syntacticallyValidWrongDigest;
  wrong.agentPlatformSpendCapReceipt.attestation_text_sha256 = syntacticallyValidWrongDigest;
  await rebindPreflightReceipt(wrong, "billing");
  await rebindPreflightReceipt(wrong, "cloud_run");
  await rebindPreflightReceipt(wrong, "agent_platform");

  const preflight = await verifyGoogleCloudPreflight(wrong.record, wrong);
  const full = await verifySubmissionReadiness(wrong.record, wrong);
  assert.equal(failureCodes(preflight).has("GOOGLE_CLOUD_PREFLIGHT_ATTESTATION"), true);
  assert.equal(failureCodes(full).has("GOOGLE_CLOUD_PREFLIGHT_ATTESTATION"), true);
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

  fixture.record.google_cloud.agent_platform_spend_cap_confirmed = true;
  fixture.record.google_cloud.dedicated_project_label_value = "shared-project";
  result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("DEDICATED_PROJECT_LABEL"), true);
});

test("cloud preflight binds fresh entrant attestations and CLI-corroborated billing state", async (t) => {
  const fixture = await createFixture(t);
  let result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.deepEqual(result, { ok: true, failures: [] });

  fixture.record.google_cloud.required_apis_enabled_confirmed = false;
  fixture.record.google_cloud.iam_ready_confirmed = false;
  fixture.record.google_cloud.quota_ready_confirmed = false;
  result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.deepEqual(result, { ok: true, failures: [] });

  fixture.billingPreflightReceipt.paid_activation_absent = false;
  const rewrittenBilling = await writeJson(fixture.billingPreflightPath, fixture.billingPreflightReceipt);
  fixture.record.google_cloud.preflight_receipts.billing_overview.sha256 = rewrittenBilling.digest;
  result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_RECEIPT"), true);

  fixture.billingPreflightReceipt.paid_activation_absent = true;
  await rebindPreflightReceipt(fixture, "billing");
  fixture.record.google_cloud.preflight_receipts.cloud_run_spend_cap.sha256 = "0".repeat(64);
  result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.equal(failureCodes(result).has("RECEIPT_DIGEST_MISMATCH"), true);

  await rebindPreflightReceipt(fixture, "cloud_run");
  fixture.billingPreflightReceipt.no_paid_upgrade_or_payment_during_release_confirmed = false;
  await rebindPreflightReceipt(fixture, "billing");
  result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_RECEIPT"), true);

  fixture.billingPreflightReceipt.no_paid_upgrade_or_payment_during_release_confirmed = true;
  fixture.billingPreflightReceipt.cli_checked_at_utc = "2026-08-27T20:40:00Z";
  await rebindPreflightReceipt(fixture, "billing");
  result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_FRESHNESS"), true);
});

test("a twelve-minute-old entrant attestation passes while CLI and release checks are fresh", async (t) => {
  const fixture = await createFixture(t);
  const attestedAt = new Date(fixture.nowMilliseconds - 12 * 60_000).toISOString();
  for (const [receipt, receiptPath, binding] of [
    [fixture.billingPreflightReceipt, fixture.billingPreflightPath, fixture.record.google_cloud.preflight_receipts.billing_overview],
    [fixture.cloudRunSpendCapReceipt, fixture.cloudRunSpendCapPath, fixture.record.google_cloud.preflight_receipts.cloud_run_spend_cap],
    [fixture.agentPlatformSpendCapReceipt, fixture.agentPlatformSpendCapPath, fixture.record.google_cloud.preflight_receipts.agent_platform_spend_cap],
  ]) {
    receipt.attested_at_utc = attestedAt;
    binding.sha256 = (await writeJson(receiptPath, receipt)).digest;
  }
  const full = await verifySubmissionReadiness(fixture.record, fixture);
  assert.deepEqual(full, { ok: true, failures: [] });
  const operational = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.deepEqual(operational, { ok: true, failures: [] });
});

test("full readiness requires a CLI billing check and release timestamp from the last ten minutes", async (t) => {
  const staleCli = await createFixture(t);
  staleCli.billingPreflightReceipt.cli_checked_at_utc = new Date(staleCli.nowMilliseconds - 12 * 60_000).toISOString();
  await rebindPreflightReceipt(staleCli, "billing");
  let result = await verifySubmissionReadiness(staleCli.record, staleCli);
  assert.equal(
    result.failures.some((failure) => (
      failure.code === "GOOGLE_CLOUD_PREFLIGHT_FRESHNESS"
      && failure.message.includes("billing_overview_receipt.cli_checked_at_utc")
    )),
    true,
  );

  const staleRelease = await createFixture(t);
  staleRelease.record.created_at_utc = new Date(staleRelease.nowMilliseconds - 11 * 60_000).toISOString();
  const stillCurrentAttestation = new Date(staleRelease.nowMilliseconds - 12 * 60_000).toISOString();
  staleRelease.billingPreflightReceipt.attested_at_utc = stillCurrentAttestation;
  staleRelease.billingPreflightReceipt.cli_checked_at_utc = new Date(staleRelease.nowMilliseconds - 11.5 * 60_000).toISOString();
  staleRelease.cloudRunSpendCapReceipt.attested_at_utc = stillCurrentAttestation;
  staleRelease.agentPlatformSpendCapReceipt.attested_at_utc = stillCurrentAttestation;
  await rebindPreflightReceipt(staleRelease, "billing");
  await rebindPreflightReceipt(staleRelease, "cloud_run");
  await rebindPreflightReceipt(staleRelease, "agent_platform");
  result = await verifySubmissionReadiness(staleRelease.record, staleRelease);
  assert.equal(
    result.failures.some((failure) => (
      failure.code === "GOOGLE_CLOUD_PREFLIGHT_FRESHNESS"
      && failure.message.includes("release_record.created_at_utc")
    )),
    true,
  );
});

test("billing preflight binds a private hash of the exact live billing account resource", async (t) => {
  const fixture = await createFixture(t);
  delete fixture.billingPreflightReceipt.billing_account_name_sha256;
  fixture.record.google_cloud.preflight_receipts.billing_overview.sha256 = (
    await writeJson(fixture.billingPreflightPath, fixture.billingPreflightReceipt)
  ).digest;
  const result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.equal(failureCodes(result).has("SHA256_REQUIRED"), true);
});

test("the tracked Google Cloud identity cannot be self-minted by changing the release record", async (t) => {
  const fixture = await createFixture(t);
  const identityPath = path.join(fixture.repoRoot, "docs", "google-cloud-resource-identity.json");
  const changedIdentity = JSON.parse(await readFile(identityPath, "utf8"));
  changedIdentity.project_id = "found-roll-agentic-wrong-project";
  changedIdentity.evidence_bucket = "found-roll-agentic-wrong-project-found-roll-evidence";
  const changedRaw = `${JSON.stringify(changedIdentity, null, 2)}\n`;
  await writeFile(identityPath, changedRaw, "utf8");
  fixture.record.google_cloud.project_id = changedIdentity.project_id;
  fixture.record.google_cloud.evidence_bucket = changedIdentity.evidence_bucket;
  fixture.record.google_cloud.resource_identity.sha256 = sha256(changedRaw);
  fixture.record.frozen_files.find((binding) => binding.path === "docs/google-cloud-resource-identity.json").sha256 = sha256(changedRaw);
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_RESOURCE_IDENTITY"), true);
});

test("post-source-deploy storage receipts fail closed on scope, timing, retention, and ceiling", async (t) => {
  const fixture = await createFixture(t);
  fixture.simulatorStorageReceipt.phase = "after_app_source_deploy";
  fixture.simulatorStorageReceipt.project_number = "999999999999";
  fixture.simulatorStorageReceipt.revision = "found-roll-simulator-00099-zzz";
  fixture.simulatorStorageReceipt.observed_at_utc = new Date(fixture.nowMilliseconds).toISOString();
  fixture.simulatorStorageReceipt.revision_created_at_utc = new Date(
    fixture.nowMilliseconds - 11 * 60_000,
  ).toISOString();
  fixture.simulatorStorageReceipt.soft_deleted_bucket_count = 1;
  fixture.simulatorStorageReceipt.observed_bytes = 5 * 1024 * 1024 * 1024;
  fixture.simulatorStorageReceipt.buckets[0].soft_deleted_bytes = 1;
  fixture.simulatorStorageReceipt.buckets[0].soft_deleted_object_count = 1;
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, fixture.simulatorStorageReceipt)
  ).digest;
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  for (const code of [
    "PROJECT_STORAGE_RECEIPT",
    "PROJECT_STORAGE_AUDIT_TIMING",
    "PROJECT_STORAGE_CEILING",
    "PROJECT_STORAGE_RETENTION",
  ]) assert.equal(codes.has(code), true, `missing ${code}`);
});

test("storage receipts reject wrong-service revisions and pre-project timestamps", async (t) => {
  const fixture = await createFixture(t);
  fixture.appStorageReceipt.revision = "found-roll-simulator-00042-abc";
  fixture.appStorageReceipt.revision_images[0].revision = fixture.appStorageReceipt.revision;
  const projectCreated = Date.parse(fixture.record.google_cloud.project_created_at_utc);
  fixture.appStorageReceipt.revision_created_at_utc = new Date(projectCreated - 2 * 60_000).toISOString();
  fixture.appStorageReceipt.observed_at_utc = new Date(projectCreated - 60_000).toISOString();
  fixture.record.google_cloud.project_storage_receipts.after_app_source_deploy.sha256 = (
    await writeJson(fixture.appStoragePath, fixture.appStorageReceipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("PROJECT_STORAGE_SERVICE_REVISION"), true);
  assert.equal(codes.has("PROJECT_STORAGE_TIMELINE"), true);
});

test("storage receipts require the exact evidence bucket and recomputable inventories", async (t) => {
  const fixture = await createFixture(t);
  fixture.simulatorStorageReceipt.buckets[0].bucket = "unrelated-build-bucket";
  fixture.simulatorStorageReceipt.active_bucket_inventory_sha256 = sha256(canonicalJson(fixture.simulatorStorageReceipt.buckets));
  fixture.simulatorStorageReceipt.cloud_build_inventory_sha256 = "f".repeat(64);
  fixture.simulatorStorageReceipt.artifact_repositories[0].format = "GENERIC";
  fixture.simulatorStorageReceipt.artifact_repository_inventory_sha256 = sha256(
    canonicalJson(fixture.simulatorStorageReceipt.artifact_repositories),
  );
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, fixture.simulatorStorageReceipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("PROJECT_STORAGE_EVIDENCE_BUCKET"), true);
  assert.equal(codes.has("PROJECT_STORAGE_INVENTORY_HASH"), true);
  assert.equal(codes.has("PROJECT_STORAGE_NON_DOCKER_REPOSITORY"), true);
});

test("a forged bucket child hash fails even when the parent inventory hash is recomputed", async (t) => {
  const fixture = await createFixture(t);
  fixture.simulatorStorageReceipt.buckets[0].current_object_inventory_sha256 = "f".repeat(64);
  fixture.simulatorStorageReceipt.active_bucket_inventory_sha256 = sha256(
    canonicalJson(fixture.simulatorStorageReceipt.buckets),
  );
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, fixture.simulatorStorageReceipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_OBJECT_INVENTORY_HASH"), true);
});

test("Artifact Registry repository URIs cannot point at a foreign project", async (t) => {
  const fixture = await createFixture(t);
  const receipt = fixture.simulatorStorageReceipt;
  const originalUri = receipt.artifact_repositories[0].repository_uri;
  const foreignUri = "us-central1-docker.pkg.dev/foreign-project/cloud-run-source-deploy";
  receipt.artifact_repositories[0].repository_uri = foreignUri;
  for (const image of receipt.artifact_images) {
    image.repository_uri = foreignUri;
    image.package = image.package.replace(originalUri, foreignUri);
  }
  receipt.artifact_repository_inventory_sha256 = sha256(canonicalJson(receipt.artifact_repositories));
  receipt.artifact_image_inventory_sha256 = sha256(canonicalJson(receipt.artifact_images));
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, receipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_REPOSITORY_IDENTITY"), true);
});

test("canonical runs bind the exact project bucket, Cloud Run origins, and service revisions", async (t) => {
  const fixture = await createFixture(t);
  const run = fixture.runReceipts[0];
  run.cloud_boundary.evidence_bucket = "foreign-project-evidence";
  run.app_origin = "https://foreign-app-abc.a.run.app";
  run.simulator_origin = "https://foreign-simulator-abc.a.run.app";
  run.app_revision = "found-roll-app-00099-zzz";
  run.simulator_revision = "found-roll-simulator-00099-yyy";
  fixture.record.receipts.canonical_runs[0].run_sha256 = (await writeJson(fixture.runPaths[0], run)).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const bindingMessages = result.failures
    .filter((failure) => failure.code === "RECEIPT_BINDING")
    .map((failure) => failure.message)
    .join("\n");
  for (const field of ["cloud_boundary.evidence_bucket", "app_origin", "simulator_origin", "app_revision", "simulator_revision"]) {
    assert.equal(bindingMessages.includes(field), true, `missing exact ${field} binding failure`);
  }
});

test("a colluding run set and clean-browser receipt cannot replace the exact app revision binding", async (t) => {
  const fixture = await createFixture(t);
  const substitutedRevision = "found-roll-app-00099-zzz";
  for (let index = 0; index < fixture.runReceipts.length; index += 1) {
    fixture.runReceipts[index].app_revision = substitutedRevision;
    fixture.record.receipts.canonical_runs[index].run_sha256 = (
      await writeJson(fixture.runPaths[index], fixture.runReceipts[index])
    ).digest;
  }
  fixture.cleanBrowserReceipt.app_revision = substitutedRevision;
  fixture.record.receipts.clean_browser_sha256 = (
    await writeJson(fixture.cleanBrowserPath, fixture.cleanBrowserReceipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(
    result.failures.some((failure) => failure.code === "RECEIPT_BINDING" && failure.message.includes("app_revision")),
    true,
  );
});

test("canonical Cloud Run resource bindings cannot move to a foreign project", async (t) => {
  const fixture = await createFixture(t);
  for (const binding of Object.values(fixture.record.google_cloud.canonical_revision_images)) {
    binding.project_id = "foreign-project-00001";
    binding.project_number = "999999999999";
    binding.service_resource = `projects/${binding.project_number}/locations/${binding.region}/services/${binding.service}`;
    binding.revision_resource = `${binding.service_resource}/revisions/${binding.revision}`;
    binding.origin = "https://unrelated.example.com";
  }

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("CANONICAL_REVISION_IMAGE"), true);
  const messages = result.failures
    .filter((failure) => failure.code === "CANONICAL_REVISION_IMAGE")
    .map((failure) => failure.message)
    .join("\n");
  assert.equal(messages.includes("canonical_revision_images.app"), true);
  assert.equal(messages.includes("canonical_revision_images.simulator"), true);
});

test("source builds must finish before their bound Cloud Run revisions are created", async (t) => {
  const fixture = await createFixture(t);
  fixture.appStorageReceipt.builds[0].finished_at_utc = new Date(
    Date.parse(fixture.appStorageReceipt.revision_created_at_utc) + 1_000,
  ).toISOString();
  fixture.appStorageReceipt.cloud_build_inventory_sha256 = sha256(canonicalJson(fixture.appStorageReceipt.builds));
  fixture.record.google_cloud.project_storage_receipts.after_app_source_deploy.sha256 = (
    await writeJson(fixture.appStoragePath, fixture.appStorageReceipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_BUILD_BINDING"), true);
});

test("the simulator phase must carry forward the exact app source-build record", async (t) => {
  const fixture = await createFixture(t);
  fixture.simulatorStorageReceipt.builds[0].finished_at_utc = new Date(
    Date.parse(fixture.simulatorStorageReceipt.builds[0].finished_at_utc) + 1_000,
  ).toISOString();
  fixture.simulatorStorageReceipt.cloud_build_inventory_sha256 = sha256(
    canonicalJson(fixture.simulatorStorageReceipt.builds),
  );
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, fixture.simulatorStorageReceipt)
  ).digest;

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_PHASE_BINDING"), true);
});

test("build receipts bind exact locations, source objects, direct identities, and supplemental assets", async (t) => {
  const sourceFixture = await createFixture(t);
  sourceFixture.simulatorStorageReceipt.source_deploy_build_source_location_sha256 = "f".repeat(64);
  sourceFixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(sourceFixture.simulatorStoragePath, sourceFixture.simulatorStorageReceipt)
  ).digest;
  let result = await verifySubmissionReadiness(sourceFixture.record, sourceFixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_BUILD_BINDING"), true);

  const identityFixture = await createFixture(t);
  identityFixture.simulatorStorageReceipt.direct_build_identity_count += 1;
  identityFixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(identityFixture.simulatorStoragePath, identityFixture.simulatorStorageReceipt)
  ).digest;
  result = await verifySubmissionReadiness(identityFixture.record, identityFixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_BUILD_INVENTORY"), true);

  const assetFixture = await createFixture(t);
  const unknownAsset = {
    build_id: "foreign-build",
    location: "us-central1",
    build_resource: `projects/${assetFixture.record.google_cloud.project_number}/locations/us-central1/builds/foreign-build`,
  };
  assetFixture.simulatorStorageReceipt.cloud_build_assets.push(unknownAsset);
  assetFixture.simulatorStorageReceipt.cloud_build_asset_count += 1;
  assetFixture.simulatorStorageReceipt.cloud_build_asset_inventory_sha256 = sha256(
    canonicalJson(assetFixture.simulatorStorageReceipt.cloud_build_assets),
  );
  assetFixture.simulatorStorageReceipt.cloud_build_asset_inventory_stable = false;
  assetFixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(assetFixture.simulatorStoragePath, assetFixture.simulatorStorageReceipt)
  ).digest;
  result = await verifySubmissionReadiness(assetFixture.record, assetFixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_BUILD_ASSET_INVENTORY"), true);
});

test("supplemental Cloud Asset lag cannot omit authoritative direct builds or invent identities", async (t) => {
  const fixture = await createFixture(t);
  const appIdentity = fixture.simulatorStorageReceipt.cloud_build_assets[0];
  fixture.simulatorStorageReceipt.cloud_build_assets_before = [structuredClone(appIdentity)];
  fixture.simulatorStorageReceipt.cloud_build_assets = [structuredClone(appIdentity)];
  fixture.simulatorStorageReceipt.cloud_build_asset_snapshot_before_count = 1;
  fixture.simulatorStorageReceipt.cloud_build_asset_count = 1;
  fixture.simulatorStorageReceipt.cloud_build_asset_snapshot_before_sha256 = sha256(
    canonicalJson(fixture.simulatorStorageReceipt.cloud_build_assets_before),
  );
  fixture.simulatorStorageReceipt.cloud_build_asset_inventory_sha256 = sha256(
    canonicalJson(fixture.simulatorStorageReceipt.cloud_build_assets),
  );
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, fixture.simulatorStorageReceipt)
  ).digest;
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(result.ok, true, formatReadinessResult(result));
});

test("authoritative build annotations resolve equal-digest builds without selecting a latest candidate", async (t) => {
  const fixture = await createFixture(t);
  const extraBuild = structuredClone(fixture.simulatorStorageReceipt.builds.at(-1));
  extraBuild.build_id = "build-simulator-equal-digest";
  extraBuild.build_resource = `projects/${fixture.record.google_cloud.project_number}/locations/us-central1/builds/${extraBuild.build_id}`;
  extraBuild.source_location_sha256 = "f".repeat(64);
  extraBuild.created_at_utc = new Date(Date.parse(extraBuild.created_at_utc) - 2_000).toISOString();
  extraBuild.finished_at_utc = new Date(Date.parse(extraBuild.finished_at_utc) - 2_000).toISOString();
  fixture.simulatorStorageReceipt.builds.push(extraBuild);
  refreshStorageBuildProof(fixture.simulatorStorageReceipt, { refreshAssets: true });
  fixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(fixture.simulatorStoragePath, fixture.simulatorStorageReceipt)
  ).digest;
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(result.ok, true, formatReadinessResult(result));
});

test("exact package-at-digest binding rejects wrong and malformed image resources", async (t) => {
  const wrongPackageFixture = await createFixture(t);
  wrongPackageFixture.simulatorStorageReceipt.artifact_images[1].package = wrongPackageFixture.simulatorStorageReceipt.artifact_images[0].package;
  wrongPackageFixture.simulatorStorageReceipt.artifact_image_inventory_sha256 = sha256(
    canonicalJson(wrongPackageFixture.simulatorStorageReceipt.artifact_images),
  );
  wrongPackageFixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(wrongPackageFixture.simulatorStoragePath, wrongPackageFixture.simulatorStorageReceipt)
  ).digest;
  let result = await verifySubmissionReadiness(wrongPackageFixture.record, wrongPackageFixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_IMAGE_BINDING"), true);

  const malformedFixture = await createFixture(t);
  const receipt = malformedFixture.simulatorStorageReceipt;
  const malformedPackage = `${receipt.artifact_images[1].repository_uri}/bad:tag`;
  const malformedResource = `${malformedPackage}@${receipt.revision_image_digest}`;
  receipt.revision_image_resource = malformedResource;
  receipt.artifact_images[1].package = malformedPackage;
  receipt.builds.find((build) => build.build_resource === receipt.source_deploy_build_resource).image_resources = [malformedResource];
  receipt.revision_images.find((binding) => binding.service === "found-roll-simulator").image_package = malformedPackage;
  receipt.revision_images.find((binding) => binding.service === "found-roll-simulator").image_resource = malformedResource;
  refreshStorageBuildProof(receipt);
  receipt.artifact_image_inventory_sha256 = sha256(canonicalJson(receipt.artifact_images));
  malformedFixture.record.google_cloud.canonical_revision_images.simulator.image_package = malformedPackage;
  malformedFixture.record.google_cloud.canonical_revision_images.simulator.image_resource = malformedResource;
  malformedFixture.record.google_cloud.project_storage_receipts.after_simulator_source_deploy.sha256 = (
    await writeJson(malformedFixture.simulatorStoragePath, receipt)
  ).digest;
  result = await verifySubmissionReadiness(malformedFixture.record, malformedFixture);
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_IMAGE_BINDING") || failureCodes(result).has("CANONICAL_REVISION_IMAGE"), true);
});

test("storage receipts expire against the release timeline", async (t) => {
  const fixture = await createFixture(t);
  const releaseTime = Date.parse(fixture.appStorageReceipt.observed_at_utc) + 25 * 60 * 60 * 1000;
  fixture.record.created_at_utc = new Date(releaseTime).toISOString();
  for (const [receipt, receiptPath, binding, minutes] of [
    [fixture.billingPreflightReceipt, fixture.billingPreflightPath, fixture.record.google_cloud.preflight_receipts.billing_overview, 4],
    [fixture.cloudRunSpendCapReceipt, fixture.cloudRunSpendCapPath, fixture.record.google_cloud.preflight_receipts.cloud_run_spend_cap, 3],
    [fixture.agentPlatformSpendCapReceipt, fixture.agentPlatformSpendCapPath, fixture.record.google_cloud.preflight_receipts.agent_platform_spend_cap, 2],
  ]) {
    receipt.observed_at_utc = new Date(releaseTime - minutes * 60_000).toISOString();
    binding.sha256 = (await writeJson(receiptPath, receipt)).digest;
  }
  const result = await verifySubmissionReadiness(fixture.record, { ...fixture, nowMilliseconds: releaseTime });
  assert.equal(failureCodes(result).has("PROJECT_STORAGE_FRESHNESS"), true);
});

test("canonical run revisions are hash-bound to source-deployed images", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.google_cloud.canonical_revision_images.app.image_digest = `sha256:${"c".repeat(64)}`;
  const result = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(result).has("CANONICAL_REVISION_IMAGE"), true);
});

test("clean-browser verification must follow all runs and remain fresh", async (t) => {
  const chronologicalFixture = await createFixture(t);
  chronologicalFixture.cleanBrowserReceipt.verified_at_utc = new Date(
    Math.max(...chronologicalFixture.runReceipts.map((receipt) => Date.parse(receipt.ended_at_utc))) - 1_000,
  ).toISOString();
  chronologicalFixture.record.receipts.clean_browser_sha256 = (
    await writeJson(chronologicalFixture.cleanBrowserPath, chronologicalFixture.cleanBrowserReceipt)
  ).digest;
  const chronologicalResult = await verifySubmissionReadiness(chronologicalFixture.record, chronologicalFixture);
  assert.equal(failureCodes(chronologicalResult).has("CLEAN_BROWSER_FRESHNESS"), true);

  const simultaneousFixture = await createFixture(t);
  simultaneousFixture.cleanBrowserReceipt.verified_at_utc = simultaneousFixture.record.created_at_utc;
  simultaneousFixture.record.receipts.clean_browser_sha256 = (
    await writeJson(simultaneousFixture.cleanBrowserPath, simultaneousFixture.cleanBrowserReceipt)
  ).digest;
  const simultaneousResult = await verifySubmissionReadiness(simultaneousFixture.record, simultaneousFixture);
  assert.equal(failureCodes(simultaneousResult).has("CLEAN_BROWSER_FRESHNESS"), true);

  const staleFixture = await createFixture(t);
  staleFixture.cleanBrowserReceipt.verified_at_utc = new Date(
    staleFixture.nowMilliseconds - 25 * 60 * 60 * 1_000,
  ).toISOString();
  staleFixture.record.receipts.clean_browser_sha256 = (
    await writeJson(staleFixture.cleanBrowserPath, staleFixture.cleanBrowserReceipt)
  ).digest;
  const staleResult = await verifySubmissionReadiness(staleFixture.record, staleFixture);
  assert.equal(failureCodes(staleResult).has("CLEAN_BROWSER_FRESHNESS"), true);
});

test("teardown identity ignores stale billing evidence but requires the frozen release identity", async (t) => {
  const fixture = await createFixture(t);
  fixture.record.created_at_utc = "2026-01-01T00:00:00Z";
  const result = await verifyGoogleCloudTeardownIdentity(fixture.record, fixture);
  assert.deepEqual(result, { ok: true, failures: [] });

  fixture.gitState.tagCommit = "9".repeat(40);
  const changed = await verifyGoogleCloudTeardownIdentity(fixture.record, fixture);
  assert.equal(failureCodes(changed).has("TAG_MISMATCH"), true);
});

test("cloud preflight requires exact attestation schemas, source, and entrant commitments", async (t) => {
  const cases = [
    ["billing schema version", "billing", (receipt) => { receipt.schema_version = "1"; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["attestation version", "billing", (receipt) => { receipt.attestation_version = "found-roll-zero-real-money-v2"; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["attestation source", "billing", (receipt) => { receipt.attestation_source = "browser_screenshot"; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["entrant confirmation", "billing", (receipt) => { receipt.entrant_attestation_confirmed = false; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["CLI billing link", "billing", (receipt) => { receipt.billing_enabled_cli_observed = false; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["CLI billing account state", "billing", (receipt) => { receipt.billing_account_open_cli_observed = false; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["no paid upgrade commitment", "billing", (receipt) => { receipt.no_paid_upgrade_or_payment_during_release_confirmed = false; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["cap entrant confirmation", "cloud_run", (receipt) => { receipt.entrant_attestation_confirmed = false; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["no cap change commitment", "agent_platform", (receipt) => { receipt.no_cap_change_during_release_confirmed = false; }, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT"],
    ["missing attestation field", "billing", (receipt) => { delete receipt.entrant_attestation_confirmed; }, "RECORD_MISSING_FIELD"],
    ["unknown attestation field", "billing", (receipt) => { receipt.redacted_capture_path = "obsolete.png"; }, "RECORD_UNKNOWN_FIELDS"],
  ];

  for (const [label, target, mutate, expectedCode] of cases) {
    const fixture = await createFixture(t);
    const receipt = target === "billing"
      ? fixture.billingPreflightReceipt
      : target === "cloud_run"
        ? fixture.cloudRunSpendCapReceipt
        : fixture.agentPlatformSpendCapReceipt;
    mutate(receipt);
    await rebindPreflightReceipt(fixture, target);
    const result = await verifyGoogleCloudPreflight(fixture.record, fixture);
    assert.equal(failureCodes(result).has(expectedCode), true, `${label} must fail closed`);
  }
});

test("cloud preflight binds all receipts to one attestation batch, timestamp, and text", async (t) => {
  for (const [label, mutate] of [
    ["batch", (receipt) => { receipt.attestation_batch_id = "33d0f9aa-7c83-4a4b-9db2-cab909470bd2"; }],
    ["timestamp", (receipt) => { receipt.attested_at_utc = new Date(Date.parse(receipt.attested_at_utc) - 1_000).toISOString(); }],
    ["text", (receipt) => { receipt.attestation_text_sha256 = "e".repeat(64); }],
  ]) {
    const fixture = await createFixture(t);
    mutate(fixture.agentPlatformSpendCapReceipt);
    await rebindPreflightReceipt(fixture, "agent_platform");
    const result = await verifyGoogleCloudPreflight(fixture.record, fixture);
    assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_ATTESTATION"), true, `${label} mismatch must fail closed`);
  }
});

test("cloud preflight requires the exact project, service targets, and EUR cap amounts", async (t) => {
  const cases = [
    ["billing project", "billing", (receipt) => { receipt.project_id = "found-roll-agentic-wrong"; }],
    ["Cloud Run project", "cloud_run", (receipt) => { receipt.project_id = "found-roll-agentic-wrong"; }],
    ["Cloud Run service", "cloud_run", (receipt) => { receipt.service_target = "agent_platform"; }],
    ["Agent Platform service", "agent_platform", (receipt) => { receipt.service_target = "cloud_run"; }],
    ["Cloud Run currency", "cloud_run", (receipt) => { receipt.cap_currency = "USD"; }],
    ["Cloud Run wrong amount", "cloud_run", (receipt) => { receipt.cap_amount_minor_units = 999; }],
    ["Agent Platform wrong amount", "agent_platform", (receipt) => { receipt.cap_amount_minor_units = 1000; }],
    ["zero amount", "cloud_run", (receipt) => { receipt.cap_amount_minor_units = 0; }],
    ["negative amount", "cloud_run", (receipt) => { receipt.cap_amount_minor_units = -1; }],
    ["fractional amount", "cloud_run", (receipt) => { receipt.cap_amount_minor_units = 1000.5; }],
    ["string amount", "cloud_run", (receipt) => { receipt.cap_amount_minor_units = "1000"; }],
  ];

  for (const [label, target, mutate] of cases) {
    const fixture = await createFixture(t);
    const receipt = target === "billing"
      ? fixture.billingPreflightReceipt
      : target === "cloud_run"
        ? fixture.cloudRunSpendCapReceipt
        : fixture.agentPlatformSpendCapReceipt;
    mutate(receipt);
    await rebindPreflightReceipt(fixture, target);
    const result = await verifyGoogleCloudPreflight(fixture.record, fixture);
    assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_RECEIPT"), true, `${label} must fail closed`);
  }
});

test("cloud preflight independently enforces attestation, CLI-check, and release freshness", async (t) => {
  const staleAttestation = await createFixture(t);
  const attestedAt = new Date(staleAttestation.nowMilliseconds - 25 * 60 * 60_000).toISOString();
  for (const [receipt, target] of [
    [staleAttestation.billingPreflightReceipt, "billing"],
    [staleAttestation.cloudRunSpendCapReceipt, "cloud_run"],
    [staleAttestation.agentPlatformSpendCapReceipt, "agent_platform"],
  ]) {
    receipt.attested_at_utc = attestedAt;
    await rebindPreflightReceipt(staleAttestation, target);
  }
  let result = await verifyGoogleCloudPreflight(staleAttestation.record, staleAttestation);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_FRESHNESS"), true);

  const staleCli = await createFixture(t);
  staleCli.billingPreflightReceipt.cli_checked_at_utc = new Date(staleCli.nowMilliseconds - 11 * 60_000).toISOString();
  await rebindPreflightReceipt(staleCli, "billing");
  result = await verifyGoogleCloudPreflight(staleCli.record, staleCli);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_FRESHNESS"), true);

  const staleRelease = await createFixture(t);
  staleRelease.record.created_at_utc = new Date(staleRelease.nowMilliseconds - 11 * 60_000).toISOString();
  result = await verifyGoogleCloudPreflight(staleRelease.record, staleRelease);
  assert.equal(failureCodes(result).has("GOOGLE_CLOUD_PREFLIGHT_FRESHNESS"), true);
});

test("cloud preflight requires an inspectable repository with ignored private artifacts", async (t) => {
  const fixture = await createFixture(t);
  fixture.gitState.privateArtifactsSafe = false;
  let result = await verifyGoogleCloudPreflight(fixture.record, fixture);
  assert.equal(failureCodes(result).has("PRIVATE_ARTIFACT_GIT_STATE"), true);

  result = await verifyGoogleCloudPreflight(fixture.record, {
    repoRoot: fixture.repoRoot,
    recordPath: fixture.recordPath,
    nowMilliseconds: fixture.nowMilliseconds,
  });
  assert.equal(failureCodes(result).has("GIT_UNAVAILABLE"), true);
});

test("the checked release template exactly matches the verifier frozen-file contract", async () => {
  const template = JSON.parse(await readFile(path.join(projectRoot, "docs", "submission-release.template.json"), "utf8"));
  assert.deepEqual(template.frozen_files.map((binding) => binding.path), requiredFrozenFilePaths);
  assert.equal(template.google_cloud.project_number, "1061926987746");
  assert.equal(template.google_cloud.project_created_at_utc, "2026-08-29T22:58:52.064Z");
  assert.equal(template.google_cloud.evidence_bucket, `${template.google_cloud.project_id}-found-roll-evidence`);
  assert.deepEqual(Object.keys(template.google_cloud.canonical_revision_images.app), [
    "project_id",
    "project_number",
    "region",
    "service",
    "service_resource",
    "origin",
    "revision",
    "revision_resource",
    "revision_created_at_utc",
    "image_digest",
    "image_package",
    "image_resource",
  ]);
  assert.equal(
    template.google_cloud.canonical_revision_images.app.service_resource,
    `projects/${template.google_cloud.project_number}/locations/us-central1/services/found-roll-app`,
  );
  assert.equal(
    template.google_cloud.canonical_revision_images.simulator.service_resource,
    `projects/${template.google_cloud.project_number}/locations/us-central1/services/found-roll-simulator`,
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

test("frozen files and private evidence reject symbolic-link path components", async (t) => {
  const fixture = await createFixture(t);
  const assetsPath = path.join(fixture.repoRoot, "public", "assets");
  const realAssetsPath = path.join(fixture.repoRoot, "public", "assets-real");
  await rename(assetsPath, realAssetsPath);
  await symlink(realAssetsPath, assetsPath, process.platform === "win32" ? "junction" : "dir");
  const privatePath = path.join(fixture.repoRoot, "artifacts", "private");
  const realPrivatePath = path.join(fixture.repoRoot, "artifacts", "private-real");
  await rename(privatePath, realPrivatePath);
  await symlink(realPrivatePath, privatePath, process.platform === "win32" ? "junction" : "dir");

  const result = await verifySubmissionReadiness(fixture.record, fixture);
  const codes = failureCodes(result);
  assert.equal(codes.has("FROZEN_FILE_UNREADABLE"), true);
  assert.equal(codes.has("RECEIPT_UNREADABLE"), true);
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

  const unsafeLeaseDeployment = deployment.replace("ANALYSIS_EXECUTION_LEASE_SECONDS=5", "ANALYSIS_EXECUTION_LEASE_SECONDS=15");
  assert.notEqual(unsafeLeaseDeployment, deployment);
  await writeFile(deploymentPath, unsafeLeaseDeployment, "utf8");
  fixture.record.frozen_files.find((binding) => binding.path === "docs/deployment.md").sha256 = sha256(unsafeLeaseDeployment);
  const unsafeLeaseResult = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(unsafeLeaseResult).has("DEPLOYMENT_SETUP"), true);

  const nonStandaloneTeardown = deployment.replace(
    /(## After judging: teardown[\s\S]*?)Set-StrictMode -Version Latest/,
    "$1# strict mode removed",
  );
  assert.notEqual(nonStandaloneTeardown, deployment);
  await writeFile(deploymentPath, nonStandaloneTeardown, "utf8");
  fixture.record.frozen_files.find((binding) => binding.path === "docs/deployment.md").sha256 = sha256(nonStandaloneTeardown);
  const nonStandaloneResult = await verifySubmissionReadiness(fixture.record, fixture);
  assert.equal(failureCodes(nonStandaloneResult).has("DEPLOYMENT_SETUP"), true);
  assert.equal(deployment.includes("release-record digest to agree"), false);

  const assertDeploymentRejected = async (mutatedDeployment) => {
    assert.notEqual(mutatedDeployment, deployment);
    await writeFile(deploymentPath, mutatedDeployment, "utf8");
    fixture.record.frozen_files.find((binding) => binding.path === "docs/deployment.md").sha256 = sha256(mutatedDeployment);
    const mutationResult = await verifySubmissionReadiness(fixture.record, fixture);
    assert.equal(failureCodes(mutationResult).has("DEPLOYMENT_SETUP"), true);
  };

  await assertDeploymentRejected(deployment.replace(
    "gcloud firestore databases create --project=$ProjectId",
    "gcloud firestore databases create",
  ));
  await assertDeploymentRejected(deployment.replace(
    "Assert-LastGcloudSuccess -Operation 'Firestore database creation'",
    "# Firestore failure check removed",
  ));
  await assertDeploymentRejected(deployment.replace(
    "function Get-ProjectWideSecretDirectInventory {",
    "function Get-ProjectWideSecretDirectInventory_REMOVED {",
  ));
  await assertDeploymentRejected(deployment.replace(
    "Assert-GoogleCloudPreflight -PhaseName \"secret-version-upload-$($Entry.Key)\"",
    "# fresh upload preflight removed",
  ));
  await assertDeploymentRejected(`${deployment}\n\ngcloud storage rm gs://foreign-bucket/object\n`);
  await assertDeploymentRejected(`${deployment}\n\n\`gcloud storage buckets delete gs://foreign-bucket\`\n`);
  await assertDeploymentRejected(deployment.replace(
    "gcloud firestore databases create --project=$ProjectId --location=$FirestoreLocation --type=firestore-native",
    "gcloud storage rm gs://foreign-bucket/object --project=$ProjectId\nAssert-LastGcloudSuccess -Operation 'forged scoped delete'",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$ProjectState = gcloud projects describe $ProjectId --format=json | ConvertFrom-JsonPreservingStrings",
    "$ProjectState = gcloud projects describe $ProjectId --format=json; gcloud projects delete $ProjectId --project=$ProjectId --quiet",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$ProjectState = gcloud projects describe $ProjectId --format=json | ConvertFrom-JsonPreservingStrings",
    "$ProjectState = \"$(gcloud projects delete $ProjectId --project=$ProjectId --quiet)\"",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$AccessTokenLines = @(& gcloud auth print-access-token)",
    "gcloud auth print-access-token",
  ));
  await assertDeploymentRejected(deployment.replace(
    "gcloud firestore databases create --project=$ProjectId --location=$FirestoreLocation --type=firestore-native",
    "gcloud firestore databases create foreign-db --description=--project=$ProjectId\nAssert-LastGcloudSuccess -Operation 'forged embedded project flag'",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$EmbeddedDigestMatch.Groups[1].Value -ne $ResolvedDigest",
    "$false",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$AuthoritativeSourceBuild[0].source_location_sha256 -ne $SourceDeployBuildSourceLocationSha256",
    "$false",
  ));
  await assertDeploymentRejected(deployment.replace(
    "gcloud builds list --project=$ProjectId --region=$BuildLocation --limit=unlimited",
    "gcloud builds list --project=$ProjectId --limit=unlimited",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$PostDeleteProject.lifecycleState -ne 'DELETE_REQUESTED'",
    "$PostDeleteProject.lifecycleState -ne 'ACTIVE'",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$DescribeOutput -notmatch $RecognizedNotFoundPattern",
    "$false",
  ));
  await assertDeploymentRejected(deployment.replace(
    "process { [void]$JsonLines.Add($Json) }",
    "process { $JsonLines.Add($Json) }",
  ));
  await assertDeploymentRejected(deployment.replace(
    "-DateKind String -ErrorAction Stop",
    "-ErrorAction Stop",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$ProjectState = gcloud projects describe $ProjectId --format=json | ConvertFrom-JsonPreservingStrings",
    "$ProjectStateJson = gcloud projects describe $ProjectId --format=json\n$ProjectState = ConvertFrom-Json -InputObject $ProjectStateJson",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$ProjectState = gcloud projects describe $ProjectId --format=json | ConvertFrom-JsonPreservingStrings",
    "$ProjectStateJson = gcloud projects describe $ProjectId --format=json\n$ProjectState = Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $ProjectStateJson",
  ));
  await assertDeploymentRejected(deployment.replace(
    "$ProjectState = gcloud projects describe $ProjectId --format=json | ConvertFrom-JsonPreservingStrings",
    "$ProjectStateJson = gcloud projects describe $ProjectId --format=json\n$ProjectState = convertfrom-json -InputObject $ProjectStateJson",
  ));
});

test("extracted PowerShell guards execute fail-closed under StrictMode", async (t) => {
  const deployment = await readFile(path.join(projectRoot, "docs", "deployment.md"), "utf8");
  const sliceBetween = (startMarker, endMarker) => {
    const start = deployment.indexOf(startMarker);
    const end = deployment.indexOf(endMarker, start);
    assert.notEqual(start, -1, `missing ${startMarker}`);
    assert.notEqual(end, -1, `missing ${endMarker}`);
    return deployment.slice(start, end);
  };
  const inputGuard = sliceBetween("function Assert-AllSecretInputValues {", "\n\nfunction Test-ExactSecretFileBytes");
  const byteGuard = sliceBetween("function Test-ExactSecretFileBytes {", "\n\nfunction Remove-ProtectedSecretTempFile");
  const setGuard = sliceBetween(
    "    if ($LiveSecretIds.Count -ne $ExpectedSecretIds.Count -or @(Compare-Object $LiveSecretIds $ExpectedSecretIds).Count -ne 0) {",
    "\n    foreach ($SecretName in $SecretBootstrapNames)",
  );
  const locationGuard = sliceBetween(
    "            $LocationsProperty = $LocationsPage.PSObject.Properties['locations']",
    "\n        } while (-not [string]::IsNullOrWhiteSpace($PageToken))",
  );
  const jsonGuard = sliceBetween(
    "if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.5') {",
    "\n$ResourceIdentityPath = Join-Path $PWD \"docs/google-cloud-resource-identity.json\"",
  );
  const teardownGuard = sliceBetween("$PostDeleteState = $null", "\n$TeardownReceipt = [ordered]@{");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "found-roll-ps-guards-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const scriptPath = path.join(temporaryRoot, "guards.ps1");
  const script = `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
${jsonGuard}
${inputGuard}
${byteGuard}
$SecretBootstrapNames = @('a','b','c','d','e','f','g','h')
$SecretValues = [ordered]@{}
foreach ($Name in $SecretBootstrapNames) { $SecretValues[$Name] = "valid-secret-value-$Name-1234567890" }
Assert-AllSecretInputValues
$SecretValues['h'] = $SecretValues['a']
try { Assert-AllSecretInputValues; throw 'duplicate secret was accepted' } catch { if ($_.Exception.Message -eq 'duplicate secret was accepted') { throw } }
$SecretValues['h'] = 'weak'
try { Assert-AllSecretInputValues; throw 'weak secret was accepted' } catch { if ($_.Exception.Message -eq 'weak secret was accepted') { throw } }
$BytePath = Join-Path $PSScriptRoot 'secret.bin'
[System.IO.File]::WriteAllBytes($BytePath, [Text.UTF8Encoding]::new($false).GetBytes('exact-secret-value-1234567890'))
if (-not (Test-ExactSecretFileBytes -Path $BytePath -ExpectedValue 'exact-secret-value-1234567890')) { throw 'exact bytes rejected' }
if (Test-ExactSecretFileBytes -Path $BytePath -ExpectedValue 'wrong-secret-value-1234567890') { throw 'wrong bytes accepted' }
$LiveSecretIds = @('a','b'); $ExpectedSecretIds = @('a','b')
${setGuard}
$ExpectedSecretIds = @('a','c')
try { ${setGuard}; throw 'changed secret set accepted' } catch { if ($_.Exception.Message -eq 'changed secret set accepted') { throw } }
$ProjectId = 'found-roll-agentic-20260830'; $ProjectNumber = '1061926987746'; $Locations = @('global'); $LocationsPage = [pscustomobject]@{ locations = @() }
${locationGuard}
if ($PageToken -ne '') { throw 'missing final nextPageToken was not normalized to empty' }
function Invoke-PostDeleteDecision {
    param([int]$InputExitCode, [string]$InputOutput)
    $ExpectedProjectId = 'found-roll-agentic-20260830'
    $ExpectedProjectNumber = '1061926987746'
    $ExpectedProjectCreatedAt = '2026-08-29T22:58:52.064Z'
    $ExpectedLabelKey = 'found-roll-purpose'
    $ExpectedLabelValue = 'dedicated-hackathon-demo'
    $DescribeExitCode = $InputExitCode
    $DescribeOutput = $InputOutput
    ${teardownGuard}
    return "$PostDeleteState|$PostDeleteNotFoundConfirmed"
}
$DeleteRequestedObject = [ordered]@{ projectId='found-roll-agentic-20260830'; projectNumber='1061926987746'; createTime='2026-08-29T22:58:52.064Z'; lifecycleState='DELETE_REQUESTED'; labels=@{ 'found-roll-purpose'='dedicated-hackathon-demo' } }
$DeleteRequested = $DeleteRequestedObject | ConvertTo-Json -Compress
$DeleteRequestedMultiline = $DeleteRequestedObject | ConvertTo-Json -Depth 5
$ParsedCompressed = $DeleteRequested | ConvertFrom-JsonPreservingStrings
$ParsedMultiline = $DeleteRequestedMultiline | ConvertFrom-JsonPreservingStrings
if ($ParsedCompressed.createTime -isnot [string] -or $ParsedCompressed.createTime -cne '2026-08-29T22:58:52.064Z') { throw 'compressed timestamp string was not preserved' }
if ($ParsedMultiline.createTime -isnot [string] -or $ParsedMultiline.createTime -cne '2026-08-29T22:58:52.064Z') { throw 'multiline timestamp string was not preserved' }
if ((Invoke-PostDeleteDecision 0 $DeleteRequested) -ne 'DELETE_REQUESTED|False') { throw 'exact DELETE_REQUESTED rejected' }
if ((Invoke-PostDeleteDecision 0 $DeleteRequestedMultiline) -ne 'DELETE_REQUESTED|False') { throw 'exact multiline DELETE_REQUESTED rejected' }
if ((Invoke-PostDeleteDecision 1 'ERROR: (gcloud.projects.describe) [found-roll-agentic-20260830] not found.') -ne 'NOT_FOUND|True') { throw 'exact NOT_FOUND rejected' }
$InvalidCases = @(
    @{ Exit=0; Output='' },
    @{ Exit=1; Output='ERROR: permission denied' },
    @{ Exit=0; Output='not-json' },
    @{ Exit=0; Output=($DeleteRequested -replace 'DELETE_REQUESTED','ACTIVE') },
    @{ Exit=0; Output=($DeleteRequested -replace 'found-roll-agentic-20260830','other-project-12345') },
    @{ Exit=0; Output=($DeleteRequested -replace '22:58:52.064Z','22:58:52.065Z') }
)
foreach ($Case in $InvalidCases) {
    $Rejected = $false
    try { [void](Invoke-PostDeleteDecision $Case.Exit $Case.Output) } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'invalid post-delete result was accepted' }
}
'POWERSHELL_GUARDS_PASS'
`;
  await writeFile(scriptPath, script, "utf8");
  const powershell = "pwsh";
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /POWERSHELL_GUARDS_PASS/);
});

test("the preflight refresh helper rejects a billing-account relink within one attestation batch", async (t) => {
  const fixture = await createFixture(t);
  const originalBillingAccountResource = "billingAccounts/AAAAAA-AAAAAA-AAAAAA";
  const relinkedBillingAccountResource = "billingAccounts/BBBBBB-BBBBBB-BBBBBB";
  fixture.billingPreflightReceipt.billing_account_name_sha256 = sha256(originalBillingAccountResource);
  await rebindPreflightReceipt(fixture, "billing");
  await writeJson(fixture.recordPath, fixture.record);

  const helperPath = path.join(fixture.repoRoot, "scripts", "refresh-google-cloud-preflight.ps1");
  await writeFile(
    helperPath,
    await readFile(path.join(projectRoot, "scripts", "refresh-google-cloud-preflight.ps1"), "utf8"),
    "utf8",
  );
  for (const filename of [
    "google-cloud-billing-preflight.template.json",
    "google-cloud-spend-cap.template.json",
    "submission-release.template.json",
  ]) {
    await writeFile(
      path.join(fixture.repoRoot, "docs", filename),
      await readFile(path.join(projectRoot, "docs", filename), "utf8"),
      "utf8",
    );
  }

  const mockGcloudPath = path.join(fixture.repoRoot, "scripts", "mock-gcloud.ps1");
  const mockGcloud = `$JoinedArguments = $args -join ' '
if ($JoinedArguments -like 'projects describe *') {
    '{"projectId":"found-roll-agentic-20260830","projectNumber":"1061926987746","createTime":"2026-08-29T22:58:52.064Z","lifecycleState":"ACTIVE","labels":{"found-roll-purpose":"dedicated-hackathon-demo"}}'
    $global:LASTEXITCODE = 0
    return
}
if ($JoinedArguments -like 'billing projects describe *') {
    '{"billingEnabled":true,"billingAccountName":"${relinkedBillingAccountResource}"}'
    $global:LASTEXITCODE = 0
    return
}
if ($JoinedArguments -like 'billing accounts describe *') {
    '{"open":true}'
    $global:LASTEXITCODE = 0
    return
}
$global:LASTEXITCODE = 2
throw "Unexpected mocked gcloud invocation: $JoinedArguments"
`;
  await writeFile(mockGcloudPath, mockGcloud, "utf8");

  const result = spawnSync("pwsh", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-ProjectId",
    "found-roll-agentic-20260830",
    "-GcloudPath",
    mockGcloudPath,
    "-AttestationTextSha256",
    approvedEntrantAttestationSha256,
    "-AttestedAtUtc",
    fixture.billingPreflightReceipt.attested_at_utc,
    "-AttestationBatchId",
    fixture.billingPreflightReceipt.attestation_batch_id,
  ], {
    cwd: fixture.repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /billing account.*(?:changed|relink|attestation batch)/i);
  const preservedReceipt = JSON.parse(await readFile(fixture.billingPreflightPath, "utf8"));
  assert.equal(preservedReceipt.billing_account_name_sha256, sha256(originalBillingAccountResource));
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
    ["google-cloud-billing-preflight.template.json", "found-roll-google-cloud-billing-preflight"],
    ["google-cloud-spend-cap.template.json", "found-roll-google-cloud-spend-cap-preflight"],
    ["google-cloud-project-storage-audit.template.json", "found-roll-google-cloud-project-storage-audit"],
  ];
  for (const [filename, kind] of templates) {
    const template = JSON.parse(await readFile(path.join(projectRoot, "docs", filename), "utf8"));
    assert.equal(template.kind, kind);
    assert.equal(template.status, "BLOCKED");
  }
  const storageTemplate = JSON.parse(
    await readFile(path.join(projectRoot, "docs", "google-cloud-project-storage-audit.template.json"), "utf8"),
  );
  assert.equal(Array.isArray(storageTemplate.buckets), true);
  assert.equal(Array.isArray(storageTemplate.buckets[0].current_objects), true);
  assert.equal(Array.isArray(storageTemplate.buckets[0].all_version_objects), true);
  assert.equal(Array.isArray(storageTemplate.buckets[0].soft_deleted_objects), true);
  assert.equal("all_version_object_inventory_sha256" in storageTemplate.buckets[0], true);
});

function git(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("the CLI direct-invocation guard resolves a symlinked scripts directory", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "found-roll-cli-link-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const scriptsLink = path.join(temporaryRoot, "scripts-link");
  await symlink(path.dirname(verifierPath), scriptsLink, process.platform === "win32" ? "junction" : "dir");
  const cli = spawnSync(process.execPath, [path.join(scriptsLink, path.basename(verifierPath)), "--help"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^Usage: node scripts\/verify-submission-readiness\.mjs/m);
});

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

  let preflightCli = spawnSync(process.execPath, [
    verifierPath,
    "--repo-root",
    fixture.repoRoot,
    "--record",
    fixture.recordPath,
    "--preflight-only",
  ], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(preflightCli.status, 0, preflightCli.stderr);
  assert.match(preflightCli.stdout, /GOOGLE CLOUD PREFLIGHT: PASS/);

  const teardownCli = spawnSync(process.execPath, [
    verifierPath,
    "--repo-root",
    fixture.repoRoot,
    "--record",
    fixture.recordPath,
    "--teardown-identity-only",
  ], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(teardownCli.status, 0, teardownCli.stderr);
  assert.match(teardownCli.stdout, /GOOGLE CLOUD TEARDOWN IDENTITY: PASS/);

  await writeFile(
    path.join(fixture.repoRoot, ".gitignore"),
    "artifacts/private/*\n!artifacts/private/billing-overview-receipt.json\n",
    "utf8",
  );
  preflightCli = spawnSync(process.execPath, [
    verifierPath,
    "--repo-root",
    fixture.repoRoot,
    "--record",
    fixture.recordPath,
    "--preflight-only",
  ], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(preflightCli.status, 1);
  assert.match(preflightCli.stderr, /PRIVATE_ARTIFACT_GIT_STATE/);

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

  preflightCli = spawnSync(process.execPath, [
    verifierPath,
    "--repo-root",
    fixture.repoRoot,
    "--record",
    fixture.recordPath,
    "--preflight-only",
  ], { encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(preflightCli.status, 1);
  assert.match(preflightCli.stderr, /PRIVATE_ARTIFACT_GIT_STATE/);
});
