import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export const RELEASE_RECORD_SCHEMA_VERSION = "2";
export const SUBMISSION_TEMPLATE_PATH = "docs/submission-release.template.json";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
const canonicalDefaultRepoRoot = realpathSync.native(defaultRepoRoot);
const maxJsonBytes = 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const preflightFreshnessMilliseconds = 24 * 60 * 60 * 1000;
const operationalPreflightFreshnessMilliseconds = 10 * 60 * 1000;
const preflightFutureSkewMilliseconds = 5 * 60 * 1000;
const googleCloudAttestationVersion = "found-roll-zero-real-money-v1";
const googleCloudAttestationSource = "entrant_direct_confirmation";
const expectedEntrantAttestationTextSha256 = "5ab75588420cca012f174e63eba3ca05f83e88cad99f93916543a335171b6a82";
const googleCloudAttestationBatchPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const expectedSpendCapMinorUnits = Object.freeze({
  cloud_run: 1000,
  agent_platform: 500,
});
const sha256Pattern = /^[a-f0-9]{64}$/i;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,255}$/;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const projectNumberPattern = /^\d{6,20}$/;
const bucketNamePattern = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const weakSimulatorEtagPattern = /^W\/"sim-[a-z0-9][a-z0-9-]{2,180}-v[1-9]\d*"$/;
const expectedGoogleCloudResourceIdentity = Object.freeze({
  schema_version: "1",
  kind: "found-roll-google-cloud-resource-identity",
  project_id: "found-roll-agentic-20260830",
  project_number: "1061926987746",
  project_created_at_utc: "2026-08-29T22:58:52.064Z",
  evidence_bucket: "found-roll-agentic-20260830-found-roll-evidence",
  dedicated_project_label_key: "found-roll-purpose",
  dedicated_project_label_value: "dedicated-hackathon-demo",
});
const allowedFrictionModes = new Set(["first_person_lived", "first_person_observed", "research_informed"]);
const allowedLicenseDecisions = new Set(["all_rights_reserved", "open_source"]);
const allowedOpenSourceSpdxIdentifiers = new Set(["MIT"]);
const allowedRepositoryVisibilities = new Set(["public", "private"]);
const repositoryHosts = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
const videoHosts = new Set(["youtube.com", "www.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com"]);
const placeholderPatterns = [
  /(?:\[\s*submission\s+blocker|submission\s+blocker\s*(?::|—)|remains?\s+(?:an?\s+)?submission\s+blocker)/i,
  /\[(?:fill|replace)\b[^\]]*\]/i,
  /\[must contain actual results\]/i,
  /replace this entire block/i,
  /do not submit this placeholder/i,
  /\b(?:TODO|TBD|FIXME)\b/,
];
const sensitiveKeyPattern = /^(?:answer|private_answer|expected_answer|raw_answer|token|raw_token|claimant_token|custodian_token|access_token|refresh_token|credentials?|raw_credential|credential_value|secret|client_secret|api_key|password|authorization|authorization_header|signed_url|private_key|service_account_key)$/i;
const richArtifactKeyPattern = /^(?:events|candidates|passport|snapshot|staff_snapshot|staff_surface|staff_surfaces|staff_response|claimant_response|manifest|evidence_bytes|image_bytes|model_prompt|model_response)$/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i;
const claimantLinkPattern = /\bfrcl_[A-Za-z0-9_-]+\b/i;
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const sensitiveQueryKeyPattern = /^(?:access_token|auth|authorization|credential|expires|googleaccessid|key|password|secret|signature|token|x-goog-.+|x-amz-.+)$/i;
export const requiredFrozenFilePaths = [
  "README.md",
  "LICENSE",
  "NOTICE.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "package-lock.json",
  "public/legal/FOUND-ROLL-LICENSE.txt",
  "public/legal/THIRD-PARTY-LICENSES.txt",
  "service/requirements.lock",
  "service/requirements-dev.lock",
  "simulator/requirements.lock",
  "simulator/requirements-dev.lock",
  "public/assets/README.md",
  "public/assets/claimant-match.jpg",
  "public/assets/northport-intake.jpg",
  "public/assets/pouch-front.jpg",
  "public/assets/pouch-interior.jpg",
  "public/assets/pouch-rear.jpg",
  "evaluation/fixtures.json",
  "evaluation/privacy-canaries.json",
  "evaluation/results.json",
  "evaluation/privacy-scan-results.json",
  "evaluation/privacy-scan-docs-results.json",
  "artifacts/verification/inventory-gateway-http-smoke-receipt.json",
  "artifacts/verification/local-canonical-preparation-receipt.json",
  "artifacts/verification/service-client-http-smoke-receipt.json",
  "artifacts/verification/frontend-build-manifest.json",
  "scripts/prepare-canonical-run.ps1",
  "scripts/verify-submission-readiness.mjs",
  "docs/architecture.md",
  "docs/architecture-diagram.manifest.json",
  "docs/architecture-diagram.mmd",
  "docs/architecture-diagram.png",
  "docs/google-cloud-resource-identity.json",
  "docs/deployment.md",
  "docs/devpost-submission.md",
  "docs/demo-script.md",
];
const allowedAgentTools = new Set([
  "search_custodian",
  "load_candidate",
  "submit_observations",
  "propose_discriminator",
  "request_manual_review",
]);
const allowedToolOutcomes = new Set(["success", "denied", "abstained", "unavailable"]);
const liveAgentInvocationCap = 12;
const allowedCustodyStates = new Set([
  "RECEIVED",
  "EVIDENCE_READY",
  "ANALYZING",
  "CANDIDATES_READY",
  "CLARIFICATION_REQUIRED",
  "CLAIM_EVIDENCE_ACCEPTED",
  "IDENTITY_ATTESTED",
  "APPROVAL_REQUIRED",
  "RESERVE_REQUESTED",
  "RESERVED",
  "CLAIMANT_PRESENT",
  "RELEASE_REQUESTED",
  "RELEASED",
  "CLOSED",
  "SECURITY_ESCALATION",
  "NO_MATCH",
  "MANUAL_REVIEW",
  "REJECTED",
  "EXPIRED",
  "RECONCILIATION_REQUIRED",
]);
const expectedFrozenDemoTrajectory = [
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
const expectedContractVersions = {
  prompt: "found-roll-case-analyst-prompt-v2",
  output_schema: "found-roll-analysis-proposal-v1",
  policy: "found-roll-release-v1",
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addFailure(failures, code, message) {
  if (!failures.some((failure) => failure.code === code && failure.message === message)) {
    failures.push({ code, message });
  }
}

function checkObject(value, fieldPath, allowedKeys, failures) {
  if (!isPlainObject(value)) {
    addFailure(failures, "RECORD_SCHEMA", `${fieldPath} must be an object.`);
    return false;
  }
  const unknownCount = Object.keys(value).filter((key) => !allowedKeys.includes(key)).length;
  if (unknownCount) {
    addFailure(failures, "RECORD_UNKNOWN_FIELDS", `${fieldPath} contains ${unknownCount} field(s) outside the identifier-only schema.`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      addFailure(failures, "RECORD_MISSING_FIELD", `${fieldPath}.${key} is required.`);
    }
  }
  return true;
}

function requireTrue(value, fieldPath, failures) {
  if (value !== true) addFailure(failures, "CONFIRMATION_REQUIRED", `${fieldPath} must be explicitly true.`);
}

function containsPlaceholder(value) {
  return typeof value !== "string" || !value.trim() || /[<>]|\b(?:unset|replace|placeholder|todo|tbd)\b/i.test(value);
}

function requireIdentifier(value, fieldPath, failures, pattern = identifierPattern) {
  if (containsPlaceholder(value) || !pattern.test(value)) {
    addFailure(failures, "IDENTIFIER_REQUIRED", `${fieldPath} must contain a non-placeholder identifier in the expected format.`);
    return false;
  }
  return true;
}

function requireSha256(value, fieldPath, failures) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    addFailure(failures, "SHA256_REQUIRED", `${fieldPath} must be a 64-character SHA-256 digest.`);
    return false;
  }
  return true;
}

function requireNonNegativeInteger(value, fieldPath, failures) {
  if (!Number.isSafeInteger(value) || value < 0) {
    addFailure(failures, "NON_NEGATIVE_INTEGER_REQUIRED", `${fieldPath} must be a non-negative safe integer.`);
    return false;
  }
  return true;
}

function requireUtcTimestamp(value, fieldPath, failures) {
  if (typeof value !== "string" || !/Z$/i.test(value) || Number.isNaN(Date.parse(value))) {
    addFailure(failures, "UTC_TIMESTAMP_REQUIRED", `${fieldPath} must be an ISO-8601 UTC timestamp ending in Z.`);
    return false;
  }
  return true;
}

function requireUtcInstant(value, fieldPath, failures) {
  if (typeof value !== "string" || !/(?:Z|\+00:00)$/i.test(value) || Number.isNaN(Date.parse(value))) {
    addFailure(failures, "UTC_TIMESTAMP_REQUIRED", `${fieldPath} must be an ISO-8601 UTC timestamp.`);
    return false;
  }
  return true;
}

function validateReceiptBinding(binding, fieldPath, failures) {
  if (!checkObject(binding, fieldPath, ["path", "sha256"], failures)) return;
  requireIdentifier(binding.path, `${fieldPath}.path`, failures, /^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$/);
  requireSha256(binding.sha256, `${fieldPath}.sha256`, failures);
}

function validateGoogleCloudRecord(googleCloud, failures, { requireDeploymentReady = true } = {}) {
  if (!checkObject(googleCloud, "release_record.google_cloud", [
    "project_id",
    "project_number",
    "project_created_at_utc",
    "evidence_bucket",
    "dedicated_project_confirmed",
    "dedicated_project_label_key",
    "dedicated_project_label_value",
    "billing_enabled_confirmed",
    "billing_account_type",
    "free_trial_remaining_credit_confirmed",
    "free_trial_remaining_time_confirmed",
    "paid_activation_absent_confirmed",
    "cloud_run_spend_cap_confirmed",
    "agent_platform_spend_cap_confirmed",
    "required_apis_enabled_confirmed",
    "iam_ready_confirmed",
    "quota_ready_confirmed",
    "resource_identity",
    "canonical_revision_images",
    "project_storage_receipts",
    "preflight_receipts",
  ], failures)) return;

  requireIdentifier(googleCloud.project_id, "release_record.google_cloud.project_id", failures, projectIdPattern);
  requireIdentifier(googleCloud.project_number, "release_record.google_cloud.project_number", failures, projectNumberPattern);
  requireUtcTimestamp(googleCloud.project_created_at_utc, "release_record.google_cloud.project_created_at_utc", failures);
  requireIdentifier(googleCloud.evidence_bucket, "release_record.google_cloud.evidence_bucket", failures, bucketNamePattern);
  if (googleCloud.evidence_bucket !== `${googleCloud.project_id}-found-roll-evidence`) {
    addFailure(failures, "EVIDENCE_BUCKET_BINDING", "release_record.google_cloud.evidence_bucket must be the dedicated project-derived Found Roll evidence bucket.");
  }
  if (
    googleCloud.dedicated_project_label_key !== "found-roll-purpose"
    || googleCloud.dedicated_project_label_value !== "dedicated-hackathon-demo"
  ) {
    addFailure(failures, "DEDICATED_PROJECT_LABEL", "release_record.google_cloud must bind the exact Found Roll dedicated-project label.");
  }
  if (googleCloud.billing_account_type !== "free_trial") {
    addFailure(failures, "FREE_TRIAL_REQUIRED", "release_record.google_cloud.billing_account_type must be exactly free_trial; paid, upgraded, expired, absent, or unverified billing is not authorized.");
  }
  for (const key of [
    "dedicated_project_confirmed",
    "billing_enabled_confirmed",
    "free_trial_remaining_credit_confirmed",
    "free_trial_remaining_time_confirmed",
    "paid_activation_absent_confirmed",
    "cloud_run_spend_cap_confirmed",
    "agent_platform_spend_cap_confirmed",
  ]) {
    requireTrue(googleCloud[key], `release_record.google_cloud.${key}`, failures);
  }
  for (const key of ["required_apis_enabled_confirmed", "iam_ready_confirmed", "quota_ready_confirmed"]) {
    if (requireDeploymentReady) {
      requireTrue(googleCloud[key], `release_record.google_cloud.${key}`, failures);
    } else if (typeof googleCloud[key] !== "boolean") {
      addFailure(failures, "RECORD_SCHEMA", `release_record.google_cloud.${key} must be a boolean.`);
    }
  }

  validateReceiptBinding(googleCloud.resource_identity, "release_record.google_cloud.resource_identity", failures);
  if (googleCloud.resource_identity?.path !== "docs/google-cloud-resource-identity.json") {
    addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", "release_record.google_cloud.resource_identity must bind the tracked dedicated-project identity document.");
  }
  if (requireDeploymentReady && checkObject(
    googleCloud.canonical_revision_images,
    "release_record.google_cloud.canonical_revision_images",
    ["app", "simulator"],
    failures,
  )) {
    for (const [key, expectedService] of [["app", "found-roll-app"], ["simulator", "found-roll-simulator"]]) {
      const binding = googleCloud.canonical_revision_images[key];
      const fieldPath = `release_record.google_cloud.canonical_revision_images.${key}`;
      if (!checkObject(binding, fieldPath, [
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
      ], failures)) continue;
      const expectedRegion = "us-central1";
      const expectedServiceResource = `projects/${googleCloud.project_number}/locations/${expectedRegion}/services/${expectedService}`;
      const expectedRevisionResource = `${expectedServiceResource}/revisions/${binding.revision}`;
      if (
        binding.project_id !== googleCloud.project_id
        || binding.project_number !== googleCloud.project_number
        || binding.region !== expectedRegion
        || binding.service !== expectedService
        || binding.service_resource !== expectedServiceResource
        || binding.revision_resource !== expectedRevisionResource
      ) {
        addFailure(failures, "CANONICAL_REVISION_IMAGE", `${fieldPath} must identify the exact dedicated-project Cloud Run service and revision resources.`);
      }
      requireIdentifier(binding.revision, `${fieldPath}.revision`, failures);
      if (!new RegExp(`^${expectedService}-\\d{5}-[a-z0-9]{3}$`).test(String(binding.revision || ""))) {
        addFailure(failures, "CANONICAL_REVISION_IMAGE", `${fieldPath}.revision must be an exact revision of ${expectedService}.`);
      }
      const origin = parseHttpsUrl(binding.origin, `${fieldPath}.origin`, failures);
      if (origin && (binding.origin !== origin.origin || !origin.hostname.toLowerCase().endsWith(".run.app"))) {
        addFailure(failures, "CANONICAL_REVISION_IMAGE", `${fieldPath}.origin must be the exact Cloud Run HTTPS status origin without a path.`);
      }
      requireUtcTimestamp(binding.revision_created_at_utc, `${fieldPath}.revision_created_at_utc`, failures);
      if (!imageDigestPattern.test(String(binding.image_digest || ""))) {
        addFailure(failures, "CANONICAL_REVISION_IMAGE", `${fieldPath}.image_digest must be an exact SHA-256 container digest.`);
      }
      const expectedImagePrefix = `${expectedRegion}-docker.pkg.dev/${googleCloud.project_id}/cloud-run-source-deploy/`;
      const imagePackageSuffix = typeof binding.image_package === "string" ? binding.image_package.slice(expectedImagePrefix.length) : "";
      if (
        typeof binding.image_package !== "string"
        || !binding.image_package.startsWith(expectedImagePrefix)
        || !/^[^/:@\s]+$/.test(imagePackageSuffix)
        || binding.image_resource !== `${binding.image_package}@${binding.image_digest}`
      ) {
        addFailure(failures, "CANONICAL_REVISION_IMAGE", `${fieldPath} must bind the exact dedicated-project Artifact Registry package and package@digest resource.`);
      }
    }
  }
  if (checkObject(googleCloud.project_storage_receipts, "release_record.google_cloud.project_storage_receipts", [
    "after_app_source_deploy",
    "after_simulator_source_deploy",
  ], failures) && requireDeploymentReady) {
    for (const key of ["after_app_source_deploy", "after_simulator_source_deploy"]) {
      validateReceiptBinding(
        googleCloud.project_storage_receipts[key],
        `release_record.google_cloud.project_storage_receipts.${key}`,
        failures,
      );
    }
    const expectedPaths = {
      after_app_source_deploy: "artifacts/private/storage-after-app-source-deploy.json",
      after_simulator_source_deploy: "artifacts/private/storage-after-simulator-source-deploy.json",
    };
    for (const [key, expectedPath] of Object.entries(expectedPaths)) {
      if (googleCloud.project_storage_receipts[key]?.path !== expectedPath) {
        addFailure(failures, "PROJECT_STORAGE_RECEIPT", `release_record.google_cloud.project_storage_receipts.${key}.path must be ${expectedPath}.`);
      }
    }
  }

  if (checkObject(googleCloud.preflight_receipts, "release_record.google_cloud.preflight_receipts", [
    "billing_overview",
    "cloud_run_spend_cap",
    "agent_platform_spend_cap",
  ], failures)) {
    for (const key of ["billing_overview", "cloud_run_spend_cap", "agent_platform_spend_cap"]) {
      validateReceiptBinding(
        googleCloud.preflight_receipts[key],
        `release_record.google_cloud.preflight_receipts.${key}`,
        failures,
      );
    }
  }
}

async function validateGoogleCloudResourceIdentity(repoRoot, releaseRecord, failures) {
  const relativePath = "docs/google-cloud-resource-identity.json";
  const binding = releaseRecord?.google_cloud?.resource_identity;
  const raw = await loadRepositoryFile(repoRoot, relativePath, "release_record.google_cloud.resource_identity.path", failures);
  if (!raw) {
    addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", `${relativePath} could not be read as a regular repository file.`);
    return;
  }
  if (!isPlainObject(binding) || binding.path !== relativePath || !sha256Pattern.test(String(binding.sha256 || ""))) {
    addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", "The release record must bind the tracked dedicated-project identity path and SHA-256.");
  } else if (sha256(raw) !== binding.sha256.toLowerCase()) {
    addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", "The tracked dedicated-project identity does not match its release-record SHA-256.");
  }
  let identity;
  try {
    identity = JSON.parse(raw.toString("utf8"));
  } catch {
    addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", `${relativePath} is not valid JSON.`);
    return;
  }
  const identityKeys = Object.keys(expectedGoogleCloudResourceIdentity);
  if (!checkObject(identity, "google_cloud_resource_identity", identityKeys, failures)) return;
  for (const [key, expected] of Object.entries(expectedGoogleCloudResourceIdentity)) {
    if (identity[key] !== expected) {
      addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", `google_cloud_resource_identity.${key} does not match the pre-authorized dedicated project.`);
    }
  }
  const releaseFields = {
    project_id: releaseRecord?.google_cloud?.project_id,
    project_number: releaseRecord?.google_cloud?.project_number,
    project_created_at_utc: releaseRecord?.google_cloud?.project_created_at_utc,
    evidence_bucket: releaseRecord?.google_cloud?.evidence_bucket,
    dedicated_project_label_key: releaseRecord?.google_cloud?.dedicated_project_label_key,
    dedicated_project_label_value: releaseRecord?.google_cloud?.dedicated_project_label_value,
  };
  for (const [key, releaseValue] of Object.entries(releaseFields)) {
    if (identity[key] !== releaseValue) {
      addFailure(failures, "GOOGLE_CLOUD_RESOURCE_IDENTITY", `release_record.google_cloud.${key} does not match the tracked dedicated-project identity.`);
    }
  }
}

function isReservedHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  const ipVersion = isIP(host);
  const reservedNames = [
    "example",
    "example.com",
    "example.net",
    "example.org",
    "invalid",
    "localhost",
    "test",
  ];
  if (
    !host
    || (!host.includes(".") && !ipVersion)
    || reservedNames.some((name) => host === name || host.endsWith(`.${name}`))
    || host.endsWith(".local")
    || host.endsWith(".localhost")
  ) return true;

  if (ipVersion === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0)
    );
  }
  if (ipVersion === 6) {
    return host === "::" || host === "::1"
      || host.startsWith("::ffff:")
      || host.startsWith("fc") || host.startsWith("fd")
      || /^fe[89ab]/.test(host)
      || host.startsWith("ff")
      || host.startsWith("2001:db8:");
  }
  return false;
}

function parseHttpsUrl(value, fieldPath, failures, { allowedHosts, allowQuery = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    addFailure(failures, "HTTPS_URL_REQUIRED", `${fieldPath} must be a valid HTTPS URL.`);
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || url.port
    || (!allowQuery && url.search)
    || isReservedHostname(host)
    || (allowedHosts && !allowedHosts.has(host))
  ) {
    addFailure(failures, "HTTPS_URL_REQUIRED", `${fieldPath} must be a public HTTPS URL on the permitted host without embedded credentials or disallowed URL parts.`);
    return null;
  }
  return url;
}

function validatePublicVideoUrl(value, fieldPath, failures) {
  const url = parseHttpsUrl(value, fieldPath, failures, { allowedHosts: videoHosts, allowQuery: true });
  if (!url) return;
  const host = url.hostname.toLowerCase();
  const pathParts = url.pathname.split("/").filter(Boolean);
  const youtubeWatch = (host === "youtube.com" || host === "www.youtube.com")
    && ((url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) || (pathParts[0] === "shorts" && Boolean(pathParts[1])));
  const youtubeShort = host === "youtu.be" && pathParts.length === 1;
  const vimeoVideo = (host === "vimeo.com" || host === "www.vimeo.com") && pathParts.length === 1 && /^\d+$/.test(pathParts[0]);
  if (!youtubeWatch && !youtubeShort && !vimeoVideo) {
    addFailure(failures, "VIDEO_URL", `${fieldPath} must identify a specific public YouTube or Vimeo video.`);
  }
}

function isSensitiveKey(key) {
  return sensitiveKeyPattern.test(key)
    || /(?:^|_)answer(?:_|$)/i.test(key)
    || /(?:^|_)raw_[A-Za-z0-9_]*(?:token|credential|secret)(?:_|$)/i.test(key);
}

function scanSensitiveContent(value, fieldPath, failures, seen = new WeakSet(), { rejectRichArtifacts = false } = {}) {
  if (typeof value === "string") {
    let hasSensitiveQuery = false;
    try {
      const parsed = new URL(value);
      hasSensitiveQuery = [...parsed.searchParams.keys()].some((key) => sensitiveQueryKeyPattern.test(key));
    } catch {
      // Most receipt identifiers are not URLs.
    }
    if (bearerPattern.test(value) || claimantLinkPattern.test(value) || privateKeyPattern.test(value) || hasSensitiveQuery) {
      addFailure(failures, "SENSITIVE_VALUE", `Sensitive-looking content is not allowed at ${fieldPath}.`);
    }
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveContent(item, `${fieldPath}[${index}]`, failures, seen, { rejectRichArtifacts }));
    return;
  }
  let fieldIndex = 0;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${fieldPath}.field[${fieldIndex}]`;
    fieldIndex += 1;
    if (isSensitiveKey(key)) {
      addFailure(failures, "SENSITIVE_FIELD", `Secret-bearing field names are not allowed at ${childPath}.`);
    }
    if (rejectRichArtifacts && richArtifactKeyPattern.test(key)) {
      addFailure(failures, "RICH_ARTIFACT_CONTENT", `Rich staff/publication content is not allowed at ${childPath}; keep only private hash/path bindings.`);
    }
    scanSensitiveContent(child, childPath, failures, seen, { rejectRichArtifacts });
  }
}

function validateReleaseRecord(record, failures) {
  if (!checkObject(record, "release_record", [
    "schema_version",
    "kind",
    "status",
    "created_at_utc",
    "category",
    "eligibility",
    "friction_story",
    "google_cloud",
    "hosted_project",
    "repository",
    "receipts",
    "frozen_contracts",
    "frozen_files",
    "frontend_artifact",
    "video",
    "publication_review",
    "license",
  ], failures)) return;

  if (record.schema_version !== RELEASE_RECORD_SCHEMA_VERSION) {
    addFailure(failures, "SCHEMA_VERSION", "release_record.schema_version must match the supported schema version.");
  }
  if (record.kind !== "found-roll-submission-release") {
    addFailure(failures, "RELEASE_KIND", "release_record.kind must be found-roll-submission-release.");
  }
  if (record.status !== "FROZEN") {
    addFailure(failures, "RELEASE_STATUS", "release_record.status must be FROZEN before submission.");
  }
  requireUtcTimestamp(record.created_at_utc, "release_record.created_at_utc", failures);
  if (record.category !== "Taskmaster") {
    addFailure(failures, "SUBMISSION_CATEGORY", "release_record.category must be Taskmaster.");
  }

  if (checkObject(record.eligibility, "release_record.eligibility", [
    "entrant_eligible_confirmed",
    "team_eligibility_confirmed",
    "official_rules_accepted_confirmed",
    "ownership_confirmed",
    "third_party_authorizations_confirmed",
    "new_project_confirmed",
  ], failures)) {
    for (const key of ["entrant_eligible_confirmed", "team_eligibility_confirmed", "official_rules_accepted_confirmed", "ownership_confirmed", "third_party_authorizations_confirmed", "new_project_confirmed"]) {
      requireTrue(record.eligibility[key], `release_record.eligibility.${key}`, failures);
    }
  }

  if (checkObject(record.friction_story, "release_record.friction_story", ["mode", "truthful_mode_confirmed"], failures)) {
    if (!allowedFrictionModes.has(record.friction_story.mode)) {
      addFailure(failures, "FRICTION_MODE", "release_record.friction_story.mode must identify a supported truthful provenance mode.");
    }
    requireTrue(record.friction_story.truthful_mode_confirmed, "release_record.friction_story.truthful_mode_confirmed", failures);
  }

  validateGoogleCloudRecord(record.google_cloud, failures);

  if (checkObject(record.hosted_project, "release_record.hosted_project", ["url", "clean_browser_verified", "judge_access_verified"], failures)) {
    parseHttpsUrl(record.hosted_project.url, "release_record.hosted_project.url", failures);
    requireTrue(record.hosted_project.clean_browser_verified, "release_record.hosted_project.clean_browser_verified", failures);
    requireTrue(record.hosted_project.judge_access_verified, "release_record.hosted_project.judge_access_verified", failures);
  }

  if (checkObject(record.repository, "release_record.repository", [
    "url",
    "commit_sha",
    "tree_sha",
    "release_tag",
    "visibility",
    "judge_access_verified",
    "testing_devpost_access_confirmed",
    "google_hackathons_access_confirmed",
    "release_tag_published_confirmed",
  ], failures)) {
    const repositoryUrl = parseHttpsUrl(record.repository.url, "release_record.repository.url", failures, { allowedHosts: repositoryHosts });
    if (repositoryUrl) {
      const pathParts = repositoryUrl.pathname.split("/").filter(Boolean);
      if (pathParts.length < 2) addFailure(failures, "REPOSITORY_URL", "release_record.repository.url must identify a repository path.");
    }
    requireIdentifier(record.repository.commit_sha, "release_record.repository.commit_sha", failures, commitPattern);
    requireIdentifier(record.repository.tree_sha, "release_record.repository.tree_sha", failures, commitPattern);
    const validTag = requireIdentifier(record.repository.release_tag, "release_record.repository.release_tag", failures, tagPattern);
    if (validTag && (/\.\.|@\{|\/\//.test(record.repository.release_tag) || /[/.]$/.test(record.repository.release_tag))) {
      addFailure(failures, "RELEASE_TAG", "release_record.repository.release_tag is not a safe Git tag name.");
    }
    if (!allowedRepositoryVisibilities.has(record.repository.visibility)) {
      addFailure(failures, "REPOSITORY_VISIBILITY", "release_record.repository.visibility must be public or private.");
    }
    requireTrue(record.repository.judge_access_verified, "release_record.repository.judge_access_verified", failures);
    if (record.repository.visibility === "private") {
      requireTrue(record.repository.testing_devpost_access_confirmed, "release_record.repository.testing_devpost_access_confirmed", failures);
      requireTrue(record.repository.google_hackathons_access_confirmed, "release_record.repository.google_hackathons_access_confirmed", failures);
    } else if (record.repository.testing_devpost_access_confirmed !== false || record.repository.google_hackathons_access_confirmed !== false) {
      addFailure(failures, "REPOSITORY_VISIBILITY", "Public repositories must set both private-judge-access confirmations to false.");
    }
    requireTrue(record.repository.release_tag_published_confirmed, "release_record.repository.release_tag_published_confirmed", failures);
  }

  if (checkObject(record.receipts, "release_record.receipts", [
    "canonical_runs",
    "canonical_privacy_path",
    "canonical_privacy_sha256",
    "clean_browser_path",
    "clean_browser_sha256",
  ], failures)) {
    if (!Array.isArray(record.receipts.canonical_runs) || record.receipts.canonical_runs.length !== 5) {
      addFailure(failures, "CANONICAL_RUN_COUNT", "release_record.receipts.canonical_runs must contain exactly five run references.");
    } else {
      record.receipts.canonical_runs.forEach((binding, index) => {
        const fieldPath = `release_record.receipts.canonical_runs[${index}]`;
        if (checkObject(binding, fieldPath, [
          "run_id",
          "ordinal",
          "preparation_path",
          "preparation_sha256",
          "run_path",
          "run_sha256",
          "chain_audit_path",
          "chain_audit_sha256",
        ], failures)) {
          requireIdentifier(binding.run_id, `${fieldPath}.run_id`, failures);
          if (!Number.isInteger(binding.ordinal) || binding.ordinal < 1 || binding.ordinal > 5) {
            addFailure(failures, "CANONICAL_RUN_ORDINAL", `${fieldPath}.ordinal must be an integer from 1 through 5.`);
          }
          for (const key of ["preparation_path", "run_path", "chain_audit_path"]) {
            requireIdentifier(binding[key], `${fieldPath}.${key}`, failures, /^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$/);
          }
          for (const key of ["preparation_sha256", "run_sha256", "chain_audit_sha256"]) requireSha256(binding[key], `${fieldPath}.${key}`, failures);
        }
      });
    }
    for (const key of ["canonical_privacy", "clean_browser"]) {
      requireIdentifier(record.receipts[`${key}_path`], `release_record.receipts.${key}_path`, failures, /^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$/);
      requireSha256(record.receipts[`${key}_sha256`], `release_record.receipts.${key}_sha256`, failures);
    }
  }

  if (checkObject(record.frozen_contracts, "release_record.frozen_contracts", ["prompt", "output_schema", "policy"], failures)) {
    for (const key of ["prompt", "output_schema", "policy"]) {
      const fieldPath = `release_record.frozen_contracts.${key}`;
      if (checkObject(record.frozen_contracts[key], fieldPath, ["version", "source_path", "source_sha256"], failures)) {
        requireIdentifier(record.frozen_contracts[key].version, `${fieldPath}.version`, failures);
        if (record.frozen_contracts[key].version !== expectedContractVersions[key]) {
          addFailure(failures, "CONTRACT_VERSION", `${fieldPath}.version must match the frozen runtime contract identifier.`);
        }
        requireIdentifier(record.frozen_contracts[key].source_path, `${fieldPath}.source_path`, failures, /^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$/);
        requireSha256(record.frozen_contracts[key].source_sha256, `${fieldPath}.source_sha256`, failures);
      }
    }
  }

  if (!Array.isArray(record.frozen_files)) {
    addFailure(failures, "FROZEN_FILES", "release_record.frozen_files must be an array of path and SHA-256 bindings.");
  } else {
    if (record.frozen_files.length !== requiredFrozenFilePaths.length) {
      addFailure(failures, "FROZEN_FILES", "release_record.frozen_files must contain exactly the required frozen file set.");
    }
    record.frozen_files.slice(0, requiredFrozenFilePaths.length + 1).forEach((binding, index) => {
      const fieldPath = `release_record.frozen_files[${index}]`;
      if (checkObject(binding, fieldPath, ["path", "sha256"], failures)) {
        requireIdentifier(binding.path, `${fieldPath}.path`, failures, /^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$/);
        requireSha256(binding.sha256, `${fieldPath}.sha256`, failures);
      }
    });
  }

  if (checkObject(record.frontend_artifact, "release_record.frontend_artifact", ["path", "sha256"], failures)) {
    requireIdentifier(record.frontend_artifact.path, "release_record.frontend_artifact.path", failures, /^[A-Za-z0-9][A-Za-z0-9._/-]{1,255}$/);
    requireSha256(record.frontend_artifact.sha256, "release_record.frontend_artifact.sha256", failures);
  }

  if (checkObject(record.video, "release_record.video", [
    "url",
    "duration_seconds",
    "canonical_run_id",
    "public_confirmed",
    "english_audio_or_subtitles_confirmed",
    "visible_google_cloud_confirmed",
    "unedited_continuous_live_run_confirmed",
    "privacy_review_confirmed",
  ], failures)) {
    validatePublicVideoUrl(record.video.url, "release_record.video.url", failures);
    requireIdentifier(record.video.canonical_run_id, "release_record.video.canonical_run_id", failures);
    if (!Number.isFinite(record.video.duration_seconds) || record.video.duration_seconds <= 0 || record.video.duration_seconds > 240) {
      addFailure(failures, "VIDEO_DURATION", "release_record.video.duration_seconds must be greater than zero and no more than 240 seconds.");
    }
    for (const key of ["public_confirmed", "english_audio_or_subtitles_confirmed", "visible_google_cloud_confirmed", "unedited_continuous_live_run_confirmed", "privacy_review_confirmed"]) {
      requireTrue(record.video[key], `release_record.video.${key}`, failures);
    }
  }

  if (checkObject(record.publication_review, "release_record.publication_review", [
    "current_rendered_design_qa_confirmed",
    "publication_review_confirmed",
    "repository_privacy_review_confirmed",
    "binary_media_review_confirmed",
    "claims_disclosures_consistent_confirmed",
    "synthetic_data_only_confirmed",
  ], failures)) {
    for (const key of ["current_rendered_design_qa_confirmed", "publication_review_confirmed", "repository_privacy_review_confirmed", "binary_media_review_confirmed", "claims_disclosures_consistent_confirmed", "synthetic_data_only_confirmed"]) {
      requireTrue(record.publication_review[key], `release_record.publication_review.${key}`, failures);
    }
  }

  if (checkObject(record.license, "release_record.license", ["decision", "spdx_identifier"], failures)) {
    if (!allowedLicenseDecisions.has(record.license.decision)) {
      addFailure(failures, "LICENSE_DECISION", "release_record.license.decision must be all_rights_reserved or open_source.");
    } else if (record.license.decision === "open_source") {
      requireIdentifier(record.license.spdx_identifier, "release_record.license.spdx_identifier", failures, /^[A-Za-z0-9][A-Za-z0-9.+-]{1,63}$/);
      if (!allowedOpenSourceSpdxIdentifiers.has(record.license.spdx_identifier)) {
        addFailure(failures, "LICENSE_DECISION", "Found Roll's open-source release must identify the checked MIT grant.");
      }
    } else if (record.license.spdx_identifier !== null) {
      addFailure(failures, "LICENSE_DECISION", "release_record.license.spdx_identifier must be null for all_rights_reserved.");
    }
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function resolvePrivateArtifact(repoRoot, value, fieldPath, failures) {
  if (typeof value !== "string" || path.isAbsolute(value)) {
    addFailure(failures, "PRIVATE_ARTIFACT_PATH", `${fieldPath} must be a repository-relative path under artifacts/private/.`);
    return null;
  }
  const absolute = path.resolve(repoRoot, value);
  const relative = normalizeRelativePath(path.relative(repoRoot, absolute));
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || !relative.startsWith("artifacts/private/")) {
    addFailure(failures, "PRIVATE_ARTIFACT_PATH", `${fieldPath} must remain under artifacts/private/.`);
    return null;
  }
  return absolute;
}

async function readRegularFileWithin(rootPath, filePath, maximumBytes) {
  const absoluteRoot = path.resolve(rootPath);
  const absoluteFile = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("file escaped its trusted root");
  }

  const rootStat = await lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("trusted root is not a regular directory");
  }
  const segments = relative.split(path.sep).filter(Boolean);
  let current = absoluteRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic links are not accepted as release evidence");
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error("file parent is not a directory");
    if (index === segments.length - 1 && !stat.isFile()) throw new Error("release evidence is not a regular file");
    if (index === segments.length - 1 && stat.size > maximumBytes) throw new Error("file too large");
  }

  const [realRoot, realFile] = await Promise.all([realpath(absoluteRoot), realpath(absoluteFile)]);
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("file escaped its trusted root");
  }
  const content = await readFile(realFile);
  if (content.byteLength > maximumBytes) throw new Error("file too large");
  return content;
}

async function loadRepositoryFile(repoRoot, relativePath, fieldPath, failures) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    addFailure(failures, "FROZEN_FILE_PATH", `${fieldPath} must be a repository-relative file path.`);
    return null;
  }
  const absolute = path.resolve(repoRoot, relativePath);
  const normalized = normalizeRelativePath(path.relative(repoRoot, absolute));
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    addFailure(failures, "FROZEN_FILE_PATH", `${fieldPath} escapes the repository root.`);
    return null;
  }
  try {
    return await readRegularFileWithin(repoRoot, absolute, maxArtifactBytes);
  } catch {
    addFailure(failures, "FROZEN_FILE_UNREADABLE", `${fieldPath} could not be read as a bounded repository artifact.`);
    return null;
  }
}

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(raw) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (raw.byteLength < 33 || !raw.subarray(0, 8).equals(signature)) return null;
  let offset = 8;
  let width = null;
  let height = null;
  let channels = null;
  let colorType = null;
  let sawIdat = false;
  let sawIend = false;
  const idatParts = [];
  while (offset + 12 <= raw.byteLength) {
    const length = raw.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > raw.byteLength) return null;
    const typeBytes = raw.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = raw.subarray(offset + 8, offset + 8 + length);
    const recordedCrc = raw.readUInt32BE(offset + 8 + length);
    if (pngCrc32(Buffer.concat([typeBytes, data])) !== recordedCrc) return null;
    if (offset === 8 && (type !== "IHDR" || length !== 13)) return null;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType] || null;
      if (bitDepth !== 8 || !channels || compression !== 0 || filter !== 0 || interlace !== 0) return null;
    } else if (type === "IDAT") {
      sawIdat = true;
      idatParts.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== raw.byteLength) return null;
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!width || !height || !sawIdat || !sawIend) return null;
  try {
    const expectedBytes = (width * channels + 1) * height;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes > maxArtifactBytes) return null;
    const pixels = inflateSync(Buffer.concat(idatParts), { maxOutputLength: expectedBytes + 1 });
    if (pixels.byteLength !== expectedBytes) return null;
    const rowBytes = width * channels;
    let previousRow = Buffer.alloc(rowBytes);
    const distinctColors = new Set();
    const pixelHasher = createHash("sha256");
    const dimensionHeader = Buffer.allocUnsafe(8);
    dimensionHeader.writeUInt32BE(width, 0);
    dimensionHeader.writeUInt32BE(height, 4);
    pixelHasher.update(dimensionHeader);
    const paeth = (left, above, upperLeft) => {
      const estimate = left + above - upperLeft;
      const leftDistance = Math.abs(estimate - left);
      const aboveDistance = Math.abs(estimate - above);
      const upperLeftDistance = Math.abs(estimate - upperLeft);
      if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
      if (aboveDistance <= upperLeftDistance) return above;
      return upperLeft;
    };
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
      const rowOffset = rowIndex * (rowBytes + 1);
      const filterType = pixels[rowOffset];
      if (filterType > 4) return null;
      const encoded = pixels.subarray(rowOffset + 1, rowOffset + 1 + rowBytes);
      const decoded = Buffer.allocUnsafe(rowBytes);
      for (let column = 0; column < rowBytes; column += 1) {
        const left = column >= channels ? decoded[column - channels] : 0;
        const above = previousRow[column];
        const upperLeft = column >= channels ? previousRow[column - channels] : 0;
        let predictor = 0;
        if (filterType === 1) predictor = left;
        else if (filterType === 2) predictor = above;
        else if (filterType === 3) predictor = Math.floor((left + above) / 2);
        else if (filterType === 4) predictor = paeth(left, above, upperLeft);
        decoded[column] = (encoded[column] + predictor) & 0xff;
      }
      if (distinctColors.size < 32) {
        for (let column = 0; column < rowBytes; column += channels) {
          let packed = decoded[column];
          for (let channel = 1; channel < channels; channel += 1) packed = (packed * 257 + decoded[column + channel]) >>> 0;
          distinctColors.add(packed);
          if (distinctColors.size >= 32) break;
        }
      }
      const normalizedRgba = Buffer.allocUnsafe(width * 4);
      for (let pixel = 0; pixel < width; pixel += 1) {
        const source = pixel * channels;
        const target = pixel * 4;
        if (colorType === 0) {
          normalizedRgba[target] = decoded[source];
          normalizedRgba[target + 1] = decoded[source];
          normalizedRgba[target + 2] = decoded[source];
          normalizedRgba[target + 3] = 255;
        } else if (colorType === 2) {
          normalizedRgba[target] = decoded[source];
          normalizedRgba[target + 1] = decoded[source + 1];
          normalizedRgba[target + 2] = decoded[source + 2];
          normalizedRgba[target + 3] = 255;
        } else if (colorType === 4) {
          normalizedRgba[target] = decoded[source];
          normalizedRgba[target + 1] = decoded[source];
          normalizedRgba[target + 2] = decoded[source];
          normalizedRgba[target + 3] = decoded[source + 1];
        } else {
          decoded.copy(normalizedRgba, target, source, source + 4);
        }
      }
      pixelHasher.update(normalizedRgba);
      previousRow = decoded;
    }
    if (distinctColors.size < 8) return null;
    return { width, height, pixelSha256: pixelHasher.digest("hex") };
  } catch {
    return null;
  }
}

function validateDocumentationEvidence(rawByPath, failures) {
  const decode = (relativePath) => rawByPath.get(relativePath)?.toString("utf8") || "";
  const metrics = (content) => {
    const lines = content.split(/\r?\n/);
    const uniqueWords = new Set(
      content.toLowerCase().split(/[^a-z0-9_.:/-]+/).filter((word) => word.length >= 3),
    );
    return {
      lineCount: lines.length,
      fenceCount: (content.match(/^```/gm) || []).length,
      uniqueWordCount: uniqueWords.size,
      maxLineLength: Math.max(0, ...lines.map((line) => line.length)),
    };
  };
  const readme = decode("README.md");
  const readmeMetrics = metrics(readme);
  if (
    readme.length < 10_000
    || readmeMetrics.lineCount < 100
    || readmeMetrics.fenceCount < 10
    || readmeMetrics.uniqueWordCount < 400
    || readmeMetrics.maxLineLength > 1_200
    || !/^# Found Roll\s*$/m.test(readme)
    || !/^## Local web prototype\s*$/m.test(readme)
    || !/^## Local services\s*$/m.test(readme)
    || !/^## Verification\s*$/m.test(readme)
    || !/^## Submission blockers that cannot be fabricated\s*$/m.test(readme)
  ) {
    addFailure(failures, "README_SETUP", "README.md must retain substantive setup, local-run, verification, and submission-boundary instructions.");
  }

  const architecture = decode("docs/architecture.md");
  const architectureMetrics = metrics(architecture);
  if (
    architecture.length < 8_000
    || architectureMetrics.lineCount < 100
    || architectureMetrics.fenceCount < 4
    || architectureMetrics.uniqueWordCount < 300
    || architectureMetrics.maxLineLength > 1_200
    || !/^# Found Roll architecture\s*$/m.test(architecture)
    || !/^## Canonical event flow\s*$/m.test(architecture)
    || !/^## Evidence and visibility\s*$/m.test(architecture)
    || !/^## Trace and audit correlation\s*$/m.test(architecture)
    || !/Google ADK/i.test(architecture)
    || !/Gemini(?:\s+|-)?3\.5/i.test(architecture)
    || !/Cloud Run/i.test(architecture)
    || !/Firestore/i.test(architecture)
    || !/Cloud Storage/i.test(architecture)
    || !/Cloud Tasks/i.test(architecture)
    || !/SIMULATED/i.test(architecture)
  ) {
    addFailure(failures, "ARCHITECTURE_CONTENT", "docs/architecture.md must explain the real Google Cloud, agent, custody, and simulated-system boundaries.");
  }

  const deployment = decode("docs/deployment.md");
  const deploymentMetrics = metrics(deployment);
  const powerShellStatements = [];
  const gcloudOutsidePowerShell = [];
  let activeFence = null;
  for (const rawLine of deployment.split(/\r?\n/)) {
    const fenceMatch = rawLine.match(/^\s*```([^\s`]*)/);
    if (fenceMatch) {
      activeFence = activeFence === null ? fenceMatch[1].toLowerCase() : null;
      continue;
    }
    const commandShapedGcloud = /^\s*(?:`{1,3}\s*)?(?:\$[A-Za-z_][A-Za-z0-9_.]*\s*=\s*)?(?:\(+\s*\[string\]\s*\(?\s*)*(?:@\(&\s*|&\s*)?gcloud\s+[a-z]/i.test(rawLine);
    if (commandShapedGcloud && activeFence !== "powershell") gcloudOutsidePowerShell.push(rawLine.trim());
  }
  for (const block of deployment.matchAll(/^```powershell[^\r\n]*\r?\n([\s\S]*?)^```[ \t]*$/gmi)) {
    let logicalStatement = "";
    for (const rawLine of block[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || (!logicalStatement && line.startsWith("#"))) continue;
      const continued = /`\s*$/.test(rawLine);
      const segment = rawLine.replace(/`\s*$/, "").trim();
      logicalStatement = `${logicalStatement}${logicalStatement ? " " : ""}${segment}`;
      if (!continued) {
        powerShellStatements.push(logicalStatement);
        logicalStatement = "";
      }
    }
    if (logicalStatement) powerShellStatements.push(logicalStatement);
  }
  const readOnlyGcloudPattern = /\bgcloud\s+(?:auth\s+(?:login|list|print-access-token)|config\s+(?:set|get-value|list)|projects\s+describe|billing\s+projects\s+describe|asset\s+list|builds\s+(?:list|describe)|iam\s+service-accounts\s+keys\s+list|secrets\s+(?:locations\s+list|list|versions\s+(?:list|access|describe))|artifacts\s+(?:repositories\s+list|docker\s+images\s+list)|run\s+(?:services|revisions)\s+describe|firestore\s+databases\s+(?:list|describe)|storage\s+(?:ls|buckets\s+(?:list|describe)|objects\s+list|du)|tasks\s+queues\s+describe)(?=\s|$|\))/i;
  const approvedMutatingGcloudPattern = /\bgcloud\s+(?:services\s+enable|iam\s+service-accounts\s+(?:create|add-iam-policy-binding)|projects\s+(?:update|add-iam-policy-binding|delete)|firestore\s+databases\s+create|storage\s+buckets\s+(?:create|update|add-iam-policy-binding)|tasks\s+queues\s+(?:create|update|pause)|secrets\s+(?:create|add-iam-policy-binding|versions\s+(?:add|destroy))|artifacts\s+docker\s+images\s+delete|run\s+(?:deploy|services\s+(?:update|update-traffic)))(?=\s|$|\))/i;
  const mutatingGcloudViolations = [];
  const unapprovedGcloudViolations = [];
  const sensitiveGcloudViolations = [];
  for (let index = 0; index < powerShellStatements.length; index += 1) {
    const statement = powerShellStatements[index];
    if (/"(?:`.|[^"`])*\$\(\s*(?:&\s*)?gcloud\s+[a-z]/i.test(statement)) {
      unapprovedGcloudViolations.push(`nested expandable-string gcloud invocation: ${statement}`);
      continue;
    }
    const commandProjection = statement
      .replace(/'(?:''|[^'])*'/g, "''")
      .replace(/"(?:`.|[^"`])*"/g, '""')
      .replace(/\s+#.*$/, "");
    const gcloudInvocations = [...commandProjection.matchAll(/\bgcloud\s+[a-z]/gi)];
    if (gcloudInvocations.length === 0) continue;
    if (gcloudInvocations.length !== 1) {
      mutatingGcloudViolations.push(`compound or ambiguous gcloud statement: ${statement}`);
      continue;
    }
    if (/\bgcloud\s+auth\s+print-access-token(?=\s|$|\))/i.test(commandProjection)) {
      if (!/^\$(?:AccessTokenLines|SoftDeletedBucketAccessTokenLines|StorageObjectAccessTokenLines)\s*=\s*@\(&\s*gcloud\s+auth\s+print-access-token\)$/i.test(commandProjection)) {
        sensitiveGcloudViolations.push(`access token is not captured only in memory: ${statement}`);
      }
    }
    if (readOnlyGcloudPattern.test(commandProjection)) continue;
    if (!approvedMutatingGcloudPattern.test(commandProjection)) {
      unapprovedGcloudViolations.push(`unapproved gcloud command shape: ${statement}`);
      continue;
    }
    if (!/(?:^|\s)--project=\$(?:ProjectId|ExpectedProjectId)(?=\s|$|\))/.test(commandProjection)) {
      mutatingGcloudViolations.push(`missing exact project flag: ${statement}`);
    }
    if (!/^Assert-(?:Standalone)?LastGcloudSuccess\b/.test(powerShellStatements[index + 1] || "")) {
      mutatingGcloudViolations.push(`missing immediate checked failure: ${statement}`);
    }
  }
  const secretVersionAddPreflightViolations = [];
  const buildInventoryCommandViolations = [];
  for (let index = 0; index < powerShellStatements.length; index += 1) {
    if (!/\bgcloud\s+secrets\s+versions\s+add\b/i.test(powerShellStatements[index])) continue;
    if (!/^Assert-GoogleCloudPreflight\s+-PhaseName\s+"secret-version-upload-\$\(\$Entry\.Key\)"$/i.test(powerShellStatements[index - 1] || "")) {
      secretVersionAddPreflightViolations.push(powerShellStatements[index]);
    }
  }
  for (const statement of powerShellStatements) {
    if (/\bgcloud\s+builds\s+list(?=\s|$)/i.test(statement) && (
      !/(?:^|\s)--project=\$ProjectId(?=\s|$|\))/.test(statement)
      || !/(?:^|\s)--region=\$BuildLocation(?=\s|$|\))/.test(statement)
      || !/(?:^|\s)--limit=unlimited(?=\s|$|\))/.test(statement)
    )) buildInventoryCommandViolations.push(statement);
    if (/\bgcloud\s+builds\s+describe(?=\s|$)/i.test(statement) && (
      !/(?:^|\s)--project=\$ProjectId(?=\s|$|\))/.test(statement)
      || !/(?:^|\s)--region=\$BuildLocation(?=\s|$|\))/.test(statement)
    )) buildInventoryCommandViolations.push(statement);
  }
  const cloudRunDeployCount = (deployment.match(/^[ \t]*gcloud run deploy\b/gm) || []).length;
  const gatedCloudRunDeployCount = (
    deployment.match(/^[ \t]*Assert-GoogleCloudPreflight\s+-PhaseName\s+"[^"]+"[ \t]*\r?\n[ \t]*gcloud run deploy\b/gm) || []
  ).length;
  const projectPinnedCloudRunDeployCount = (
    deployment.match(/^[ \t]*gcloud run deploy\b[^\r\n]*\r?\n[ \t]*--project=\$ProjectId\b/gm) || []
  ).length;
  const cloudRunServiceUpdateCount = (deployment.match(/^[ \t]*gcloud run services update\s+\$AppService\b/gm) || []).length;
  const gatedCloudRunServiceUpdateCount = (
    deployment.match(/^[ \t]*Assert-GoogleCloudPreflight\s+-PhaseName\s+"[^"]+"[ \t]*\r?\n[ \t]*gcloud run services update\s+\$AppService\b/gm) || []
  ).length;
  const storageAuditReceiptCallCount = (
    deployment.match(/^[ \t]*\$[A-Za-z]+StorageBinding\s*=\s*Write-ProjectStorageAuditReceipt\b/gm) || []
  ).length;
  const rollbackDeclarationCount = (deployment.match(/\$RetainedRollbackRevisionDeclaration\s*=/g) || []).length;
  const secretUploadStateCheckCount = (deployment.match(/^[ \t]*Assert-SecretUploadState[ \t]*$/gm) || []).length;
  const analysisLeaseMatch = deployment.match(/ANALYSIS_EXECUTION_LEASE_SECONDS\s*=\s*(\d+)/);
  const queueMinimumBackoffMatch = deployment.match(/--min-backoff=(\d+)s/);
  const analysisLeaseSeconds = analysisLeaseMatch ? Number.parseInt(analysisLeaseMatch[1], 10) : null;
  const queueMinimumBackoffSeconds = queueMinimumBackoffMatch ? Number.parseInt(queueMinimumBackoffMatch[1], 10) : null;
  const projectDescribeIndex = deployment.indexOf("$ProjectState = gcloud projects describe $ProjectId");
  const resourceManagerEnableIndex = deployment.indexOf(
    "gcloud services enable cloudresourcemanager.googleapis.com --project=$ProjectId",
  );
  const projectLabelPreservationIndex = deployment.indexOf(
    "foreach ($LabelProperty in $ProjectState.labels.PSObject.Properties)",
  );
  const projectLabelPatchIndex = deployment.indexOf(
    '-Uri "https://cloudresourcemanager.googleapis.com/v3/projects/${ProjectNumber}?updateMask=labels"',
  );
  const projectLabelVerificationIndex = deployment.indexOf("$ProjectLabelVerified = $false");
  const deterministicAppUrlDeclaration = '$AppUrl = "https://$($AppService)-$($ProjectNumber).$($Region).run.app"';
  const deterministicSimulatorUrlDeclaration = '$SimulatorUrl = "https://$($SimulatorService)-$($ProjectNumber).$($Region).run.app"';
  const verifiedOriginHelperStart = deployment.indexOf("function Resolve-VerifiedCloudRunOrigin {");
  const verifiedOriginHelperEnd = deployment.indexOf(
    "function Resolve-RetainedRollbackRevisions {",
    verifiedOriginHelperStart,
  );
  const verifiedOriginHelper = verifiedOriginHelperStart >= 0 && verifiedOriginHelperEnd > verifiedOriginHelperStart
    ? deployment.slice(verifiedOriginHelperStart, verifiedOriginHelperEnd)
    : "";
  const exactStorageBucketStateCallCount = (
    deployment.match(/Get-ExactStorageBucketState\s+-BucketName\s+\$(?:Bucket|ProjectBucket)\b/g) || []
  ).length;
  const exactStorageBucketHelperStart = deployment.indexOf("function Get-ExactStorageBucketState {");
  const exactStorageBucketHelperEnd = deployment.indexOf(
    "function Get-SoftDeletedProjectBuckets {",
    exactStorageBucketHelperStart,
  );
  const exactStorageBucketHelper = exactStorageBucketHelperStart >= 0 && exactStorageBucketHelperEnd > exactStorageBucketHelperStart
    ? deployment.slice(exactStorageBucketHelperStart, exactStorageBucketHelperEnd)
    : "";
  const exactStorageBucketFields = "fields=name%2CprojectNumber%2Clocation%2CiamConfiguration%2CsoftDeletePolicy%2Cversioning%2CretentionPolicy%2Clifecycle%2Cmetageneration";
  const softDeletedBucketHelperStart = exactStorageBucketHelperEnd;
  const softDeletedBucketHelperEnd = deployment.indexOf(
    "function Get-StorageObjectInventory {",
    softDeletedBucketHelperStart,
  );
  const softDeletedBucketHelper = softDeletedBucketHelperStart >= 0 && softDeletedBucketHelperEnd > softDeletedBucketHelperStart
    ? deployment.slice(softDeletedBucketHelperStart, softDeletedBucketHelperEnd)
    : "";
  const storageObjectHelperStart = softDeletedBucketHelperEnd;
  const storageObjectHelperEnd = deployment.indexOf(
    "function Assert-LastGcloudSuccess {",
    storageObjectHelperStart,
  );
  const storageObjectHelper = storageObjectHelperStart >= 0 && storageObjectHelperEnd > storageObjectHelperStart
    ? deployment.slice(storageObjectHelperStart, storageObjectHelperEnd)
    : "";
  const softDeletedObjectInventoryIndex = deployment.indexOf(
    "Get-StorageObjectInventory -BucketName $ProjectBucket -ExpectedProjectId $ExpectedProjectId -Mode soft_deleted",
  );
  const clearSoftDeleteIndex = deployment.indexOf(
    'gcloud storage buckets update "gs://$ProjectBucket" --project=$ExpectedProjectId --clear-soft-delete',
  );
  const preservingJsonParserCount = (deployment.match(/^function\s+ConvertFrom-JsonPreservingStrings\s*\{/gmi) || []).length;
  const preservingJsonVersionGateCount = (deployment.match(/\$PSVersionTable\.PSVersion\s+-lt\s+\[version\]'7\.5'/g) || []).length;
  const preservingJsonCapabilityCheckCount = (deployment.match(/Parameters\.ContainsKey\('DateKind'\)/g) || []).length;
  const preservingJsonGetCommandCount = (
    deployment.match(/\$JsonConvertCommand\s*=\s*Get-Command\s+ConvertFrom-Json\s+-ErrorAction\s+Stop/g) || []
  ).length;
  const preservingJsonImplementationCount = (
    deployment.match(/Microsoft\.PowerShell\.Utility\\ConvertFrom-Json\s+-InputObject\s+\(\$JsonLines\s+-join\s+"`n"\)\s+-DateKind\s+String/g) || []
  ).length;
  const suppressedJsonLineAddCount = (
    deployment.match(/process\s*\{\s*\[void\]\$JsonLines\.Add\(\$Json\)\s*\}/g) || []
  ).length;
  const rawJsonPipelineCount = (deployment.match(/\|\s*ConvertFrom-Json(?!PreservingStrings)\b/gi) || []).length;
  const unqualifiedConvertFromJsonCommandCount = (
    deployment.match(/(?<![A-Za-z0-9_\\-])ConvertFrom-Json(?!PreservingStrings)(?=\s|$)/gi) || []
  ).length;
  const qualifiedConvertFromJsonCommandCount = (
    deployment.match(/Microsoft\.PowerShell\.Utility\\ConvertFrom-Json\b/gi) || []
  ).length;
  if (
    deployment.length < 20_000
    || deploymentMetrics.lineCount < 250
    || deploymentMetrics.fenceCount < 30
    || deploymentMetrics.uniqueWordCount < 700
    || deploymentMetrics.maxLineLength > 2_000
    || !/^# Found Roll Google Cloud deployment runbook\s*$/m.test(deployment)
    || !/^## Preflight and variables\s*$/m.test(deployment)
    || !/^## Verification\s*$/m.test(deployment)
    || !/^## Submission freeze\s*$/m.test(deployment)
    || !/gcloud\s+run\s+deploy/i.test(deployment)
    || !/gcloud\s+services\s+enable/i.test(deployment)
    || !/not Always Free/i.test(deployment)
    || !/billing_account_type:\s*"free_trial"/i.test(deployment)
    || !/Preview spend-cap/i.test(deployment)
    || !/--preflight-only/i.test(deployment)
    || !/GOOGLE CLOUD PREFLIGHT: PASS/i.test(deployment)
    || !/SUBMISSION READINESS: PASS/i.test(deployment)
    || !/GOOGLE CLOUD TEARDOWN IDENTITY: PASS/i.test(deployment)
    || !/billing_account_name_sha256/i.test(deployment)
    || !/entrant_attestation_confirmed/i.test(deployment)
    || !/billing_account_open_cli_observed/i.test(deployment)
    || !deployment.includes(deterministicAppUrlDeclaration)
    || !deployment.includes(deterministicSimulatorUrlDeclaration)
    || /<exact-existing-(?:app|simulator)-cloud-run-status-url>/i.test(deployment)
    || /two-stage bootstrap/i.test(deployment)
    || !/documented deterministic service URL/i.test(deployment)
    || !/function\s+Resolve-VerifiedCloudRunOrigin\b/i.test(verifiedOriginHelper)
    || !/StatusUrlProperty\s*=\s*\$ServiceState\.status\.PSObject\.Properties\['url'\]/i.test(verifiedOriginHelper)
    || !/AnnotationsProperty\s*=\s*\$ServiceState\.metadata\.PSObject\.Properties\['annotations'\]/i.test(verifiedOriginHelper)
    || !/\$null\s+-eq\s+\$AnnotationsProperty(?!\.)\b/i.test(verifiedOriginHelper)
    || !/UrlsProperty\s*=\s*\$AnnotationsProperty\.Value\.PSObject\.Properties\['run\.googleapis\.com\/urls'\]/i.test(verifiedOriginHelper)
    || !/\$null\s+-eq\s+\$UrlsProperty/i.test(verifiedOriginHelper)
    || !/UrlsProperty\.Value\s*\|\s*ConvertFrom-JsonPreservingStrings/i.test(verifiedOriginHelper)
    || !/ObservedOrigins\s+-notcontains\s+\$CanonicalExpectedOrigin/i.test(verifiedOriginHelper)
    || !/ObservedOrigins\s+-notcontains\s+\$StatusOrigin/i.test(verifiedOriginHelper)
    || !/return\s+\$CanonicalExpectedOrigin/i.test(verifiedOriginHelper)
    || !/CanonicalOrigin\s*=\s*Resolve-VerifiedCloudRunOrigin\s+-ServiceState\s+\$CanonicalServiceState\s+-Service\s+\$Service\s+-ExpectedOrigin\s+\$ExpectedOrigin/i.test(deployment)
    || !/function\s+Get-ExactStorageBucketState\b/i.test(deployment)
    || !exactStorageBucketHelper.includes("$AccessTokenLines = @(& gcloud auth print-access-token)")
    || !exactStorageBucketHelper.includes('Authorization = "Bearer $AccessToken"')
    || !exactStorageBucketHelper.includes("'x-goog-user-project' = $ProjectId")
    || !exactStorageBucketHelper.includes(
      `storage.googleapis.com/storage/v1/b/\${EncodedBucketName}?${exactStorageBucketFields}`,
    )
    || !exactStorageBucketHelper.includes("$Headers.Clear()")
    || !exactStorageBucketHelper.includes("$AccessToken = $null")
    || !exactStorageBucketHelper.includes("$AccessTokenLines = @()")
    || !deployment.includes("[string]$BucketState.projectNumber -ne $ExpectedProjectNumber")
    || exactStorageBucketStateCallCount !== 3
    || !softDeletedBucketHelper.includes("$SoftDeletedBucketAccessTokenLines = @(& gcloud auth print-access-token)")
    || !softDeletedBucketHelper.includes('Authorization = "Bearer $SoftDeletedBucketAccessToken"')
    || !softDeletedBucketHelper.includes("'x-goog-user-project' = $ExpectedProjectId")
    || !softDeletedBucketHelper.includes(
      "storage.googleapis.com/storage/v1/b?project=$([uri]::EscapeDataString($ExpectedProjectId))&softDeleted=true&maxResults=1000&projection=noAcl&fields=items(name%2CprojectNumber)%2CnextPageToken",
    )
    || !softDeletedBucketHelper.includes('$BucketsUri += "&pageToken=$([uri]::EscapeDataString($PageToken))"')
    || !softDeletedBucketHelper.includes("$SoftDeletedBucketsPage.PSObject.Properties['nextPageToken']")
    || !softDeletedBucketHelper.includes("$SoftDeletedBucketHeaders.Clear()")
    || !softDeletedBucketHelper.includes("$SoftDeletedBucketAccessToken = $null")
    || !softDeletedBucketHelper.includes("$SoftDeletedBucketAccessTokenLines = @()")
    || !deployment.includes("$SoftDeletedProjectBuckets = @(Get-SoftDeletedProjectBuckets -ExpectedProjectId $ExpectedProjectId)")
    || /gcloud\s+storage\s+ls\s+--buckets\s+--soft-deleted/i.test(deployment)
    || !storageObjectHelper.includes("$StorageObjectAccessTokenLines = @(& gcloud auth print-access-token)")
    || !storageObjectHelper.includes("[ValidateSet('current', 'all_versions', 'soft_deleted')][string]$Mode")
    || !storageObjectHelper.includes('Authorization = "Bearer $StorageObjectAccessToken"')
    || !storageObjectHelper.includes("'x-goog-user-project' = $ExpectedProjectId")
    || !storageObjectHelper.includes(
      "storage.googleapis.com/storage/v1/b/${EncodedBucketName}/o?maxResults=1000&projection=noAcl&fields=items(name%2Cgeneration%2Csize)%2CnextPageToken",
    )
    || !storageObjectHelper.includes('if ($Mode -eq \'all_versions\') { $ObjectsUri += "&versions=true" }')
    || !storageObjectHelper.includes('if ($Mode -eq \'soft_deleted\') { $ObjectsUri += "&softDeleted=true" }')
    || !storageObjectHelper.includes('$ObjectsUri += "&pageToken=$([uri]::EscapeDataString($StorageObjectPageToken))"')
    || !storageObjectHelper.includes("$StorageObjectsPage.PSObject.Properties['nextPageToken']")
    || !storageObjectHelper.includes("$StorageObjectHeaders.Clear()")
    || !storageObjectHelper.includes("$StorageObjectAccessToken = $null")
    || !storageObjectHelper.includes("$StorageObjectAccessTokenLines = @()")
    || !deployment.includes("Get-StorageObjectInventory -BucketName $ProjectBucket -ExpectedProjectId $ExpectedProjectId -Mode current")
    || !deployment.includes("Get-StorageObjectInventory -BucketName $ProjectBucket -ExpectedProjectId $ExpectedProjectId -Mode all_versions")
    || softDeletedObjectInventoryIndex < 0
    || clearSoftDeleteIndex < 0
    || softDeletedObjectInventoryIndex > clearSoftDeleteIndex
    || !deployment.includes("if ($PreClearSoftDeleteSeconds -gt 0)")
    || /gcloud\s+storage\s+objects\s+list/i.test(deployment)
    || /\$EvidenceBucketJson\s*=\s*gcloud\s+storage\s+buckets\s+describe/i.test(deployment)
    || /\$BucketState\s*=\s*gcloud\s+storage\s+buckets\s+describe/i.test(deployment)
    || cloudRunDeployCount === 0
    || gatedCloudRunDeployCount !== cloudRunDeployCount
    || projectPinnedCloudRunDeployCount !== cloudRunDeployCount
    || cloudRunServiceUpdateCount === 0
    || gatedCloudRunServiceUpdateCount !== cloudRunServiceUpdateCount
    || !/^[ \t]*Assert-GoogleCloudPreflight\s+-PhaseName\s+"api-enablement"[ \t]*\r?\n[ \t]*gcloud services enable\b/m.test(deployment)
    || !/--scaling=auto/i.test(deployment)
    || !/--max=1/i.test(deployment)
    || !/--max-instances=1/i.test(deployment)
    || !/--timeout=120s/i.test(deployment)
    || !/--timeout=20s/i.test(deployment)
    || !/--max-attempts=3/i.test(deployment)
    || !/--max-retry-duration=1s/i.test(deployment)
    || !Number.isInteger(analysisLeaseSeconds)
    || !Number.isInteger(queueMinimumBackoffSeconds)
    || analysisLeaseSeconds >= queueMinimumBackoffSeconds
    || !/gcloud\s+secrets\s+versions\s+destroy/i.test(deployment)
    || !/gcloud\s+artifacts\s+docker\s+images\s+delete/i.test(deployment)
    || !/--soft-delete-duration=0/i.test(deployment)
    || !/--clear-soft-delete/i.test(deployment)
    || !deployment.includes('gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/storage.objectUser"')
    || !deployment.includes("Assert-LastGcloudSuccess -Operation 'evidence-bucket object IAM binding'")
    || !deployment.includes('gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/storage.bucketViewer"')
    || !deployment.includes("Assert-LastGcloudSuccess -Operation 'evidence-bucket metadata IAM binding'")
    || /gcloud\s+storage\s+buckets\s+add-iam-policy-binding[^\r\n]*--role="roles\/storage\.(?:admin|editor)"/i.test(deployment)
    || !/softDeletePolicy/i.test(deployment)
    || !/Assert-ProjectStorageBound/i.test(deployment)
    || storageAuditReceiptCallCount !== cloudRunDeployCount
    || !/Write-ProjectStorageAuditReceipt\s+-Phase\s+after_app_source_deploy/i.test(deployment)
    || !/Write-ProjectStorageAuditReceipt\s+-Phase\s+after_simulator_source_deploy/i.test(deployment)
    || !/Get-CanonicalJsonHash/i.test(deployment)
    || !/artifact_repositories/i.test(deployment)
    || !/artifact_images/i.test(deployment)
    || !/revision_images/i.test(deployment)
    || !/ConvertTo-SanitizedObjectInventory/i.test(deployment)
    || !/all_version_objects/i.test(deployment)
    || !/object_id_sha256/i.test(deployment)
    || !/canonical_revision_images/i.test(deployment)
    || !/Non-Docker Artifact Registry repository/i.test(deployment)
    || !/function\s+Get-ProjectWideSecretDirectInventory\b/i.test(deployment)
    || !/gcloud\s+secrets\s+locations\s+list\s+--project=\$ProjectId\s+--limit=unlimited/i.test(deployment)
    || !/gcloud\s+secrets\s+list\s+--project=\$ProjectId\s+--location=\$SecretLocation\s+--limit=unlimited/i.test(deployment)
    || !/gcloud\s+secrets\s+versions\s+list\s+\$SecretName\s+--project=\$ProjectId\s+--limit=unlimited/i.test(deployment)
    || !/\$MissingSecretIds\s*=\s*@\(\$ExpectedSecretIds/i.test(deployment)
    || !/@\(Compare-Object\s+\$LiveSecretIds\s+\$ExpectedSecretIds\)\.Count/i.test(deployment)
    || !/function\s+Assert-SecretUploadState\b/i.test(deployment)
    || secretUploadStateCheckCount < 4
    || !/function\s+Assert-AllSecretInputValues\b/i.test(deployment)
    || !/function\s+Test-ExactSecretFileBytes\b/i.test(deployment)
    || !/gcloud\s+secrets\s+versions\s+access\s+\$\(\$SecretVersions\[\$Entry\.Key\]\)[^\r\n]*--out-file=\$ComparePath/i.test(deployment)
    || !/\$SecretsNeedingUpload\s*=\s*\[System\.Collections\.Generic\.HashSet\[string\]\]/i.test(deployment)
    || !/gcloud\s+secrets\s+versions\s+add\s+\$Entry\.Key\s+--project=\$ProjectId/i.test(deployment)
    || mutatingGcloudViolations.length > 0
    || unapprovedGcloudViolations.length > 0
    || sensitiveGcloudViolations.length > 0
    || secretVersionAddPreflightViolations.length > 0
    || buildInventoryCommandViolations.length > 0
    || gcloudOutsidePowerShell.length > 0
    || /\bgcloud\s+storage\s+rm\b/i.test(deployment)
    || !/function\s+Get-AllCloudBuildLocations\b/i.test(deployment)
    || !/cloudbuild\.googleapis\.com\/v2\/projects\/\$ProjectId\/locations\?pageSize=1000/i.test(deployment)
    || !/nextPageToken/i.test(deployment)
    || !/\$Headers\.Clear\(\)/i.test(deployment)
    || !/\$AccessToken\s*=\s*\$null/i.test(deployment)
    || !/gcloud\s+asset\s+list\s+--project=\$ProjectId\s+--asset-types="cloudbuild\.googleapis\.com\/Build"[^\r\n]*--limit=unlimited/i.test(deployment)
    || /gcloud\s+asset\s+search-all-resources[^\r\n]*cloudbuild\.googleapis\.com\/Build/i.test(deployment)
    || !/gcloud\s+builds\s+list\s+--project=\$ProjectId\s+--region=\$BuildLocation\s+--limit=unlimited/i.test(deployment)
    || !/gcloud\s+builds\s+describe\s+\$BuildId\s+--project=\$ProjectId\s+--region=\$BuildLocation/i.test(deployment)
    || !/BuildState\.projectId\s+-ne\s+\$ProjectId/i.test(deployment)
    || !deployment.includes("$RepositoryInventoryJson = @(& gcloud artifacts repositories list --project=$ProjectId --location=all --format=json)")
    || !deployment.includes("if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate every Artifact Registry repository.' }")
    || !deployment.includes('try { $RepositoryInventory = @(($RepositoryInventoryJson -join "`n") | ConvertFrom-JsonPreservingStrings) }')
    || !deployment.includes("catch { throw 'Could not parse the Artifact Registry repository inventory.' }")
    || !deployment.includes('$RepositoryImagesJson = @(& gcloud artifacts docker images list $RepositoryUri --include-tags --format="json(package,version,metadata.imageSizeBytes,updateTime,tags)")')
    || !deployment.includes('if ($LASTEXITCODE -ne 0) { throw "Could not enumerate every image in $RepositoryUri." }')
    || !deployment.includes('try { $RepositoryImages = @(($RepositoryImagesJson -join "`n") | ConvertFrom-JsonPreservingStrings) }')
    || !deployment.includes('catch { throw "Could not parse the image inventory for $RepositoryUri." }')
    || !/run\.googleapis\.com\/build-id/i.test(deployment)
    || !/run\.googleapis\.com\/build-name/i.test(deployment)
    || !/run\.googleapis\.com\/build-source-location/i.test(deployment)
    || !/ServiceAnnotationsProperty\s*=\s*\$ServiceState\.metadata\.PSObject\.Properties\['annotations'\]/i.test(deployment)
    || !/RevisionAnnotationsProperty\s*=\s*\$RevisionState\.metadata\.PSObject\.Properties\['annotations'\]/i.test(deployment)
    || !/ServiceBuildIdProperty\s*=\s*\$ServiceAnnotations\.PSObject\.Properties\['run\.googleapis\.com\/build-id'\]/i.test(deployment)
    || !/ServiceBuildNameProperty\s*=\s*\$ServiceAnnotations\.PSObject\.Properties\['run\.googleapis\.com\/build-name'\]/i.test(deployment)
    || !/ServiceBuildSourceLocationProperty\s*=\s*\$ServiceAnnotations\.PSObject\.Properties\['run\.googleapis\.com\/build-source-location'\]/i.test(deployment)
    || !/RevisionBuildSourceLocationProperty\s*=\s*\$RevisionAnnotations\.PSObject\.Properties\['run\.googleapis\.com\/build-source-location'\]/i.test(deployment)
    || !/RevisionBuildSourceLocation\.TrimStart\(\)\.StartsWith\('\{'\)/i.test(deployment)
    || !/RevisionBuildSourceLocation\s*\|\s*ConvertFrom-JsonPreservingStrings/i.test(deployment)
    || !/RevisionSourceProperties\.Count\s+-ne\s+1/i.test(deployment)
    || !/RevisionSourceProperties\[0\]\.Name\s+-ne\s+\$RevisionContainerName/i.test(deployment)
    || !/IsNullOrWhiteSpace\(\[string\]\$RevisionSourceProperties\[0\]\.Value\)/i.test(deployment)
    || !/CanonicalServiceBuildSourceLocation\s+-ne\s+\$CanonicalRevisionBuildSourceLocation/i.test(deployment)
    || /RevisionAnnotations\.PSObject\.Properties\['run\.googleapis\.com\/build-id'\]/i.test(deployment)
    || /RevisionAnnotations\.PSObject\.Properties\['run\.googleapis\.com\/build-name'\]/i.test(deployment)
    || !/source_deploy_build_binding_source/i.test(deployment)
    || !/revision_image_resource/i.test(deployment)
    || !/function\s+Resolve-ExactArtifactImageResource\b/i.test(deployment)
    || !/ResolvedImageMatch\s*=\s*\[regex\]::Match\(\$ResolvedDigest,\s*'\^\(\?:\(\.\+\)@\)\?\(sha256:\[a-f0-9\]\{64\}\)\$'\)/i.test(deployment)
    || !/if\s*\(\s*-not\s+\$ResolvedImageMatch\.Success\s*\)\s*\{\s*throw/i.test(deployment)
    || !/CanonicalResolvedDigest\s*=\s*\$ResolvedImageMatch\.Groups\[2\]\.Value/i.test(deployment)
    || !/EmbeddedDigestMatch\.Groups\[1\]\.Value\s+-ne\s+\$CanonicalResolvedDigest/i.test(deployment)
    || !/ResolvedImagePackage\s+-ne\s+\$ImagePackage/i.test(deployment)
    || !/digest\s*=\s*\$CanonicalResolvedDigest/i.test(deployment)
    || !/resource\s*=\s*"\$ImagePackage@\$CanonicalResolvedDigest"/i.test(deployment)
    || !/RevisionImageDigest\s*=\s*\[string\]\$RevisionImageBinding\.digest/i.test(deployment)
    || !/RevisionImageResource\s*=\s*\[string\]\$RevisionImageBinding\.resource/i.test(deployment)
    || !/BoundImageDigest\s*=\s*\[string\]\$BoundImageBinding\.digest/i.test(deployment)
    || !/image_resource\s*=\s*\[string\]\$BoundImageBinding\.resource/i.test(deployment)
    || !/CanonicalImageDigest\s*=\s*\[string\]\$CanonicalImageBinding\.digest/i.test(deployment)
    || !/image_resource\s*=\s*\[string\]\$CanonicalImageBinding\.resource/i.test(deployment)
    || !/function\s+ConvertTo-CanonicalStorageSourceLocation\b/i.test(deployment)
    || !/AuthoritativeSourceBuild\[0\]\.source_location_sha256\s+-ne\s+\$SourceDeployBuildSourceLocationSha256/i.test(deployment)
    || !/AuthoritativeSourceBuild\[0\]\.image_resources\s+-notcontains\s+\$RevisionImageResource/i.test(deployment)
    || !/BuildStateNameMatch/i.test(deployment)
    || !/direct_build_inventory_stable/i.test(deployment)
    || !/cloud_build_assets_before/i.test(deployment)
    || !/ProtectedRevisions/i.test(deployment)
    || !/status\.imageDigest/i.test(deployment)
    || !/RepositoryPrefix/i.test(deployment)
    || !/RotationProtectedRevisions/i.test(deployment)
    || !/ReplacementVersion/i.test(deployment)
    || !/SecretVersions/i.test(deployment)
    || rollbackDeclarationCount !== 1
    || !/Resolve-RetainedRollbackRevisions/i.test(deployment)
    || !/EvidenceBucketState\.projectNumber/i.test(deployment)
    || /gcloud\s+storage\s+rm\s+--recursive/i.test(deployment)
    || !/dedicated_project_label_key/i.test(deployment)
    || !/google-cloud-resource-identity\.json/i.test(deployment)
    || !/project_created_at_utc/i.test(deployment)
    || projectDescribeIndex < 0
    || resourceManagerEnableIndex <= projectDescribeIndex
    || projectLabelPreservationIndex <= resourceManagerEnableIndex
    || projectLabelPatchIndex <= projectLabelPreservationIndex
    || projectLabelVerificationIndex <= projectLabelPatchIndex
    || preservingJsonParserCount !== 2
    || preservingJsonVersionGateCount !== 2
    || preservingJsonCapabilityCheckCount !== 2
    || preservingJsonGetCommandCount !== 2
    || preservingJsonImplementationCount !== 2
    || suppressedJsonLineAddCount !== 2
    || rawJsonPipelineCount !== 0
    || unqualifiedConvertFromJsonCommandCount !== 2
    || qualifiedConvertFromJsonCommandCount !== 2
    || !/FrozenRelease\.google_cloud\.project_id/i.test(deployment)
    || !/--teardown-identity-only/i.test(deployment)
    || !/Set-StrictMode\s+-Version\s+Latest/i.test(deployment)
    || !/\$ErrorActionPreference\s*=\s*'Stop'/i.test(deployment)
    || !/## After judging: teardown[\s\S]*?```powershell\s*\r?\nSet-StrictMode\s+-Version\s+Latest\s*\r?\n\$ErrorActionPreference\s*=\s*'Stop'/i.test(deployment)
    || !/Assert-StandaloneDedicatedProjectIdentity/i.test(deployment)
    || !/Assert-StandaloneLastGcloudSuccess/i.test(deployment)
    || !/\$ExpectedProjectId\s*=\s*'found-roll-agentic-20260830'/i.test(deployment)
    || !/gcloud\s+projects\s+delete\s+\$ExpectedProjectId\s+--project=\$ExpectedProjectId\s+--quiet/i.test(deployment)
    || !/lifecycleState\s+-ne\s+'DELETE_REQUESTED'/i.test(deployment)
    || !/RecognizedNotFoundPattern/i.test(deployment)
    || !/\$DescribeOutput\s+-notmatch\s+\$RecognizedNotFoundPattern/i.test(deployment)
    || !/PostDeleteNotFoundConfirmed/i.test(deployment)
    || /post_delete_describe_output/i.test(deployment)
    || /release-record digest to agree/i.test(deployment)
    || !/Assert-DedicatedProjectIdentity\s*\r?\n\s*gcloud secrets versions destroy/i.test(deployment)
    || !/service_resource\s*=\s*\$ServiceResource/i.test(deployment)
    || !/revision_resource\s*=\s*"\$ServiceResource\/revisions\/\$CanonicalRevision"/i.test(deployment)
    || !/origin\s*=\s*\$CanonicalOrigin/i.test(deployment)
    || !/gcloud\s+run\s+services\s+update\s+\$AppService[^\r\n]*--remove-env-vars=FOUND_ROLL_DEPLOYMENT_RECOVERY[^\r\n]*FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT=false/i.test(deployment)
    || !/The simulator-phase inventory does not carry forward the exact app source-build record/i.test(deployment)
    || !/gcloud\s+projects\s+delete/i.test(deployment)
    || !/scripts\/prepare-canonical-run\.ps1/i.test(deployment.replaceAll("\\", "/"))
    || !/verify-submission-readiness\.mjs/i.test(deployment)
  ) {
    addFailure(failures, "DEPLOYMENT_SETUP", "docs/deployment.md must retain substantive zero-real-money, Google Cloud deployment, verification, cleanup, rollback, and freeze instructions.");
  }
}

async function validateFrozenFiles(repoRoot, bindings, failures) {
  if (!Array.isArray(bindings)) return new Map();
  const byPath = new Map();
  for (let index = 0; index < Math.min(bindings.length, requiredFrozenFilePaths.length + 1); index += 1) {
    const binding = bindings[index];
    if (!isPlainObject(binding) || typeof binding.path !== "string") continue;
    const normalized = normalizeRelativePath(binding.path);
    if (byPath.has(normalized)) {
      addFailure(failures, "FROZEN_FILE_DUPLICATE", `release_record.frozen_files[${index}] duplicates another frozen-file binding.`);
      continue;
    }
    byPath.set(normalized, { binding, index });
  }
  for (const requiredPath of requiredFrozenFilePaths) {
    if (!byPath.has(requiredPath)) {
      addFailure(failures, "FROZEN_FILE_MISSING", `release_record.frozen_files must bind ${requiredPath}.`);
    }
  }

  const rawByPath = new Map();
  for (const [relativePath, entry] of byPath.entries()) {
    const { binding, index } = entry;
    const raw = await loadRepositoryFile(repoRoot, relativePath, `release_record.frozen_files[${index}]`, failures);
    if (!raw) continue;
    rawByPath.set(relativePath, raw);
    if (!sha256Pattern.test(String(binding.sha256 || "")) || sha256(raw) !== binding.sha256.toLowerCase()) {
      addFailure(failures, "FROZEN_FILE_DIGEST_MISMATCH", `release_record.frozen_files[${index}] does not match the current file SHA-256.`);
    }
  }

  const projectLicense = rawByPath.get("LICENSE")?.toString("utf8") || "";
  const hostedLicense = rawByPath.get("public/legal/FOUND-ROLL-LICENSE.txt")?.toString("utf8") || "";
  const notice = rawByPath.get("NOTICE.md")?.toString("utf8") || "";
  const thirdPartyNotices = rawByPath.get("THIRD_PARTY_NOTICES.md")?.toString("utf8") || "";
  const hostedThirdPartyLicenses = rawByPath.get("public/legal/THIRD-PARTY-LICENSES.txt")?.toString("utf8") || "";
  let packageMetadata = null;
  try {
    packageMetadata = JSON.parse(rawByPath.get("package.json")?.toString("utf8") || "null");
  } catch {
    addFailure(failures, "LICENSE_CONTENT", "package.json must remain valid JSON with the checked MIT declaration.");
  }
  if (
    !projectLicense.startsWith("MIT License")
    || !projectLicense.includes("Copyright (c) 2026 Found Roll contributors")
    || !projectLicense.includes("Permission is hereby granted")
    || packageMetadata?.license !== "MIT"
  ) {
    addFailure(failures, "LICENSE_CONTENT", "The frozen project license and package metadata must preserve Found Roll's MIT grant.");
  }
  if (!hostedLicense.startsWith("MIT License") || !hostedLicense.includes("Found Roll contributors") || !hostedLicense.includes("Third-party packages")) {
    addFailure(failures, "LICENSE_CONTENT", "The hosted client must carry the Found Roll MIT grant and third-party scope boundary.");
  }
  if (!notice.includes("bundled Product Design prototype template") || !notice.includes("research-informed inspiration story")) {
    addFailure(failures, "NOTICE_CONTENT", "NOTICE.md must preserve template provenance and research-informed story provenance.");
  }
  if (!thirdPartyNotices.includes("## Bundled prototype template") || !thirdPartyNotices.includes("No third-party package or bundled template material is relicensed")) {
    addFailure(failures, "NOTICE_CONTENT", "THIRD_PARTY_NOTICES.md must preserve the bundled-template licensing boundary.");
  }
  for (const marker of ["React 19.2.0", "@phosphor-icons/react 2.1.10", "qrcode.react 4.2.0", "Copyright (c) Project Nayuki"]) {
    if (!hostedThirdPartyLicenses.includes(marker)) {
      addFailure(failures, "NOTICE_CONTENT", "The hosted client must include complete notices for every direct runtime dependency.");
      break;
    }
  }

  function parsedJson(relativePath) {
    const raw = rawByPath.get(relativePath);
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      addFailure(failures, "FROZEN_FILE_JSON_INVALID", `${relativePath} is not valid JSON.`);
      return null;
    }
  }

  const expectedLocalIds = Array.from({ length: 15 }, (_, index) => `FR-${String(index + 1).padStart(3, "0")}`);
  const fixtureManifest = parsedJson("evaluation/fixtures.json");
  const fixtureRunnerById = new Map();
  let fixtureManifestValid = fixtureManifest?.schema_version === "2.0"
    && fixtureManifest?.suite_id === "found-roll-local-safety-v2"
    && Array.isArray(fixtureManifest?.fixtures)
    && fixtureManifest.fixtures.length === 15;
  if (fixtureManifestValid) {
    for (const fixture of fixtureManifest.fixtures) {
      if (!expectedLocalIds.includes(fixture?.id) || fixtureRunnerById.has(fixture.id) || typeof fixture.runner !== "string" || fixture.runner.length < 3) {
        fixtureManifestValid = false;
        break;
      }
      fixtureRunnerById.set(fixture.id, fixture.runner);
    }
    fixtureManifestValid = fixtureManifestValid && expectedLocalIds.every((id) => fixtureRunnerById.has(id));
  }
  if (fixtureManifest && !fixtureManifestValid) {
    addFailure(failures, "LOCAL_EVALUATION_INCOMPLETE", "evaluation/fixtures.json must define exactly one runner for every FR-001 through FR-015 fixture.");
  }

  const evaluation = parsedJson("evaluation/results.json");
  let evaluationRowsValid = evaluation?.schema_version === "2.0"
    && evaluation?.suite_id === "found-roll-local-safety-v2"
    && evaluation?.status === "LOCAL_PASS_CANONICAL_INCOMPLETE"
    && evaluation?.fixture_count === 15
    && evaluation?.passed_count === 15
    && evaluation?.failed_count === 0
    && evaluation?.execution_boundary?.gemini_calls === 0
    && evaluation?.execution_boundary?.google_cloud_calls === 0
    && Array.isArray(evaluation?.results)
    && evaluation.results.length === 15;
  const evaluationById = new Map();
  if (evaluationRowsValid) {
    for (const result of evaluation.results) {
      if (
        !expectedLocalIds.includes(result?.id)
        || evaluationById.has(result.id)
        || result.passed !== true
        || result.execution_mode !== "local_deterministic_fixture"
        || result.runner !== fixtureRunnerById.get(result.id)
      ) {
        evaluationRowsValid = false;
        break;
      }
      evaluationById.set(result.id, result);
    }
    evaluationRowsValid = evaluationRowsValid && expectedLocalIds.every((id) => evaluationById.has(id));
  }
  const boundedAgent = evaluationById.get("FR-008")?.observed?.local_adk_construction_contract;
  const terminalTask = evaluationById.get("FR-015")?.observed;
  if (
    !evaluationRowsValid
    || boundedAgent?.max_llm_calls_cap !== liveAgentInvocationCap
    || boundedAgent?.max_output_tokens_cap !== 2048
    || boundedAgent?.live_trajectory_observed !== false
    || terminalTask?.final_state !== "RECONCILIATION_REQUIRED"
    || terminalTask?.outbox_status !== "FAILED"
    || terminalTask?.terminal_ack_status !== 200
    || terminalTask?.terminal_failure_acknowledged !== true
    || terminalTask?.retryable !== false
    || terminalTask?.manual_action_required !== true
    || terminalTask?.relay_calls !== 1
    || terminalTask?.retry_event_delta !== 0
  ) {
    addFailure(failures, "LOCAL_EVALUATION_INCOMPLETE", "evaluation/results.json must contain one passing row for every frozen fixture and preserve the bounded-agent and terminal-task safety evidence.");
  }

  const privacyCanaryRecord = parsedJson("evaluation/privacy-canaries.json");
  const privacyCanaryManifest = rawByPath.get("evaluation/privacy-canaries.json");
  const privacyCanaryManifestSha256 = privacyCanaryManifest ? sha256(privacyCanaryManifest) : null;
  const privacyCanaryCount = Array.isArray(privacyCanaryRecord?.canaries) ? privacyCanaryRecord.canaries.length : null;
  for (const relativePath of ["evaluation/privacy-scan-results.json", "evaluation/privacy-scan-docs-results.json"]) {
    const receipt = parsedJson(relativePath);
    if (receipt && (
      receipt.schema_version !== "1.0"
      || receipt.status !== "PASS"
      || receipt.canary_count !== privacyCanaryCount
      || receipt.finding_count !== 0
      || receipt.finding_values_included !== false
      || !receipt.findings_by_rule
      || Object.keys(receipt.findings_by_rule).length !== 0
      || !Array.isArray(receipt.recorded_findings)
      || receipt.recorded_findings.length !== 0
      || !Number.isInteger(receipt.scanned_byte_count)
      || receipt.scanned_byte_count < 1
      || !Number.isInteger(receipt.scanned_file_count)
      || receipt.scanned_file_count < 1
      || receipt.skipped_large_file_count !== 0
      || receipt.decode_replacement_count !== 0
    )) {
      addFailure(failures, "LOCAL_PRIVACY_INCOMPLETE", `${relativePath} must report a clean, complete UTF-8 scan.`);
    }
    if (receipt && (typeof receipt.manifest_sha256 !== "string" || receipt.manifest_sha256.toLowerCase() !== privacyCanaryManifestSha256)) {
      addFailure(failures, "LOCAL_PRIVACY_CANARY_BINDING", `${relativePath} must bind the current evaluation/privacy-canaries.json SHA-256.`);
    }
  }

  const localInventory = parsedJson("artifacts/verification/inventory-gateway-http-smoke-receipt.json");
  if (localInventory && (
    localInventory.schema_version !== "1"
    || localInventory.result !== "passed"
    || localInventory.gateway_mode !== "http"
    || localInventory.transport !== "real_loopback_http"
    || localInventory.simulator_disclosure_required !== "SIMULATED"
    || !Array.isArray(localInventory.authorized_candidate_ids)
    || new Set(localInventory.authorized_candidate_ids).size !== 3
    || localInventory.authorized_tenant_count !== 3
    || localInventory.restricted_fields_included !== false
    || localInventory.unauthorized_candidate_denied !== true
    || localInventory.unauthorized_tenant_denied !== true
  )) {
    addFailure(failures, "LOCAL_INVENTORY_INCOMPLETE", "The inventory-gateway receipt must prove a real loopback HTTP boundary, exact authorized scope, disclosure, and negative authorization checks.");
  }

  const localPreparation = parsedJson("artifacts/verification/local-canonical-preparation-receipt.json");
  const preparationScript = rawByPath.get("scripts/prepare-canonical-run.ps1");
  const pouchFront = rawByPath.get("public/assets/pouch-front.jpg");
  if (localPreparation && (
    localPreparation.schema_version !== "2"
    || localPreparation.status !== "PREPARED_FOR_ANALYSIS"
    || localPreparation.canonical !== false
    || localPreparation.preparation_script_sha256 !== (preparationScript ? sha256(preparationScript) : null)
    || localPreparation.case_state !== "RECEIVED"
    || localPreparation.analyst_mode !== "fixture"
    || localPreparation.inventory_mode !== "http"
    || localPreparation.inventory_gateway_ready !== true
    || localPreparation.repository !== "memory"
    || localPreparation.evidence_store !== "memory"
    || localPreparation.tasks_mode !== "inline"
    || localPreparation.relay_mode !== "http"
    || localPreparation.app_environment !== "development"
    || localPreparation.runtime_roles_authenticated !== true
    || localPreparation.simulator_disclosure !== "SIMULATED"
    || localPreparation.simulator_environment !== "development"
    || localPreparation.reset_event_count !== 1
    || localPreparation.evidence?.source_file !== "pouch-front.jpg"
    || localPreparation.evidence?.original_sha256 !== (pouchFront ? sha256(pouchFront) : null)
    || !sha256Pattern.test(localPreparation.evidence?.preview_sha256 ?? "")
    || localPreparation.evidence?.preview_visibility !== "MODEL_AUTHORIZED"
    || localPreparation.evidence?.current_epoch_record_count !== 2
    || localPreparation.evidence?.active_for_analysis !== true
    || localPreparation.evidence?.exact_retry_same_pair !== true
    || localPreparation.evidence?.changed_consent_conflict_verified !== true
  )) {
    addFailure(failures, "LOCAL_PREPARATION_INCOMPLETE", "The local preparation receipt must bind the frozen script/media and prove the fixture-only evidence boundary.");
  }

  const localWorkflow = parsedJson("artifacts/verification/service-client-http-smoke-receipt.json");
  if (localWorkflow && (
    localWorkflow.schema_version !== "1"
    || localWorkflow.result !== "passed"
    || localWorkflow.final_state !== "CLOSED"
    || localWorkflow.final_version !== 19
    || localWorkflow.event_count !== 19
    || !sha256Pattern.test(localWorkflow.first_event_hash ?? "")
    || !sha256Pattern.test(localWorkflow.final_event_hash ?? "")
    || localWorkflow.hash_chain_valid !== true
    || localWorkflow.inventory_gateway_loopback_http !== true
    || localWorkflow.inventory_gateway_authorized_candidate_count !== localInventory?.authorized_candidate_ids?.length
    || localWorkflow.imported_evidence_count !== 2
    || localWorkflow.imported_evidence_provenance_verified !== true
    || localWorkflow.runtime_role_probe_authenticated !== true
    || localWorkflow.runtime_staff_actor_id !== localPreparation?.staff_actor_id
    || localWorkflow.runtime_supervisor_actor_id !== localPreparation?.supervisor_actor_id
    || localWorkflow.service_projection_authoritative !== true
    || localWorkflow.token_replay_rejected !== true
    || localWorkflow.token_replay_boundary_unchanged !== true
    || localWorkflow.release_task_replayed !== true
    || localWorkflow.release_task_boundary_unchanged !== true
    || localWorkflow.manifest_internally_consistent !== true
    || localWorkflow.physical_transfer_proven !== false
    || localWorkflow.local_canonical_preparation_verified !== true
    || localWorkflow.case_id !== localPreparation?.case_id
  )) {
    addFailure(failures, "LOCAL_WORKFLOW_INCOMPLETE", "The authoritative local workflow receipt does not preserve the closed-chain safety boundary.");
  }
  const architectureManifest = parsedJson("docs/architecture-diagram.manifest.json");
  if (architectureManifest) {
    const sourceBinding = byPath.get("docs/architecture-diagram.mmd")?.binding;
    const renderBinding = byPath.get("docs/architecture-diagram.png")?.binding;
    const render = rawByPath.get("docs/architecture-diagram.png");
    const dimensions = render ? inspectPng(render) : null;
    if (
      architectureManifest.source_sha256 !== sourceBinding?.sha256?.toLowerCase()
      || architectureManifest.render_sha256 !== renderBinding?.sha256?.toLowerCase()
      || !dimensions
      || dimensions.width < 800
      || dimensions.height < 400
      || architectureManifest.width !== dimensions.width
      || architectureManifest.height !== dimensions.height
    ) {
      addFailure(failures, "ARCHITECTURE_BINDING", "The architecture manifest must match a valid, substantive frozen Mermaid PNG and its exact dimensions and digests.");
    }
  }
  const architectureSource = rawByPath.get("docs/architecture-diagram.mmd")?.toString("utf8") || "";
  for (const requiredTerm of ["Found Roll", "Google ADK", "Gemini 3.5", "Cloud Run", "Firestore", "Cloud Storage", "Cloud Tasks", "SIMULATED", "Relay"]) {
    if (!architectureSource.includes(requiredTerm)) {
      addFailure(failures, "ARCHITECTURE_CONTENT", "The frozen architecture diagram must identify every required real-cloud, agent, storage, task, and simulated relay boundary.");
      break;
    }
  }
  validateDocumentationEvidence(rawByPath, failures);
  return rawByPath;
}

async function collectFrontendBuildFiles(repoRoot) {
  const clientRoot = path.join(repoRoot, "dist", "client");
  for (const target of [path.join(repoRoot, "dist"), clientRoot]) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("frontend root is not a regular directory");
  }
  const files = [];
  const caseFoldedPaths = new Set();
  let totalBytes = 0;
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/\u0000-\u001f\u007f]/u.test(entry.name)) {
        throw new Error("frontend build contains an unsafe path segment");
      }
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("frontend build contains a symbolic link");
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error("frontend build contains an unsupported path type");
      const raw = await readFile(absolute);
      totalBytes += raw.byteLength;
      if (totalBytes > maxArtifactBytes) throw new Error("frontend build exceeds the verification size limit");
      const relativePath = normalizeRelativePath(path.relative(repoRoot, absolute));
      const foldedPath = relativePath.toLowerCase();
      if (caseFoldedPaths.has(foldedPath)) throw new Error("frontend build contains a case-colliding path");
      caseFoldedPaths.add(foldedPath);
      files.push({
        path: relativePath,
        bytes: raw.byteLength,
        sha256: sha256(raw),
        raw,
      });
    }
  }
  await walk(clientRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { files, totalBytes };
}

async function validateFrontendArtifact(repoRoot, binding, frozenFileBindings, failures) {
  if (!isPlainObject(binding)) return;
  const expectedPath = "artifacts/verification/frontend-build-manifest.json";
  if (normalizeRelativePath(String(binding.path || "")) !== expectedPath) {
    addFailure(failures, "FRONTEND_ARTIFACT_PATH", "release_record.frontend_artifact.path must identify the deterministic frontend build manifest.");
    return;
  }
  const raw = await loadRepositoryFile(repoRoot, expectedPath, "release_record.frontend_artifact.path", failures);
  if (!raw) return;
  const digest = sha256(raw);
  if (!sha256Pattern.test(String(binding.sha256 || "")) || digest !== binding.sha256.toLowerCase()) {
    addFailure(failures, "FRONTEND_ARTIFACT_DIGEST_MISMATCH", "The deterministic frontend build manifest does not match its supplied SHA-256 digest.");
  }
  if (frozenFileBindings?.get(expectedPath)?.sha256?.toLowerCase() !== digest) {
    addFailure(failures, "FRONTEND_ARTIFACT_DIGEST_MISMATCH", "The deterministic frontend build manifest must also match its frozen-file binding.");
  }

  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    addFailure(failures, "FRONTEND_MANIFEST", "The deterministic frontend build manifest must be valid JSON.");
    return;
  }
  if (!checkObject(manifest, "frontend_build_manifest", ["schema_version", "kind", "entrypoint", "file_count", "total_bytes", "files"], failures)) return;
  if (manifest.schema_version !== "1" || manifest.kind !== "found-roll-frontend-build" || manifest.entrypoint !== "dist/client/index.html") {
    addFailure(failures, "FRONTEND_MANIFEST", "The frontend manifest must use the frozen schema, kind, and entrypoint.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) {
    addFailure(failures, "FRONTEND_MANIFEST", "The frontend manifest must enumerate at least one build file.");
    return;
  }
  let actual;
  try {
    actual = await collectFrontendBuildFiles(repoRoot);
  } catch {
    addFailure(failures, "FRONTEND_BUILD_TREE", "dist/client must be a bounded regular-file tree without symbolic links.");
    return;
  }
  if (manifest.file_count !== manifest.files.length || manifest.file_count !== actual.files.length || manifest.total_bytes !== actual.totalBytes) {
    addFailure(failures, "FRONTEND_MANIFEST", "The frontend manifest file count and total bytes must exactly cover dist/client.");
  }
  const observedPaths = new Set();
  manifest.files.forEach((entry, index) => {
    const fieldPath = `frontend_build_manifest.files[${index}]`;
    if (!checkObject(entry, fieldPath, ["path", "bytes", "sha256"], failures)) return;
    const normalized = normalizeRelativePath(String(entry.path || ""));
    if (
      normalized !== entry.path
      || !normalized.startsWith("dist/client/")
      || normalized.includes("../")
      || path.isAbsolute(normalized)
      || observedPaths.has(normalized)
    ) {
      addFailure(failures, "FRONTEND_MANIFEST", `${fieldPath} must bind one unique normalized file below dist/client.`);
    }
    observedPaths.add(normalized);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) addFailure(failures, "FRONTEND_MANIFEST", `${fieldPath}.bytes must be a non-negative integer.`);
    requireSha256(entry.sha256, `${fieldPath}.sha256`, failures);
    const current = actual.files[index];
    if (!current || normalized !== current.path || entry.bytes !== current.bytes || String(entry.sha256).toLowerCase() !== current.sha256) {
      addFailure(failures, "FRONTEND_BUILD_DRIFT", `${fieldPath} does not match the sorted current dist/client file bytes.`);
    }
  });
  if (!observedPaths.has("dist/client/index.html")) {
    addFailure(failures, "FRONTEND_MANIFEST", "The frontend manifest must bind dist/client/index.html.");
  }
  for (const legalPath of ["dist/client/legal/FOUND-ROLL-LICENSE.txt", "dist/client/legal/THIRD-PARTY-LICENSES.txt"]) {
    if (!observedPaths.has(legalPath)) {
      addFailure(failures, "FRONTEND_LEGAL_NOTICES", `The frontend manifest must bind ${legalPath}.`);
    }
  }
  for (let index = 0; index < actual.files.length; index += 1) {
    const file = actual.files[index];
    if (!/\.(?:css|html|js|json|map|md|txt)$/i.test(file.path)) continue;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.raw);
    } catch {
      addFailure(failures, "FRONTEND_TEXT_UTF8", `frontend build file ${index + 1} is not valid UTF-8 text.`);
      continue;
    }
    scanSensitiveContent(text, `frontend_build_file[${index + 1}]`, failures);
  }
}

async function loadReceipt(repoRoot, relativePath, expectedDigest, fieldPath, failures, { rejectRichArtifacts = true } = {}) {
  const absolute = resolvePrivateArtifact(repoRoot, relativePath, `${fieldPath}_path`, failures);
  if (!absolute) return null;
  let raw;
  try {
    raw = await readRegularFileWithin(path.join(repoRoot, "artifacts", "private"), absolute, maxJsonBytes);
  } catch {
    addFailure(failures, "RECEIPT_UNREADABLE", `${fieldPath} could not be read as a bounded private artifact.`);
    return null;
  }
  if (!sha256Pattern.test(String(expectedDigest || "")) || sha256(raw) !== String(expectedDigest).toLowerCase()) {
    addFailure(failures, "RECEIPT_DIGEST_MISMATCH", `${fieldPath} does not match its supplied SHA-256 digest.`);
  }
  let receipt;
  try {
    receipt = JSON.parse(raw.toString("utf8"));
  } catch {
    addFailure(failures, "RECEIPT_JSON_INVALID", `${fieldPath} is not valid JSON.`);
    return null;
  }
  if (!isPlainObject(receipt)) {
    addFailure(failures, "RECEIPT_SCHEMA", `${fieldPath} must contain a JSON object.`);
    return null;
  }
  scanSensitiveContent(receipt, fieldPath, failures, new WeakSet(), { rejectRichArtifacts });
  return receipt;
}

function freshnessLabel(maximumAgeMilliseconds) {
  return maximumAgeMilliseconds < 60 * 60 * 1000
    ? `${maximumAgeMilliseconds / 60_000} minutes`
    : `${maximumAgeMilliseconds / (60 * 60 * 1000)} hours`;
}

function validateEvidenceTimestamp(
  receipt,
  timestampField,
  releaseRecord,
  fieldPath,
  failures,
  nowMilliseconds,
  maximumAgeMilliseconds = preflightFreshnessMilliseconds,
) {
  const receiptValid = requireUtcTimestamp(receipt?.[timestampField], `${fieldPath}.${timestampField}`, failures);
  const releaseValid = requireUtcTimestamp(releaseRecord?.created_at_utc, "release_record.created_at_utc", failures);
  if (!receiptValid || !releaseValid) return;
  const receiptTime = Date.parse(receipt[timestampField]);
  const releaseTime = Date.parse(releaseRecord.created_at_utc);
  const ageMilliseconds = releaseTime - receiptTime;
  if (ageMilliseconds < 0 || ageMilliseconds > maximumAgeMilliseconds) {
    addFailure(failures, "GOOGLE_CLOUD_PREFLIGHT_FRESHNESS", `${fieldPath}.${timestampField} must be no more than ${freshnessLabel(maximumAgeMilliseconds)} before the release-record timestamp.`);
  }
  if (
    receiptTime > nowMilliseconds + preflightFutureSkewMilliseconds
    || nowMilliseconds - receiptTime > maximumAgeMilliseconds
  ) {
    addFailure(failures, "GOOGLE_CLOUD_PREFLIGHT_FRESHNESS", `${fieldPath}.${timestampField} must be within ${freshnessLabel(maximumAgeMilliseconds)} of the current wall clock and not more than five minutes in the future.`);
  }
}

function validateEntrantAttestationTimestamp(receipt, releaseRecord, fieldPath, failures, nowMilliseconds) {
  validateEvidenceTimestamp(
    receipt,
    "attested_at_utc",
    releaseRecord,
    fieldPath,
    failures,
    nowMilliseconds,
    preflightFreshnessMilliseconds,
  );
}

function validatePreflightReleaseTimestamp(
  releaseRecord,
  failures,
  nowMilliseconds,
  maximumAgeMilliseconds = preflightFreshnessMilliseconds,
) {
  if (!requireUtcTimestamp(releaseRecord?.created_at_utc, "release_record.created_at_utc", failures)) return;
  const releaseTime = Date.parse(releaseRecord.created_at_utc);
  if (
    releaseTime > nowMilliseconds + preflightFutureSkewMilliseconds
    || nowMilliseconds - releaseTime > maximumAgeMilliseconds
  ) {
    addFailure(failures, "GOOGLE_CLOUD_PREFLIGHT_FRESHNESS", `release_record.created_at_utc must be within ${freshnessLabel(maximumAgeMilliseconds)} of the current wall clock and not more than five minutes in the future.`);
  }
}

function validateBillingPreflightReceipt(
  receipt,
  releaseRecord,
  failures,
  nowMilliseconds,
  maximumAgeMilliseconds,
) {
  if (!receipt) return;
  const base = "billing_overview_receipt";
  if (!checkObject(receipt, base, [
    "schema_version",
    "kind",
    "status",
    "attestation_version",
    "attestation_source",
    "attestation_batch_id",
    "attestation_text_sha256",
    "attested_at_utc",
    "cli_checked_at_utc",
    "project_id",
    "billing_account_name_sha256",
    "account_type",
    "billing_enabled_cli_observed",
    "billing_account_open_cli_observed",
    "remaining_credit_greater_than_zero",
    "remaining_time_greater_than_zero",
    "paid_activation_absent",
    "no_paid_upgrade_or_payment_during_release_confirmed",
    "entrant_attestation_confirmed",
  ], failures)) return;
  const requiredValues = {
    schema_version: "2",
    kind: "found-roll-google-cloud-billing-preflight",
    status: "PASS",
    attestation_version: googleCloudAttestationVersion,
    attestation_source: googleCloudAttestationSource,
    project_id: releaseRecord?.google_cloud?.project_id,
    account_type: "free_trial",
    billing_enabled_cli_observed: true,
    billing_account_open_cli_observed: true,
    remaining_credit_greater_than_zero: true,
    remaining_time_greater_than_zero: true,
    paid_activation_absent: true,
    no_paid_upgrade_or_payment_during_release_confirmed: true,
    entrant_attestation_confirmed: true,
  };
  for (const [key, expected] of Object.entries(requiredValues)) {
    if (receipt[key] !== expected) {
      addFailure(failures, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT", `${base}.${key} must match the active unupgraded Free Trial preflight.`);
    }
  }
  requireIdentifier(receipt.attestation_batch_id, `${base}.attestation_batch_id`, failures, googleCloudAttestationBatchPattern);
  requireSha256(receipt.attestation_text_sha256, `${base}.attestation_text_sha256`, failures);
  requireSha256(receipt.billing_account_name_sha256, `${base}.billing_account_name_sha256`, failures);
  validateEntrantAttestationTimestamp(receipt, releaseRecord, base, failures, nowMilliseconds);
  validateEvidenceTimestamp(
    receipt,
    "cli_checked_at_utc",
    releaseRecord,
    base,
    failures,
    nowMilliseconds,
    maximumAgeMilliseconds,
  );
}

function validateSpendCapPreflightReceipt(
  receipt,
  expectedTarget,
  releaseRecord,
  failures,
  nowMilliseconds,
) {
  if (!receipt) return;
  const base = `${expectedTarget}_spend_cap_receipt`;
  if (!checkObject(receipt, base, [
    "schema_version",
    "kind",
    "status",
    "attestation_version",
    "attestation_source",
    "attestation_batch_id",
    "attestation_text_sha256",
    "attested_at_utc",
    "project_id",
    "service_target",
    "cap_status",
    "cap_amount_minor_units",
    "cap_currency",
    "project_scope_confirmed",
    "service_scope_confirmed",
    "lowest_practical_demo_target_confirmed",
    "no_cap_change_during_release_confirmed",
    "entrant_attestation_confirmed",
  ], failures)) return;
  const requiredValues = {
    schema_version: "2",
    kind: "found-roll-google-cloud-spend-cap-preflight",
    status: "PASS",
    attestation_version: googleCloudAttestationVersion,
    attestation_source: googleCloudAttestationSource,
    project_id: releaseRecord?.google_cloud?.project_id,
    service_target: expectedTarget,
    cap_status: "CONFIGURED",
    cap_amount_minor_units: expectedSpendCapMinorUnits[expectedTarget],
    cap_currency: "EUR",
    project_scope_confirmed: true,
    service_scope_confirmed: true,
    lowest_practical_demo_target_confirmed: true,
    no_cap_change_during_release_confirmed: true,
    entrant_attestation_confirmed: true,
  };
  for (const [key, expected] of Object.entries(requiredValues)) {
    if (receipt[key] !== expected) {
      addFailure(failures, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT", `${base}.${key} must match the configured project-and-service spend cap.`);
    }
  }
  requireIdentifier(receipt.attestation_batch_id, `${base}.attestation_batch_id`, failures, googleCloudAttestationBatchPattern);
  requireSha256(receipt.attestation_text_sha256, `${base}.attestation_text_sha256`, failures);
  if (!Number.isInteger(receipt.cap_amount_minor_units) || receipt.cap_amount_minor_units <= 0) {
    addFailure(failures, "GOOGLE_CLOUD_PREFLIGHT_RECEIPT", `${base}.cap_amount_minor_units must be a positive integer.`);
  }
  validateEntrantAttestationTimestamp(receipt, releaseRecord, base, failures, nowMilliseconds);
}

async function loadAndValidateGoogleCloudPreflightReceipts(
  repoRoot,
  releaseRecord,
  failures,
  nowMilliseconds,
  maximumAgeMilliseconds = preflightFreshnessMilliseconds,
) {
  const bindings = releaseRecord?.google_cloud?.preflight_receipts;
  if (!isPlainObject(bindings)) return {};
  const billing = await loadReceipt(
    repoRoot,
    bindings.billing_overview?.path,
    bindings.billing_overview?.sha256,
    "billing_overview_receipt",
    failures,
  );
  const cloudRun = await loadReceipt(
    repoRoot,
    bindings.cloud_run_spend_cap?.path,
    bindings.cloud_run_spend_cap?.sha256,
    "cloud_run_spend_cap_receipt",
    failures,
  );
  const agentPlatform = await loadReceipt(
    repoRoot,
    bindings.agent_platform_spend_cap?.path,
    bindings.agent_platform_spend_cap?.sha256,
    "agent_platform_spend_cap_receipt",
    failures,
  );
  validateBillingPreflightReceipt(billing, releaseRecord, failures, nowMilliseconds, maximumAgeMilliseconds);
  validateSpendCapPreflightReceipt(cloudRun, "cloud_run", releaseRecord, failures, nowMilliseconds);
  validateSpendCapPreflightReceipt(agentPlatform, "agent_platform", releaseRecord, failures, nowMilliseconds);

  const attestations = [billing, cloudRun, agentPlatform].filter(isPlainObject);
  if (attestations.length === 3) {
    const batchIds = new Set(attestations.map((receipt) => receipt.attestation_batch_id));
    const timestamps = new Set(attestations.map((receipt) => receipt.attested_at_utc));
    const textDigests = new Set(attestations.map((receipt) => String(receipt.attestation_text_sha256 || "").toLowerCase()));
    if (batchIds.size !== 1 || timestamps.size !== 1 || textDigests.size !== 1) {
      addFailure(
        failures,
        "GOOGLE_CLOUD_PREFLIGHT_ATTESTATION",
        "Billing, Cloud Run, and Agent Platform receipts must bind the same entrant-attestation batch, timestamp, and text digest.",
      );
    } else if (!textDigests.has(expectedEntrantAttestationTextSha256)) {
      addFailure(
        failures,
        "GOOGLE_CLOUD_PREFLIGHT_ATTESTATION",
        "The entrant-attestation text digest does not match the exact approved confirmation for this release.",
      );
    }
  }
  return { billing, cloudRun, agentPlatform };
}

function validateSanitizedObjectInventory(inventory, fieldPath, failures) {
  if (!Array.isArray(inventory) || inventory.length > 10_000) {
    addFailure(failures, "PROJECT_STORAGE_OBJECT_INVENTORY", `${fieldPath} must be a bounded sanitized object array.`);
    return { count: null, bytes: null };
  }
  let bytes = 0;
  const identities = [];
  for (let index = 0; index < inventory.length; index += 1) {
    const entry = inventory[index];
    const entryPath = `${fieldPath}[${index}]`;
    if (!checkObject(entry, entryPath, ["object_id_sha256", "generation", "size_bytes"], failures)) continue;
    requireSha256(entry.object_id_sha256, `${entryPath}.object_id_sha256`, failures);
    requireIdentifier(entry.generation, `${entryPath}.generation`, failures, /^\d{1,32}$/);
    requireNonNegativeInteger(entry.size_bytes, `${entryPath}.size_bytes`, failures);
    identities.push(String(entry.object_id_sha256 || "").toLowerCase());
    if (Number.isSafeInteger(entry.size_bytes)) bytes += entry.size_bytes;
  }
  if (new Set(identities).size !== identities.length || identities.join("\n") !== [...identities].sort().join("\n")) {
    addFailure(failures, "PROJECT_STORAGE_OBJECT_INVENTORY", `${fieldPath} must contain unique object-generation hashes in deterministic order.`);
  }
  return { count: inventory.length, bytes };
}

function validateProjectStorageReceipt(receipt, expectedPhase, expectedService, releaseRecord, failures) {
  if (!receipt) return;
  const base = `${expectedPhase}_project_storage_receipt`;
  if (!checkObject(receipt, base, [
    "schema_version",
    "kind",
    "status",
    "phase",
    "observed_at_utc",
    "project_id",
    "project_number",
    "service",
    "revision",
    "revision_created_at_utc",
    "revision_image_digest",
    "revision_image_resource",
    "source_deploy_build_id",
    "source_deploy_build_location",
    "source_deploy_build_resource",
    "source_deploy_build_binding_source",
    "source_deploy_build_source_location_sha256",
    "maximum_bytes_exclusive",
    "observed_bytes",
    "active_bucket_inventory_sha256",
    "soft_deleted_bucket_inventory_sha256",
    "soft_deleted_bucket_count",
    "cloud_build_inventory_sha256",
    "cloud_build_locations",
    "cloud_build_locations_source",
    "direct_build_identity_inventory_sha256",
    "direct_build_identity_count",
    "direct_build_inventory_stable",
    "cloud_build_asset_snapshot_before_sha256",
    "cloud_build_asset_snapshot_before_count",
    "cloud_build_asset_inventory_sha256",
    "cloud_build_asset_count",
    "cloud_build_asset_inventory_exhaustive",
    "cloud_build_asset_snapshot_before_utc",
    "cloud_build_asset_snapshot_after_utc",
    "cloud_build_asset_inventory_stable",
    "completed_build_count",
    "build_inventory_exhaustive",
    "artifact_repository_inventory_sha256",
    "repository_count",
    "repository_inventory_exhaustive",
    "artifact_image_inventory_sha256",
    "image_digest_count",
    "image_size_bytes",
    "artifact_inventory_exhaustive",
    "soft_deleted_bucket_inventory_exhaustive",
    "soft_deleted_object_inventory_exhaustive",
    "image_digests_and_sizes_included",
    "buckets",
    "soft_deleted_buckets",
    "builds",
    "cloud_build_assets_before",
    "cloud_build_assets",
    "artifact_repositories",
    "artifact_images",
    "revision_images",
  ], failures)) return;
  const requiredValues = {
    schema_version: "1",
    kind: "found-roll-google-cloud-project-storage-audit",
    status: "PASS",
    phase: expectedPhase,
    project_id: releaseRecord?.google_cloud?.project_id,
    project_number: releaseRecord?.google_cloud?.project_number,
    service: expectedService,
    maximum_bytes_exclusive: 5 * 1024 * 1024 * 1024,
    soft_deleted_bucket_count: 0,
    build_inventory_exhaustive: true,
    cloud_build_locations_source: "cloud-build-v2-paginated-project-locations+global",
    direct_build_inventory_stable: true,
    cloud_build_asset_inventory_exhaustive: false,
    repository_inventory_exhaustive: true,
    artifact_inventory_exhaustive: true,
    soft_deleted_bucket_inventory_exhaustive: true,
    soft_deleted_object_inventory_exhaustive: true,
    image_digests_and_sizes_included: true,
  };
  for (const [key, expected] of Object.entries(requiredValues)) {
    if (receipt[key] !== expected) {
      addFailure(failures, "PROJECT_STORAGE_RECEIPT", `${base}.${key} does not match the required post-source-deploy storage audit.`);
    }
  }
  requireIdentifier(receipt.revision, `${base}.revision`, failures);
  if (!new RegExp(`^${expectedService}-\\d{5}-[a-z0-9]{3}$`).test(String(receipt.revision || ""))) {
    addFailure(failures, "PROJECT_STORAGE_SERVICE_REVISION", `${base}.revision must be an exact revision of ${expectedService}.`);
  }
  if (!imageDigestPattern.test(String(receipt.revision_image_digest || ""))) {
    addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${base}.revision_image_digest must be an exact SHA-256 container digest.`);
  }
  requireIdentifier(receipt.source_deploy_build_id, `${base}.source_deploy_build_id`, failures);
  requireIdentifier(receipt.source_deploy_build_location, `${base}.source_deploy_build_location`, failures);
  requireIdentifier(receipt.source_deploy_build_resource, `${base}.source_deploy_build_resource`, failures);
  const expectedBuildLocations = Array.isArray(receipt.cloud_build_locations) ? receipt.cloud_build_locations.map(String) : [];
  if (
    expectedBuildLocations.length < 2
    || expectedBuildLocations.length > 200
    || !expectedBuildLocations.includes("global")
    || !expectedBuildLocations.includes("us-central1")
    || new Set(expectedBuildLocations).size !== expectedBuildLocations.length
    || expectedBuildLocations.join("\n") !== [...expectedBuildLocations].sort().join("\n")
    || expectedBuildLocations.some((location) => !/^[a-z][a-z0-9-]{0,62}$/.test(location))
  ) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_LOCATION", `${base}.cloud_build_locations must be the unique sorted paginated Cloud Build v2 location set plus global, including us-central1.`);
  }
  const expectedSourceBuildResource = `projects/${releaseRecord?.google_cloud?.project_number}/locations/${receipt.source_deploy_build_location}/builds/${receipt.source_deploy_build_id}`;
  if (
    !expectedBuildLocations.includes(receipt.source_deploy_build_location)
    || receipt.source_deploy_build_resource !== expectedSourceBuildResource
  ) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_LOCATION", `${base} must bind the exact project, location, and resource of its source-deploy build.`);
  }
  const expectedRevisionImagePrefix = `us-central1-docker.pkg.dev/${releaseRecord?.google_cloud?.project_id}/cloud-run-source-deploy/`;
  const revisionImagePackage = typeof receipt.revision_image_resource === "string"
    ? receipt.revision_image_resource.slice(0, -String(`@${receipt.revision_image_digest}`).length)
    : "";
  const revisionImagePackageSuffix = revisionImagePackage.slice(expectedRevisionImagePrefix.length);
  if (
    typeof receipt.revision_image_resource !== "string"
    || !revisionImagePackage.startsWith(expectedRevisionImagePrefix)
    || !/^[^/:@\s]+$/.test(revisionImagePackageSuffix)
    || receipt.revision_image_resource !== `${revisionImagePackage}@${receipt.revision_image_digest}`
  ) {
    addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${base}.revision_image_resource must be the exact dedicated-project Artifact Registry package@digest.`);
  }
  if (receipt.source_deploy_build_binding_source !== "cloud-run-build-annotations") {
    addFailure(failures, "PROJECT_STORAGE_BUILD_BINDING", `${base}.source_deploy_build_binding_source must be the authoritative Cloud Run build annotations.`);
  }
  requireSha256(receipt.source_deploy_build_source_location_sha256, `${base}.source_deploy_build_source_location_sha256`, failures);
  const observedValid = requireUtcTimestamp(receipt.observed_at_utc, `${base}.observed_at_utc`, failures);
  const revisionValid = requireUtcTimestamp(receipt.revision_created_at_utc, `${base}.revision_created_at_utc`, failures);
  const projectValid = requireUtcTimestamp(
    releaseRecord?.google_cloud?.project_created_at_utc,
    "release_record.google_cloud.project_created_at_utc",
    failures,
  );
  const releaseValid = requireUtcTimestamp(releaseRecord?.created_at_utc, "release_record.created_at_utc", failures);
  if (observedValid && revisionValid) {
    const auditDelay = Date.parse(receipt.observed_at_utc) - Date.parse(receipt.revision_created_at_utc);
    if (auditDelay < 0 || auditDelay > operationalPreflightFreshnessMilliseconds) {
      addFailure(failures, "PROJECT_STORAGE_AUDIT_TIMING", `${base} must be observed no more than ten minutes after its exact source-deploy revision was created.`);
    }
  }
  if (observedValid && revisionValid && projectValid && releaseValid) {
    const projectTime = Date.parse(releaseRecord.google_cloud.project_created_at_utc);
    const revisionTime = Date.parse(receipt.revision_created_at_utc);
    const observedTime = Date.parse(receipt.observed_at_utc);
    const releaseTime = Date.parse(releaseRecord.created_at_utc);
    if (revisionTime < projectTime || observedTime < projectTime) {
      addFailure(failures, "PROJECT_STORAGE_TIMELINE", `${base} cannot predate creation of the dedicated project.`);
    }
    if (observedTime > releaseTime || releaseTime - observedTime > preflightFreshnessMilliseconds) {
      addFailure(failures, "PROJECT_STORAGE_FRESHNESS", `${base} must precede the release record by no more than 24 hours.`);
    }
  }
  for (const key of [
    "active_bucket_inventory_sha256",
    "soft_deleted_bucket_inventory_sha256",
    "cloud_build_inventory_sha256",
    "direct_build_identity_inventory_sha256",
    "cloud_build_asset_snapshot_before_sha256",
    "cloud_build_asset_inventory_sha256",
    "artifact_repository_inventory_sha256",
    "artifact_image_inventory_sha256",
  ]) requireSha256(receipt[key], `${base}.${key}`, failures);
  for (const key of [
    "maximum_bytes_exclusive",
    "observed_bytes",
    "soft_deleted_bucket_count",
    "completed_build_count",
    "direct_build_identity_count",
    "cloud_build_asset_snapshot_before_count",
    "cloud_build_asset_count",
    "repository_count",
    "image_digest_count",
    "image_size_bytes",
  ]) requireNonNegativeInteger(receipt[key], `${base}.${key}`, failures);
  if (Number.isSafeInteger(receipt.observed_bytes) && receipt.observed_bytes >= 5 * 1024 * 1024 * 1024) {
    addFailure(failures, "PROJECT_STORAGE_CEILING", `${base}.observed_bytes must remain below five GiB.`);
  }
  const minimumInventoryCount = expectedPhase === "after_app_source_deploy" ? 1 : 2;
  if (receipt.completed_build_count < minimumInventoryCount) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${base}.completed_build_count must cover every completed source deploy through this phase.`);
  }
  if (receipt.image_digest_count < minimumInventoryCount || receipt.image_size_bytes <= 0) {
    addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${base} must include digest and positive-size evidence for every source-deployed image through this phase.`);
  }
  if (!Array.isArray(receipt.buckets) || receipt.buckets.length < 1 || receipt.buckets.length > 20) {
    addFailure(failures, "PROJECT_STORAGE_BUCKET_INVENTORY", `${base}.buckets must enumerate every active project bucket.`);
    return;
  }
  let enumeratedBytes = receipt.image_size_bytes;
  const bucketNames = new Set();
  receipt.buckets.forEach((bucket, index) => {
    const bucketBase = `${base}.buckets[${index}]`;
    if (!checkObject(bucket, bucketBase, [
      "bucket",
      "project_number",
      "ordinary_bytes",
      "soft_deleted_bytes",
      "current_object_count",
      "all_version_object_count",
      "soft_deleted_object_count",
      "versioning_enabled",
      "retention_policy_seconds",
      "soft_delete_seconds",
      "current_object_inventory_sha256",
      "all_version_object_inventory_sha256",
      "soft_deleted_object_inventory_sha256",
      "current_objects",
      "all_version_objects",
      "soft_deleted_objects",
    ], failures)) return;
    requireIdentifier(bucket.bucket, `${bucketBase}.bucket`, failures, bucketNamePattern);
    if (bucketNames.has(bucket.bucket)) addFailure(failures, "PROJECT_STORAGE_BUCKET_INVENTORY", `${base}.buckets must not repeat a bucket.`);
    bucketNames.add(bucket.bucket);
    if (bucket.project_number !== releaseRecord?.google_cloud?.project_number) {
      addFailure(failures, "PROJECT_STORAGE_BUCKET_OWNERSHIP", `${bucketBase}.project_number must match the dedicated project.`);
    }
    for (const key of [
      "ordinary_bytes",
      "soft_deleted_bytes",
      "current_object_count",
      "all_version_object_count",
      "soft_deleted_object_count",
      "retention_policy_seconds",
      "soft_delete_seconds",
    ]) requireNonNegativeInteger(bucket[key], `${bucketBase}.${key}`, failures);
    requireSha256(bucket.current_object_inventory_sha256, `${bucketBase}.current_object_inventory_sha256`, failures);
    requireSha256(bucket.all_version_object_inventory_sha256, `${bucketBase}.all_version_object_inventory_sha256`, failures);
    requireSha256(bucket.soft_deleted_object_inventory_sha256, `${bucketBase}.soft_deleted_object_inventory_sha256`, failures);
    const currentInventory = validateSanitizedObjectInventory(bucket.current_objects, `${bucketBase}.current_objects`, failures);
    const allVersionInventory = validateSanitizedObjectInventory(bucket.all_version_objects, `${bucketBase}.all_version_objects`, failures);
    const softDeletedInventory = validateSanitizedObjectInventory(bucket.soft_deleted_objects, `${bucketBase}.soft_deleted_objects`, failures);
    if (
      currentInventory.count !== bucket.current_object_count
      || allVersionInventory.count !== bucket.all_version_object_count
      || softDeletedInventory.count !== bucket.soft_deleted_object_count
      || allVersionInventory.bytes !== bucket.ordinary_bytes
      || softDeletedInventory.bytes !== bucket.soft_deleted_bytes
    ) {
      addFailure(failures, "PROJECT_STORAGE_OBJECT_INVENTORY", `${bucketBase} counts and bytes must be recomputable from its sanitized object arrays.`);
    }
    if (
      Array.isArray(bucket.current_objects)
      && Array.isArray(bucket.all_version_objects)
      && Array.isArray(bucket.soft_deleted_objects)
      && (
        sha256(canonicalJsonBuffer(bucket.current_objects)) !== String(bucket.current_object_inventory_sha256 || "").toLowerCase()
        || sha256(canonicalJsonBuffer(bucket.all_version_objects)) !== String(bucket.all_version_object_inventory_sha256 || "").toLowerCase()
        || sha256(canonicalJsonBuffer(bucket.soft_deleted_objects)) !== String(bucket.soft_deleted_object_inventory_sha256 || "").toLowerCase()
      )
    ) {
      addFailure(failures, "PROJECT_STORAGE_OBJECT_INVENTORY_HASH", `${bucketBase} object-inventory hashes must be recomputable from the sanitized child arrays.`);
    }
    if (
      Array.isArray(bucket.current_objects)
      && Array.isArray(bucket.all_version_objects)
      && !canonicalJsonBuffer(bucket.current_objects).equals(canonicalJsonBuffer(bucket.all_version_objects))
    ) {
      addFailure(failures, "PROJECT_STORAGE_RETENTION", `${bucketBase} current and all-version inventories must be identical while versioning is disabled.`);
    }
    if (
      bucket.versioning_enabled !== false
      || bucket.retention_policy_seconds !== 0
      || bucket.soft_delete_seconds !== 0
      || bucket.soft_deleted_bytes !== 0
      || bucket.soft_deleted_object_count !== 0
      || bucket.current_object_count !== bucket.all_version_object_count
    ) {
      addFailure(failures, "PROJECT_STORAGE_RETENTION", `${bucketBase} must prove zero versioning, retention, soft-delete policy, noncurrent versions, and soft-deleted objects.`);
    }
    if (Number.isSafeInteger(bucket.ordinary_bytes) && Number.isSafeInteger(bucket.soft_deleted_bytes)) {
      enumeratedBytes += bucket.ordinary_bytes + bucket.soft_deleted_bytes;
    }
  });
  if (bucketNames.size > 0 && !bucketNames.has(releaseRecord?.google_cloud?.evidence_bucket)) {
    addFailure(failures, "PROJECT_STORAGE_EVIDENCE_BUCKET", `${base}.buckets must include the exact frozen evidence bucket.`);
  }
  if (Array.isArray(receipt.buckets)) {
    const sortedBucketNames = receipt.buckets.map((bucket) => bucket?.bucket);
    if (sortedBucketNames.join("\n") !== [...sortedBucketNames].sort().join("\n")) {
      addFailure(failures, "PROJECT_STORAGE_BUCKET_INVENTORY", `${base}.buckets must use deterministic bucket-name order.`);
    }
    if (sha256(canonicalJsonBuffer(receipt.buckets)) !== String(receipt.active_bucket_inventory_sha256 || "").toLowerCase()) {
      addFailure(failures, "PROJECT_STORAGE_INVENTORY_HASH", `${base}.active_bucket_inventory_sha256 must be recomputable from buckets.`);
    }
  }
  if (!Array.isArray(receipt.soft_deleted_buckets) || receipt.soft_deleted_buckets.length !== 0) {
    addFailure(failures, "PROJECT_STORAGE_RETENTION", `${base}.soft_deleted_buckets must be the exhaustively observed empty inventory.`);
  } else if (sha256(canonicalJsonBuffer(receipt.soft_deleted_buckets)) !== String(receipt.soft_deleted_bucket_inventory_sha256 || "").toLowerCase()) {
    addFailure(failures, "PROJECT_STORAGE_INVENTORY_HASH", `${base}.soft_deleted_bucket_inventory_sha256 must be recomputable from soft_deleted_buckets.`);
  }

  const buildResources = new Set();
  let completedBuildCount = 0;
  let sourceBuild = null;
  if (!Array.isArray(receipt.builds) || receipt.builds.length < minimumInventoryCount || receipt.builds.length > 100) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${base}.builds must preserve the complete sanitized Cloud Build inventory.`);
  } else {
    for (let index = 0; index < receipt.builds.length; index += 1) {
      const build = receipt.builds[index];
      const buildBase = `${base}.builds[${index}]`;
      if (!checkObject(build, buildBase, ["build_id", "location", "build_resource", "status", "created_at_utc", "finished_at_utc", "source_location_sha256", "image_digests", "image_resources"], failures)) continue;
      requireIdentifier(build.build_id, `${buildBase}.build_id`, failures);
      requireIdentifier(build.location, `${buildBase}.location`, failures);
      requireIdentifier(build.build_resource, `${buildBase}.build_resource`, failures);
      requireIdentifier(build.status, `${buildBase}.status`, failures);
      requireSha256(build.source_location_sha256, `${buildBase}.source_location_sha256`, failures);
      const createdValid = requireUtcTimestamp(build.created_at_utc, `${buildBase}.created_at_utc`, failures);
      const finishedValid = requireUtcTimestamp(build.finished_at_utc, `${buildBase}.finished_at_utc`, failures);
      const expectedBuildResource = `projects/${releaseRecord?.google_cloud?.project_number}/locations/${build.location}/builds/${build.build_id}`;
      if (!expectedBuildLocations.includes(build.location) || build.build_resource !== expectedBuildResource) {
        addFailure(failures, "PROJECT_STORAGE_BUILD_LOCATION", `${buildBase} must identify an exact global or us-central1 build resource in the dedicated project.`);
      }
      if (buildResources.has(build.build_resource)) addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${base}.builds must not repeat a build resource.`);
      buildResources.add(build.build_resource);
      if (build.status === "SUCCESS") completedBuildCount += 1;
      if (
        build.build_id === receipt.source_deploy_build_id
        && build.location === receipt.source_deploy_build_location
        && build.build_resource === receipt.source_deploy_build_resource
      ) sourceBuild = build;
      if (!Array.isArray(build.image_digests)) {
        addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.image_digests must be an array.`);
      } else {
        const normalizedDigests = build.image_digests.map(String);
        if (new Set(normalizedDigests).size !== normalizedDigests.length || normalizedDigests.join("\n") !== [...normalizedDigests].sort().join("\n")) {
          addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.image_digests must be unique and sorted.`);
        }
        for (const digest of normalizedDigests) {
          if (!imageDigestPattern.test(digest)) addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.image_digests contains an invalid digest.`);
        }
      }
      if (!Array.isArray(build.image_resources)) {
        addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.image_resources must be an array.`);
      } else {
        const normalizedResources = build.image_resources.map(String);
        if (new Set(normalizedResources).size !== normalizedResources.length || normalizedResources.join("\n") !== [...normalizedResources].sort().join("\n")) {
          addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.image_resources must be unique and sorted.`);
        }
        for (const imageResource of normalizedResources) {
          const resourceMatch = imageResource.match(new RegExp(`^us-central1-docker\\.pkg\\.dev/${releaseRecord?.google_cloud?.project_id}/cloud-run-source-deploy/[^/:@\\s]+@(sha256:[a-f0-9]{64})$`));
          if (!resourceMatch || !Array.isArray(build.image_digests) || !build.image_digests.includes(resourceMatch[1])) {
            addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.image_resources must exactly bind its dedicated-project package and declared digest.`);
          }
        }
      }
      if (createdValid && finishedValid && Date.parse(build.finished_at_utc) < Date.parse(build.created_at_utc)) {
        addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase}.finished_at_utc must not precede creation.`);
      }
      if (finishedValid && observedValid && Date.parse(build.finished_at_utc) > Date.parse(receipt.observed_at_utc)) {
        addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${buildBase} cannot finish after the storage audit.`);
      }
      if (createdValid && projectValid && Date.parse(build.created_at_utc) < Date.parse(releaseRecord.google_cloud.project_created_at_utc)) {
        addFailure(failures, "PROJECT_STORAGE_TIMELINE", `${buildBase} cannot predate the dedicated project.`);
      }
    }
    const orderedBuildResources = receipt.builds.map((build) => build?.build_resource);
    if (orderedBuildResources.join("\n") !== [...orderedBuildResources].sort().join("\n")) {
      addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${base}.builds must use deterministic build-resource order.`);
    }
    if (completedBuildCount !== receipt.completed_build_count) {
      addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${base}.completed_build_count must be recomputable from builds.`);
    }
    if (sha256(canonicalJsonBuffer(receipt.builds)) !== String(receipt.cloud_build_inventory_sha256 || "").toLowerCase()) {
      addFailure(failures, "PROJECT_STORAGE_INVENTORY_HASH", `${base}.cloud_build_inventory_sha256 must be recomputable from builds.`);
    }
    const directBuildIdentities = receipt.builds.map((build) => ({
      build_id: build?.build_id,
      location: build?.location,
      build_resource: build?.build_resource,
    }));
    if (
      receipt.direct_build_identity_count !== directBuildIdentities.length
      || sha256(canonicalJsonBuffer(directBuildIdentities)) !== String(receipt.direct_build_identity_inventory_sha256 || "").toLowerCase()
    ) {
      addFailure(failures, "PROJECT_STORAGE_BUILD_INVENTORY", `${base} direct build identity count and hash must be recomputable from the authoritative all-location build inventory.`);
    }
  }
  const validateBuildAssetSnapshot = (assets, fieldName, expectedCount, expectedHash) => {
    const fieldPath = `${base}.${fieldName}`;
    if (!Array.isArray(assets) || assets.length > 100) {
      addFailure(failures, "PROJECT_STORAGE_BUILD_ASSET_INVENTORY", `${fieldPath} must preserve the sanitized supplemental Cloud Asset Build snapshot.`);
      return null;
    }
    const resources = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const assetBase = `${fieldPath}[${index}]`;
      if (!checkObject(asset, assetBase, ["build_id", "location", "build_resource"], failures)) continue;
      const expectedResource = `projects/${releaseRecord?.google_cloud?.project_number}/locations/${asset.location}/builds/${asset.build_id}`;
      if (!expectedBuildLocations.includes(asset.location) || asset.build_resource !== expectedResource || !buildResources.has(asset.build_resource)) {
        addFailure(failures, "PROJECT_STORAGE_BUILD_ASSET_INVENTORY", `${assetBase} must be an exact observed subset identity of the direct all-location Build inventory.`);
      }
      resources.push(asset.build_resource);
    }
    if (new Set(resources).size !== resources.length || resources.join("\n") !== [...resources].sort().join("\n")) {
      addFailure(failures, "PROJECT_STORAGE_BUILD_ASSET_INVENTORY", `${fieldPath} must contain unique build resources in deterministic order.`);
    }
    const snapshotBuffer = canonicalJsonBuffer(assets);
    if (expectedCount !== assets.length || sha256(snapshotBuffer) !== String(expectedHash || "").toLowerCase()) {
      addFailure(failures, "PROJECT_STORAGE_BUILD_ASSET_INVENTORY", `${fieldPath} count and hash must be recomputable from its sanitized array.`);
    }
    return snapshotBuffer;
  };
  const beforeAssetsBuffer = validateBuildAssetSnapshot(
    receipt.cloud_build_assets_before,
    "cloud_build_assets_before",
    receipt.cloud_build_asset_snapshot_before_count,
    receipt.cloud_build_asset_snapshot_before_sha256,
  );
  const afterAssetsBuffer = validateBuildAssetSnapshot(
    receipt.cloud_build_assets,
    "cloud_build_assets",
    receipt.cloud_build_asset_count,
    receipt.cloud_build_asset_inventory_sha256,
  );
  const assetBeforeValid = requireUtcTimestamp(receipt.cloud_build_asset_snapshot_before_utc, `${base}.cloud_build_asset_snapshot_before_utc`, failures);
  const assetAfterValid = requireUtcTimestamp(receipt.cloud_build_asset_snapshot_after_utc, `${base}.cloud_build_asset_snapshot_after_utc`, failures);
  if (
    typeof receipt.cloud_build_asset_inventory_stable !== "boolean"
    || (beforeAssetsBuffer && afterAssetsBuffer && receipt.cloud_build_asset_inventory_stable !== beforeAssetsBuffer.equals(afterAssetsBuffer))
  ) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_ASSET_INVENTORY", `${base}.cloud_build_asset_inventory_stable must be recomputable from the two supplemental snapshots.`);
  }
  if (
    assetBeforeValid
    && assetAfterValid
    && (
      Date.parse(receipt.cloud_build_asset_snapshot_before_utc) > Date.parse(receipt.cloud_build_asset_snapshot_after_utc)
      || (observedValid && Date.parse(receipt.cloud_build_asset_snapshot_after_utc) > Date.parse(receipt.observed_at_utc))
    )
  ) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_ASSET_INVENTORY", `${base} Cloud Asset snapshots must be chronologically ordered before the receipt observation.`);
  }
  if (
    !sourceBuild
    || sourceBuild.status !== "SUCCESS"
    || sourceBuild.source_location_sha256 !== receipt.source_deploy_build_source_location_sha256
    || !Array.isArray(sourceBuild.image_digests)
    || !sourceBuild.image_digests.includes(receipt.revision_image_digest)
    || !Array.isArray(sourceBuild.image_resources)
    || !sourceBuild.image_resources.includes(receipt.revision_image_resource)
  ) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_BINDING", `${base}.source_deploy_build_id, location, and resource must identify a successful build that produced revision_image_digest.`);
  } else if (
    revisionValid
    && Number.isFinite(Date.parse(sourceBuild.finished_at_utc))
    && Date.parse(sourceBuild.finished_at_utc) > Date.parse(receipt.revision_created_at_utc)
  ) {
    addFailure(failures, "PROJECT_STORAGE_BUILD_BINDING", `${base}.source_deploy_build_id must finish no later than the revision it produced was created.`);
  }

  const repositoriesByUri = new Map();
  if (!Array.isArray(receipt.artifact_repositories) || receipt.artifact_repositories.length < 1 || receipt.artifact_repositories.length > 20) {
    addFailure(failures, "PROJECT_STORAGE_REPOSITORY_INVENTORY", `${base}.artifact_repositories must preserve every project Artifact Registry repository.`);
  } else {
    for (let index = 0; index < receipt.artifact_repositories.length; index += 1) {
      const repository = receipt.artifact_repositories[index];
      const repositoryBase = `${base}.artifact_repositories[${index}]`;
      if (!checkObject(repository, repositoryBase, ["repository", "location", "format", "repository_uri", "artifact_count", "artifact_size_bytes"], failures)) continue;
      for (const key of ["repository", "location", "format", "repository_uri"]) requireIdentifier(repository[key], `${repositoryBase}.${key}`, failures);
      requireNonNegativeInteger(repository.artifact_count, `${repositoryBase}.artifact_count`, failures);
      requireNonNegativeInteger(repository.artifact_size_bytes, `${repositoryBase}.artifact_size_bytes`, failures);
      const expectedRepositoryUri = `${repository.location}-docker.pkg.dev/${releaseRecord?.google_cloud?.project_id}/${repository.repository}`;
      if (repository.repository_uri !== expectedRepositoryUri) {
        addFailure(failures, "PROJECT_STORAGE_REPOSITORY_IDENTITY", `${repositoryBase}.repository_uri must be derived from its location, dedicated project ID, and repository ID.`);
      }
      if (repository.format !== "DOCKER") {
        addFailure(failures, "PROJECT_STORAGE_NON_DOCKER_REPOSITORY", `${repositoryBase}.format is not DOCKER; remove or separately account that repository before release.`);
      }
      if (repositoriesByUri.has(repository.repository_uri)) addFailure(failures, "PROJECT_STORAGE_REPOSITORY_INVENTORY", `${base}.artifact_repositories must not repeat a repository URI.`);
      repositoriesByUri.set(repository.repository_uri, repository);
    }
    const orderedRepositoryUris = receipt.artifact_repositories.map((repository) => repository?.repository_uri);
    if (orderedRepositoryUris.join("\n") !== [...orderedRepositoryUris].sort().join("\n")) {
      addFailure(failures, "PROJECT_STORAGE_REPOSITORY_INVENTORY", `${base}.artifact_repositories must use deterministic URI order.`);
    }
    if (receipt.repository_count !== receipt.artifact_repositories.length) {
      addFailure(failures, "PROJECT_STORAGE_REPOSITORY_INVENTORY", `${base}.repository_count must be recomputable from artifact_repositories.`);
    }
    if (sha256(canonicalJsonBuffer(receipt.artifact_repositories)) !== String(receipt.artifact_repository_inventory_sha256 || "").toLowerCase()) {
      addFailure(failures, "PROJECT_STORAGE_INVENTORY_HASH", `${base}.artifact_repository_inventory_sha256 must be recomputable from artifact_repositories.`);
    }
  }

  let imageSizeBytes = 0;
  const imageKeys = new Set();
  const imageDigests = new Set();
  const repositoryTotals = new Map();
  if (!Array.isArray(receipt.artifact_images) || receipt.artifact_images.length < minimumInventoryCount || receipt.artifact_images.length > 100) {
    addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${base}.artifact_images must preserve every digest and positive size.`);
  } else {
    for (let index = 0; index < receipt.artifact_images.length; index += 1) {
      const image = receipt.artifact_images[index];
      const imageBase = `${base}.artifact_images[${index}]`;
      if (!checkObject(image, imageBase, ["repository_uri", "package", "digest", "size_bytes"], failures)) continue;
      requireIdentifier(image.repository_uri, `${imageBase}.repository_uri`, failures);
      requireIdentifier(image.package, `${imageBase}.package`, failures);
      if (!imageDigestPattern.test(String(image.digest || ""))) addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${imageBase}.digest must be exact.`);
      requireNonNegativeInteger(image.size_bytes, `${imageBase}.size_bytes`, failures);
      if (image.size_bytes <= 0) addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${imageBase}.size_bytes must be positive.`);
      if (!repositoriesByUri.has(image.repository_uri) || !String(image.package || "").startsWith(`${image.repository_uri}/`)) {
        addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${imageBase} must belong to a preserved Docker repository.`);
      }
      const imageKey = `${image.package}@${image.digest}`;
      if (imageKeys.has(imageKey)) addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${base}.artifact_images must not repeat a package digest.`);
      imageKeys.add(imageKey);
      imageDigests.add(image.digest);
      if (Number.isSafeInteger(image.size_bytes)) {
        imageSizeBytes += image.size_bytes;
        const previous = repositoryTotals.get(image.repository_uri) || { count: 0, bytes: 0 };
        repositoryTotals.set(image.repository_uri, { count: previous.count + 1, bytes: previous.bytes + image.size_bytes });
      }
    }
    const orderedImageKeys = receipt.artifact_images.map((image) => `${image?.package}@${image?.digest}`);
    if (orderedImageKeys.join("\n") !== [...orderedImageKeys].sort().join("\n")) {
      addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${base}.artifact_images must use deterministic package-digest order.`);
    }
    if (receipt.image_digest_count !== receipt.artifact_images.length || receipt.image_size_bytes !== imageSizeBytes) {
      addFailure(failures, "PROJECT_STORAGE_IMAGE_INVENTORY", `${base} image counts and bytes must be recomputable from artifact_images.`);
    }
    if (sha256(canonicalJsonBuffer(receipt.artifact_images)) !== String(receipt.artifact_image_inventory_sha256 || "").toLowerCase()) {
      addFailure(failures, "PROJECT_STORAGE_INVENTORY_HASH", `${base}.artifact_image_inventory_sha256 must be recomputable from artifact_images.`);
    }
  }
  for (const [repositoryUri, repository] of repositoriesByUri.entries()) {
    const totals = repositoryTotals.get(repositoryUri) || { count: 0, bytes: 0 };
    if (repository.artifact_count !== totals.count || repository.artifact_size_bytes !== totals.bytes) {
      addFailure(failures, "PROJECT_STORAGE_REPOSITORY_INVENTORY", `${base} repository counts and bytes must be recomputable from artifact_images.`);
    }
  }

  const revisionNames = new Set();
  let ownRevisionBound = false;
  if (!Array.isArray(receipt.revision_images) || receipt.revision_images.length < minimumInventoryCount || receipt.revision_images.length > 20) {
    addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${base}.revision_images must bind every source-deployed service revision through this phase.`);
  } else {
    for (let index = 0; index < receipt.revision_images.length; index += 1) {
      const revisionImage = receipt.revision_images[index];
      const revisionBase = `${base}.revision_images[${index}]`;
      if (!checkObject(revisionImage, revisionBase, ["service", "revision", "image_digest", "image_package", "image_resource"], failures)) continue;
      requireIdentifier(revisionImage.service, `${revisionBase}.service`, failures);
      requireIdentifier(revisionImage.revision, `${revisionBase}.revision`, failures);
      if (!imageDigestPattern.test(String(revisionImage.image_digest || ""))) addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${revisionBase}.image_digest must be exact.`);
      if (!String(revisionImage.revision || "").startsWith(`${revisionImage.service}-`)) addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${revisionBase}.revision must belong to its service.`);
      if (revisionImage.image_resource !== `${revisionImage.image_package}@${revisionImage.image_digest}` || !imageKeys.has(revisionImage.image_resource)) {
        addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${revisionBase} must bind an exact Artifact Registry package@digest in artifact_images.`);
      }
      if (revisionNames.has(revisionImage.revision)) addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${base}.revision_images must not repeat a revision.`);
      revisionNames.add(revisionImage.revision);
      if (
        revisionImage.service === expectedService
        && revisionImage.revision === receipt.revision
        && revisionImage.image_digest === receipt.revision_image_digest
        && revisionImage.image_resource === receipt.revision_image_resource
      ) ownRevisionBound = true;
    }
  }
  if (!ownRevisionBound) addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${base}.revision_images must contain the receipt service, revision, and digest tuple.`);
  if (!imageKeys.has(receipt.revision_image_resource)) {
    addFailure(failures, "PROJECT_STORAGE_IMAGE_BINDING", `${base}.revision_image_resource must exist as the exact package@digest in artifact_images.`);
  }
  if (Number.isSafeInteger(receipt.observed_bytes) && enumeratedBytes !== receipt.observed_bytes) {
    addFailure(failures, "PROJECT_STORAGE_TOTAL", `${base}.observed_bytes must equal all bucket bytes plus all image bytes.`);
  }
}

async function loadAndValidateProjectStorageReceipts(repoRoot, releaseRecord, failures) {
  const bindings = releaseRecord?.google_cloud?.project_storage_receipts;
  if (!isPlainObject(bindings)) return {};
  const app = await loadReceipt(
    repoRoot,
    bindings.after_app_source_deploy?.path,
    bindings.after_app_source_deploy?.sha256,
    "after_app_source_deploy_project_storage_receipt",
    failures,
  );
  const simulator = await loadReceipt(
    repoRoot,
    bindings.after_simulator_source_deploy?.path,
    bindings.after_simulator_source_deploy?.sha256,
    "after_simulator_source_deploy_project_storage_receipt",
    failures,
  );
  validateProjectStorageReceipt(app, "after_app_source_deploy", "found-roll-app", releaseRecord, failures);
  validateProjectStorageReceipt(
    simulator,
    "after_simulator_source_deploy",
    "found-roll-simulator",
    releaseRecord,
    failures,
  );
  if (app && simulator) {
    if (app.revision === simulator.revision || app.source_deploy_build_resource === simulator.source_deploy_build_resource) {
      addFailure(failures, "PROJECT_STORAGE_PHASE_BINDING", "App and simulator source-deploy receipts must bind distinct revisions and exact build resources.");
    }
    const appObserved = Date.parse(app.observed_at_utc);
    const simulatorRevisionCreated = Date.parse(simulator.revision_created_at_utc);
    if (Number.isFinite(appObserved) && Number.isFinite(simulatorRevisionCreated) && simulatorRevisionCreated < appObserved) {
      addFailure(failures, "PROJECT_STORAGE_PHASE_BINDING", "The simulator source-deploy revision cannot predate the completed app-phase storage audit.");
    }
    const simulatorAppBinding = Array.isArray(simulator.revision_images)
      ? simulator.revision_images.find((binding) => binding?.service === "found-roll-app")
      : null;
    if (
      !simulatorAppBinding
      || simulatorAppBinding.revision !== app.revision
      || simulatorAppBinding.image_digest !== app.revision_image_digest
      || simulatorAppBinding.image_resource !== app.revision_image_resource
    ) {
      addFailure(failures, "PROJECT_STORAGE_PHASE_BINDING", "The simulator-phase receipt must preserve the exact app source revision and image digest from the app phase.");
    }
    const appSourceBuild = Array.isArray(app.builds)
      ? app.builds.find((build) => build?.build_resource === app.source_deploy_build_resource)
      : null;
    let appSourceBuildPreserved = false;
    if (isPlainObject(appSourceBuild) && Array.isArray(simulator.builds)) {
      try {
        const expectedAppSourceBuild = canonicalJsonBuffer(appSourceBuild);
        appSourceBuildPreserved = simulator.builds.some(
          (build) => isPlainObject(build) && canonicalJsonBuffer(build).equals(expectedAppSourceBuild),
        );
      } catch {
        appSourceBuildPreserved = false;
      }
    }
    if (!appSourceBuildPreserved) {
      addFailure(failures, "PROJECT_STORAGE_PHASE_BINDING", "The simulator-phase build inventory must preserve the exact app source-build record from the app phase.");
    }
  }
  return { app, simulator };
}

function validateCanonicalRevisionImageBindings(
  releaseRecord,
  storageReceipts,
  preparationReceipts,
  runReceipts,
  failures,
) {
  const canonical = releaseRecord?.google_cloud?.canonical_revision_images;
  const appCanonical = canonical?.app;
  const simulatorCanonical = canonical?.simulator;
  const appStorage = storageReceipts?.app;
  const simulatorStorage = storageReceipts?.simulator;
  const referenceRun = (runReceipts || []).find(Boolean);
  if (![appCanonical, simulatorCanonical, appStorage, simulatorStorage, referenceRun].every(isPlainObject)) return;

  for (const [binding, receiptKey, expectedService] of [
    [appCanonical, "app_revision", "found-roll-app"],
    [simulatorCanonical, "simulator_revision", "found-roll-simulator"],
  ]) {
    if (binding.service !== expectedService || binding.revision !== referenceRun[receiptKey]) {
      addFailure(failures, "CANONICAL_REVISION_IMAGE", `release_record.google_cloud.canonical_revision_images.${expectedService === "found-roll-app" ? "app" : "simulator"} must bind the exact revision used by all canonical runs.`);
    }
  }
  if (appCanonical.revision === simulatorCanonical.revision || appCanonical.image_resource === simulatorCanonical.image_resource) {
    addFailure(failures, "CANONICAL_REVISION_IMAGE", "Canonical app and simulator revisions and exact image resources must be distinct.");
  }
  if (appCanonical.image_resource !== appStorage.revision_image_resource) {
    addFailure(failures, "CANONICAL_REVISION_IMAGE", "The canonical app revision must use the exact package@digest produced by the app source deploy.");
  }
  if (
    simulatorCanonical.revision !== simulatorStorage.revision
    || simulatorCanonical.revision_created_at_utc !== simulatorStorage.revision_created_at_utc
    || simulatorCanonical.image_digest !== simulatorStorage.revision_image_digest
    || simulatorCanonical.image_resource !== simulatorStorage.revision_image_resource
  ) {
    addFailure(failures, "CANONICAL_REVISION_IMAGE", "The canonical simulator revision must be the exact simulator source-deploy revision and image digest.");
  }
  const finalInventoryImages = new Set(
    Array.isArray(simulatorStorage.artifact_images)
      ? simulatorStorage.artifact_images.map((image) => `${image?.package}@${image?.digest}`)
      : [],
  );
  for (const binding of [appCanonical, simulatorCanonical]) {
    if (!finalInventoryImages.has(binding.image_resource)) {
      addFailure(failures, "CANONICAL_REVISION_IMAGE", "Every canonical service image resource must exist in the simulator-phase project artifact inventory.");
    }
  }

  const projectCreated = Date.parse(releaseRecord?.google_cloud?.project_created_at_utc);
  const releaseCreated = Date.parse(releaseRecord?.created_at_utc);
  const appCanonicalCreated = Date.parse(appCanonical.revision_created_at_utc);
  const simulatorCanonicalCreated = Date.parse(simulatorCanonical.revision_created_at_utc);
  const appSourceCreated = Date.parse(appStorage.revision_created_at_utc);
  const simulatorAuditObserved = Date.parse(simulatorStorage.observed_at_utc);
  const preparationTimes = (preparationReceipts || []).map((receipt) => Date.parse(receipt?.prepared_at)).filter(Number.isFinite);
  const firstPreparation = preparationTimes.length ? Math.min(...preparationTimes) : null;
  if (
    ![
      projectCreated,
      releaseCreated,
      appCanonicalCreated,
      simulatorCanonicalCreated,
      appSourceCreated,
      simulatorAuditObserved,
    ].every(Number.isFinite)
    || firstPreparation === null
  ) return;
  if (
    appSourceCreated < projectCreated
    || simulatorCanonicalCreated < projectCreated
    || appCanonicalCreated < simulatorAuditObserved
    || appCanonicalCreated < appSourceCreated
    || firstPreparation <= appCanonicalCreated
    || firstPreparation <= simulatorCanonicalCreated
    || firstPreparation <= simulatorAuditObserved
    || releaseCreated < firstPreparation
  ) {
    addFailure(failures, "CANONICAL_CLOUD_TIMELINE", "Project creation, source deploys, final canonical revisions, preparations, and release freeze must occur in that order.");
  }
}

async function validateFrozenContractSources(repoRoot, frozenContracts, failures) {
  const expectedPaths = {
    prompt: "service/app/agent_contract.py",
    output_schema: "service/app/domain.py",
    policy: "service/app/policy.py",
  };
  if (!isPlainObject(frozenContracts)) return;
  for (const [key, expectedPath] of Object.entries(expectedPaths)) {
    const binding = frozenContracts[key];
    if (!isPlainObject(binding) || binding.source_path !== expectedPath) {
      addFailure(failures, "CONTRACT_SOURCE_PATH", `release_record.frozen_contracts.${key}.source_path must identify the canonical source file.`);
      continue;
    }
    const raw = await loadRepositoryFile(
      repoRoot,
      expectedPath,
      `release_record.frozen_contracts.${key}.source_path`,
      failures,
    );
    if (!raw) {
      addFailure(failures, "CONTRACT_SOURCE_UNREADABLE", `release_record.frozen_contracts.${key}.source_path could not be read.`);
      continue;
    }
    if (!sha256Pattern.test(String(binding.source_sha256 || "")) || sha256(raw) !== binding.source_sha256.toLowerCase()) {
      addFailure(failures, "CONTRACT_SOURCE_DIGEST_MISMATCH", `release_record.frozen_contracts.${key} does not match its canonical source SHA-256.`);
    }
    if (!raw.toString("utf8").includes(expectedContractVersions[key])) {
      addFailure(failures, "CONTRACT_VERSION_SOURCE", `release_record.frozen_contracts.${key}.version is not present in its canonical source file.`);
    }
  }
}

function requireReceiptValue(receipt, key, expected, receiptPath, failures) {
  if (receipt?.[key] !== expected) {
    addFailure(failures, "CANONICAL_RECEIPT_MODE", `${receiptPath}.${key} must report the required canonical value.`);
  }
}

function requireReceiptIdentifier(receipt, key, receiptPath, failures, pattern = identifierPattern) {
  requireIdentifier(receipt?.[key], `${receiptPath}.${key}`, failures, pattern);
}

function validatePreparationReceipt(receipt, failures) {
  if (!receipt) return;
  const base = "canonical_preparation_receipt";
  if (!checkObject(receipt, base, [
    "schema_version",
    "status",
    "canonical",
    "prepared_at",
    "preparation_script_sha256",
    "case_id",
    "workflow_epoch",
    "case_version",
    "case_state",
    "fixture_version",
    "analyst_mode",
    "inventory_mode",
    "inventory_gateway_ready",
    "model_name",
    "prompt_version",
    "output_schema_version",
    "policy_version",
    "app_environment",
    "demo_mutation_auth_required",
    "admin_reset_auth_required",
    "staff_read_auth_required",
    "task_header_required",
    "task_oidc_required",
    "runtime_roles_authenticated",
    "staff_actor_id",
    "supervisor_actor_id",
    "inventory_legacy_health_compatibility",
    "repository",
    "evidence_store",
    "tasks_mode",
    "relay_mode",
    "evidence",
    "simulator_disclosure",
    "simulator_environment",
    "reset_event_count",
  ], failures)) return;
  for (const [key, expected] of Object.entries({
    schema_version: "2",
    status: "PREPARED_FOR_ANALYSIS",
    canonical: true,
    case_state: "RECEIVED",
    fixture_version: "camera-pouch-v1",
    analyst_mode: "vertex_adk",
    inventory_mode: "http",
    inventory_gateway_ready: true,
    model_name: "gemini-3.5-flash",
    app_environment: "production",
    demo_mutation_auth_required: true,
    admin_reset_auth_required: true,
    staff_read_auth_required: true,
    task_header_required: true,
    task_oidc_required: true,
    runtime_roles_authenticated: true,
    inventory_legacy_health_compatibility: false,
    repository: "firestore",
    evidence_store: "gcs",
    tasks_mode: "cloud",
    relay_mode: "http",
    simulator_disclosure: "SIMULATED",
    simulator_environment: "production",
    reset_event_count: 1,
  })) requireReceiptValue(receipt, key, expected, base, failures);

  for (const key of ["case_id", "workflow_epoch", "fixture_version", "staff_actor_id", "supervisor_actor_id", "prompt_version", "output_schema_version", "policy_version"]) {
    requireReceiptIdentifier(receipt, key, base, failures);
  }
  requireUtcInstant(receipt.prepared_at, `${base}.prepared_at`, failures);
  if (!Number.isInteger(receipt.case_version) || receipt.case_version < 1) {
    addFailure(failures, "CANONICAL_PREPARATION", `${base}.case_version must be a positive integer.`);
  }
  requireSha256(receipt.preparation_script_sha256, `${base}.preparation_script_sha256`, failures);
  if (receipt.staff_actor_id === receipt.supervisor_actor_id) {
    addFailure(failures, "CANONICAL_RECEIPT_ACTORS", `${base} must contain distinct configured staff and supervisor actor IDs.`);
  }
  if (!isPlainObject(receipt.evidence)) {
    addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence must be an object.`);
    return;
  }
  checkObject(receipt.evidence, `${base}.evidence`, [
    "source_file",
    "original_id",
    "original_sha256",
    "original_generation",
    "preview_id",
    "preview_sha256",
    "preview_generation",
    "preview_visibility",
    "active_pair_ids",
    "current_epoch_record_count",
    "active_for_analysis",
    "exact_retry_same_pair",
    "changed_consent_conflict_verified",
    "changed_consent_conflict_code",
  ], failures);
  for (const key of ["original_id", "preview_id"]) requireReceiptIdentifier(receipt.evidence, key, `${base}.evidence`, failures);
  if (receipt.evidence.source_file !== "pouch-front.jpg") {
    addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence.source_file must identify the frozen pouch-front fixture.`);
  }
  for (const key of ["original_sha256", "preview_sha256"]) requireSha256(receipt.evidence[key], `${base}.evidence.${key}`, failures);
  if (!Number.isInteger(receipt.evidence.original_generation) || receipt.evidence.original_generation < 1) addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence.original_generation must be a positive generation.`);
  if (!Number.isInteger(receipt.evidence.preview_generation) || receipt.evidence.preview_generation < 1) addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence.preview_generation must be a positive generation.`);
  if (receipt.evidence.preview_visibility !== "MODEL_AUTHORIZED" || receipt.evidence.active_for_analysis !== true || receipt.evidence.current_epoch_record_count !== 2) {
    addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence must prove one active current-epoch original/preview pair authorized for analysis.`);
  }
  const active = receipt.evidence.active_pair_ids;
  if (!Array.isArray(active) || active.length !== 2 || !active.includes(receipt.evidence.original_id) || !active.includes(receipt.evidence.preview_id)) {
    addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence.active_pair_ids must contain exactly the current original and preview IDs.`);
  }
  if (
    receipt.evidence.exact_retry_same_pair !== true
    || receipt.evidence.changed_consent_conflict_verified !== true
    || receipt.evidence.changed_consent_conflict_code !== "evidence_idempotency_conflict"
  ) {
    addFailure(failures, "CANONICAL_EVIDENCE", `${base}.evidence must prove exact retry replay and changed-command conflict behavior.`);
  }
}

function validateRunReceipt(receipt, binding, releaseRecord, preparationReceipt, frozenFileBindings, failures) {
  if (!receipt) return;
  const base = `canonical_run_receipt[${binding?.ordinal ?? "unknown"}]`;
  if (!checkObject(receipt, base, [
    "schema_version",
    "kind",
    "status",
    "canonical",
    "run_id",
    "ordinal",
    "started_at_utc",
    "ended_at_utc",
    "submitted_commit",
    "tree_sha",
    "preparation_receipt_sha256",
    "project_id",
    "hosted_url",
    "case_id",
    "workflow_epoch",
    "fixture_version",
    "fixture_sha256",
    "app_origin",
    "simulator_origin",
    "app_revision",
    "simulator_revision",
    "model_name",
    "prompt_version",
    "output_schema_version",
    "policy_version",
    "production",
    "live_agent",
    "cloud_boundary",
    "closure",
    "outcomes",
    "privacy",
    "frontend_manifest_sha256",
    "clean_browser_verified",
  ], failures)) return;

  for (const [key, expected] of Object.entries({
    schema_version: "2",
    kind: "found-roll-canonical-run",
    status: "CANONICAL_PASS",
    canonical: true,
    clean_browser_verified: true,
  })) requireReceiptValue(receipt, key, expected, base, failures);

  for (const key of ["run_id", "case_id", "workflow_epoch", "fixture_version", "app_revision", "simulator_revision", "model_name", "prompt_version", "output_schema_version", "policy_version"]) {
    requireReceiptIdentifier(receipt, key, base, failures);
  }
  requireIdentifier(receipt.project_id, `${base}.project_id`, failures, projectIdPattern);
  requireIdentifier(receipt.submitted_commit, `${base}.submitted_commit`, failures, commitPattern);
  requireIdentifier(receipt.tree_sha, `${base}.tree_sha`, failures, commitPattern);
  for (const key of ["preparation_receipt_sha256", "fixture_sha256", "frontend_manifest_sha256"]) requireSha256(receipt[key], `${base}.${key}`, failures);
  const startedValid = requireUtcTimestamp(receipt.started_at_utc, `${base}.started_at_utc`, failures);
  const endedValid = requireUtcTimestamp(receipt.ended_at_utc, `${base}.ended_at_utc`, failures);
  if (startedValid && endedValid && Date.parse(receipt.ended_at_utc) <= Date.parse(receipt.started_at_utc)) {
    addFailure(failures, "CANONICAL_RUN_TIME", `${base}.ended_at_utc must follow started_at_utc.`);
  }
  const appOrigin = parseHttpsUrl(receipt.app_origin, `${base}.app_origin`, failures);
  const simulatorOrigin = parseHttpsUrl(receipt.simulator_origin, `${base}.simulator_origin`, failures);
  parseHttpsUrl(receipt.hosted_url, `${base}.hosted_url`, failures);
  if (appOrigin && simulatorOrigin && appOrigin.origin === simulatorOrigin.origin) {
    addFailure(failures, "CANONICAL_SERVICE_BOUNDARY", `${base} must bind distinct app and simulator HTTPS origins.`);
  }

  const lowercase = (value) => (typeof value === "string" ? value.toLowerCase() : null);
  const matches = [
    [receipt.run_id, binding?.run_id, "run_id"],
    [receipt.ordinal, binding?.ordinal, "ordinal"],
    [receipt.project_id, releaseRecord?.google_cloud?.project_id, "project_id"],
    [receipt.hosted_url, releaseRecord?.hosted_project?.url, "hosted_url"],
    [lowercase(receipt.submitted_commit), lowercase(releaseRecord?.repository?.commit_sha), "submitted_commit"],
    [lowercase(receipt.tree_sha), lowercase(releaseRecord?.repository?.tree_sha), "tree_sha"],
    [lowercase(receipt.preparation_receipt_sha256), lowercase(binding?.preparation_sha256), "preparation_receipt_sha256"],
    [receipt.case_id, preparationReceipt?.case_id, "case_id"],
    [receipt.workflow_epoch, preparationReceipt?.workflow_epoch, "workflow_epoch"],
    [receipt.fixture_version, preparationReceipt?.fixture_version, "fixture_version"],
    [lowercase(receipt.fixture_sha256), lowercase(frozenFileBindings?.get("evaluation/fixtures.json")?.sha256), "fixture_sha256"],
    [lowercase(receipt.frontend_manifest_sha256), lowercase(frozenFileBindings?.get("artifacts/verification/frontend-build-manifest.json")?.sha256), "frontend_manifest_sha256"],
    [receipt.model_name, preparationReceipt?.model_name, "model_name"],
    [receipt.prompt_version, releaseRecord?.frozen_contracts?.prompt?.version, "prompt_version"],
    [receipt.output_schema_version, releaseRecord?.frozen_contracts?.output_schema?.version, "output_schema_version"],
    [receipt.policy_version, releaseRecord?.frozen_contracts?.policy?.version, "policy_version"],
    [receipt.app_origin, releaseRecord?.google_cloud?.canonical_revision_images?.app?.origin, "app_origin"],
    [receipt.simulator_origin, releaseRecord?.google_cloud?.canonical_revision_images?.simulator?.origin, "simulator_origin"],
    [receipt.app_revision, releaseRecord?.google_cloud?.canonical_revision_images?.app?.revision, "app_revision"],
    [receipt.simulator_revision, releaseRecord?.google_cloud?.canonical_revision_images?.simulator?.revision, "simulator_revision"],
  ];
  for (const [actual, expected, key] of matches) {
    if (expected === undefined || expected === null || actual !== expected) {
      addFailure(failures, "RECEIPT_BINDING", `${base}.${key} must match its release, preparation, or frozen-file binding.`);
    }
  }

  if (checkObject(receipt.production, `${base}.production`, [
    "app_environment",
    "analyst_mode",
    "inventory_mode",
    "inventory_gateway_ready",
    "inventory_legacy_health_compatibility",
    "repository",
    "evidence_store",
    "tasks_mode",
    "relay_mode",
    "simulator_environment",
    "demo_mutation_auth_required",
    "admin_reset_auth_required",
    "staff_read_auth_required",
    "task_header_required",
    "task_oidc_required",
  ], failures)) {
    for (const [key, expected] of Object.entries({
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
    })) requireReceiptValue(receipt.production, key, expected, `${base}.production`, failures);
  }

  if (checkObject(receipt.live_agent, `${base}.live_agent`, ["model_run_id", "trace_id", "invocation_count", "tool_trajectory", "typed_output_valid"], failures)) {
    requireReceiptIdentifier(receipt.live_agent, "model_run_id", `${base}.live_agent`, failures);
    requireReceiptIdentifier(receipt.live_agent, "trace_id", `${base}.live_agent`, failures);
    if (!Number.isInteger(receipt.live_agent.invocation_count) || receipt.live_agent.invocation_count < 1 || receipt.live_agent.invocation_count > liveAgentInvocationCap) {
      addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${base}.live_agent.invocation_count must be between 1 and the frozen cap of ${liveAgentInvocationCap}.`);
    }
    requireTrue(receipt.live_agent.typed_output_valid, `${base}.live_agent.typed_output_valid`, failures);
    if (!Array.isArray(receipt.live_agent.tool_trajectory) || receipt.live_agent.tool_trajectory.length < 4 || receipt.live_agent.tool_trajectory.length > 12) {
      addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${base}.live_agent.tool_trajectory must contain 4 through 12 bounded tool outcomes.`);
    } else {
      const observedTools = new Set();
      const successfulTools = new Set();
      receipt.live_agent.tool_trajectory.forEach((entry, index) => {
        const fieldPath = `${base}.live_agent.tool_trajectory[${index}]`;
        if (checkObject(entry, fieldPath, ["name", "outcome"], failures)) {
          if (!allowedAgentTools.has(entry.name)) addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${fieldPath}.name is outside the bounded tool set.`);
          if (!allowedToolOutcomes.has(entry.outcome)) addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${fieldPath}.outcome is not a supported sanitized outcome.`);
          observedTools.add(entry.name);
          if (entry.outcome === "success") successfulTools.add(entry.name);
        }
      });
      for (const requiredTool of ["search_custodian", "load_candidate", "submit_observations", "propose_discriminator"]) {
        if (!observedTools.has(requiredTool)) addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${base}.live_agent.tool_trajectory is missing a required bounded tool.`);
        else if (!successfulTools.has(requiredTool)) addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${base}.live_agent.tool_trajectory must record a successful sanitized outcome for every required tool.`);
      }
    }
  }

  if (checkObject(receipt.cloud_boundary, `${base}.cloud_boundary`, [
    "firestore_namespace",
    "firestore_transaction_contention_verified",
    "evidence_bucket",
    "evidence_generations_verified",
    "task_name",
    "task_oidc_verified",
    "task_delivery_attempts",
    "task_duplicate_side_effect_delta",
    "production_payload_omitted",
    "simulator_request_id",
    "reservation_id",
    "attestation_id",
    "simulator_https_verified",
    "simulator_api_auth_verified",
    "callback_signature_verified",
    "simulator_etag",
    "callback_replay_outcome",
    "callback_replay_side_effect_delta",
  ], failures)) {
    for (const key of ["firestore_namespace", "evidence_bucket", "task_name", "simulator_request_id", "reservation_id", "attestation_id", "callback_replay_outcome"]) {
      requireReceiptIdentifier(receipt.cloud_boundary, key, `${base}.cloud_boundary`, failures);
    }
    requireIdentifier(
      receipt.cloud_boundary.simulator_etag,
      `${base}.cloud_boundary.simulator_etag`,
      failures,
      weakSimulatorEtagPattern,
    );
    for (const key of ["firestore_transaction_contention_verified", "evidence_generations_verified", "task_oidc_verified", "production_payload_omitted", "simulator_https_verified", "simulator_api_auth_verified", "callback_signature_verified"]) {
      requireTrue(receipt.cloud_boundary[key], `${base}.cloud_boundary.${key}`, failures);
    }
    if (receipt.cloud_boundary.evidence_bucket !== releaseRecord?.google_cloud?.evidence_bucket) {
      addFailure(failures, "RECEIPT_BINDING", `${base}.cloud_boundary.evidence_bucket must match the exact dedicated-project evidence bucket.`);
    }
    if (!Number.isInteger(receipt.cloud_boundary.task_delivery_attempts) || receipt.cloud_boundary.task_delivery_attempts < 2) {
      addFailure(failures, "CLOUD_DUPLICATE_PROOF", `${base}.cloud_boundary.task_delivery_attempts must include a deliberate duplicate delivery.`);
    }
    if (receipt.cloud_boundary.task_duplicate_side_effect_delta !== 0 || receipt.cloud_boundary.callback_replay_side_effect_delta !== 0) {
      addFailure(failures, "CLOUD_DUPLICATE_PROOF", `${base}.cloud_boundary must prove zero task and callback replay side-effect delta.`);
    }
    if (receipt.cloud_boundary.callback_replay_outcome !== "duplicate-noop") {
      addFailure(failures, "CLOUD_DUPLICATE_PROOF", `${base}.cloud_boundary.callback_replay_outcome must be duplicate-noop.`);
    }
  }

  if (checkObject(receipt.closure, `${base}.closure`, [
    "final_state",
    "final_version",
    "event_count",
    "manifest_id",
    "manifest_sha256",
    "first_event_hash",
    "final_event_hash",
    "hash_chain_valid",
    "manifest_internally_consistent",
    "reservation_count",
    "release_count",
    "closure_count",
    "physical_transfer_proven",
    "manual_datastore_repair",
  ], failures)) {
    for (const [key, expected] of Object.entries({
      final_state: "CLOSED",
      hash_chain_valid: true,
      manifest_internally_consistent: true,
      reservation_count: 1,
      release_count: 1,
      closure_count: 1,
      physical_transfer_proven: false,
      manual_datastore_repair: false,
    })) requireReceiptValue(receipt.closure, key, expected, `${base}.closure`, failures);
    requireReceiptIdentifier(receipt.closure, "manifest_id", `${base}.closure`, failures);
    for (const key of ["manifest_sha256", "first_event_hash", "final_event_hash"]) requireSha256(receipt.closure[key], `${base}.closure.${key}`, failures);
    if (receipt.closure.final_version !== 19 || receipt.closure.event_count !== 19) {
      addFailure(failures, "CANONICAL_CLOSURE", `${base}.closure must contain the exact frozen 19-version, 19-event demo closure.`);
    }
  }

  if (checkObject(receipt.outcomes, `${base}.outcomes`, ["failures", "retries", "exclusions"], failures)) {
    for (const key of ["failures", "retries", "exclusions"]) {
      if (!Array.isArray(receipt.outcomes[key])) {
        addFailure(failures, "CANONICAL_OUTCOMES", `${base}.outcomes.${key} must be an explicit array.`);
      } else {
        receipt.outcomes[key].forEach((value, index) => requireIdentifier(value, `${base}.outcomes.${key}[${index}]`, failures));
      }
    }
    if (Array.isArray(receipt.outcomes.failures) && receipt.outcomes.failures.length !== 0) {
      addFailure(failures, "CANONICAL_FAILURES", `${base}.outcomes.failures must be empty for CANONICAL_PASS.`);
    }
    if (
      Array.isArray(receipt.outcomes.retries)
      && (!receipt.outcomes.retries.includes("deliberate-task-duplicate") || !receipt.outcomes.retries.includes("deliberate-callback-replay"))
    ) {
      addFailure(failures, "CANONICAL_OUTCOMES", `${base}.outcomes.retries must record both deliberate duplicate-delivery proofs.`);
    }
    if (
      Array.isArray(receipt.outcomes.exclusions)
      && (receipt.outcomes.exclusions.length !== 1 || receipt.outcomes.exclusions[0] !== "physical-transfer-proof")
    ) {
      addFailure(failures, "CANONICAL_OUTCOMES", `${base}.outcomes.exclusions must preserve the physical-transfer-proof limitation.`);
    }
  }

  if (checkObject(receipt.privacy, `${base}.privacy`, ["receipt_sha256", "unresolved_findings", "binary_media_review_confirmed"], failures)) {
    requireSha256(receipt.privacy.receipt_sha256, `${base}.privacy.receipt_sha256`, failures);
    if (lowercase(receipt.privacy.receipt_sha256) !== lowercase(releaseRecord?.receipts?.canonical_privacy_sha256)) {
      addFailure(failures, "RECEIPT_BINDING", `${base}.privacy.receipt_sha256 must match the canonical privacy receipt binding.`);
    }
    if (receipt.privacy.unresolved_findings !== 0) addFailure(failures, "CANONICAL_PRIVACY", `${base}.privacy.unresolved_findings must be zero.`);
    requireTrue(receipt.privacy.binary_media_review_confirmed, `${base}.privacy.binary_media_review_confirmed`, failures);
  }
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
  }
  return value;
}

function canonicalJsonBuffer(value) {
  const serialized = JSON.stringify(stableJsonValue(value));
  if (!serialized || /[^\x00-\x7f]/u.test(serialized)) throw new Error("canonical audit content must be ASCII");
  return Buffer.from(serialized, "utf8");
}

function eventUnsignedForHash(event) {
  const unsigned = { ...event };
  delete unsigned.event_hash;
  if (typeof unsigned.occurred_at === "string" && unsigned.occurred_at.endsWith("Z")) {
    unsigned.occurred_at = `${unsigned.occurred_at.slice(0, -1)}+00:00`;
  }
  return unsigned;
}

function validateChainAudit(audit, binding, runReceipt, preparationReceipt, releaseRecord, failures) {
  if (!audit) return;
  const ordinal = binding?.ordinal ?? "unknown";
  const base = `canonical_chain_audit[${ordinal}]`;
  if (!checkObject(audit, base, [
    "schema_version",
    "kind",
    "status",
    "run_id",
    "case_id",
    "workflow_epoch",
    "submitted_commit",
    "tree_sha",
    "manifest",
    "events",
  ], failures)) return;
  for (const [key, expected] of Object.entries({
    schema_version: "1",
    kind: "found-roll-chain-audit",
    status: "PASS",
  })) requireReceiptValue(audit, key, expected, base, failures);
  for (const key of ["run_id", "case_id", "workflow_epoch"]) requireReceiptIdentifier(audit, key, base, failures);
  requireIdentifier(audit.submitted_commit, `${base}.submitted_commit`, failures, commitPattern);
  requireIdentifier(audit.tree_sha, `${base}.tree_sha`, failures, commitPattern);
  const lowercase = (value) => (typeof value === "string" ? value.toLowerCase() : null);
  for (const [actual, expected, key] of [
    [audit.run_id, binding?.run_id, "run_id"],
    [audit.run_id, runReceipt?.run_id, "run_id"],
    [audit.case_id, runReceipt?.case_id, "case_id"],
    [audit.case_id, preparationReceipt?.case_id, "case_id"],
    [audit.workflow_epoch, runReceipt?.workflow_epoch, "workflow_epoch"],
    [audit.workflow_epoch, preparationReceipt?.workflow_epoch, "workflow_epoch"],
    [lowercase(audit.submitted_commit), lowercase(releaseRecord?.repository?.commit_sha), "submitted_commit"],
    [lowercase(audit.tree_sha), lowercase(releaseRecord?.repository?.tree_sha), "tree_sha"],
  ]) {
    if (!expected || actual !== expected) addFailure(failures, "CHAIN_AUDIT_BINDING", `${base}.${key} must match the release and canonical-run binding.`);
  }

  if (!Array.isArray(audit.events) || audit.events.length !== expectedFrozenDemoTrajectory.length) {
    addFailure(failures, "CHAIN_AUDIT_EVENTS", `${base}.events must contain the exact 19-event frozen demo chain.`);
    return;
  }
  const eventKeys = [
    "id",
    "case_id",
    "sequence",
    "type",
    "actor",
    "from_state",
    "to_state",
    "reason",
    "evidence_refs",
    "tool",
    "task_id",
    "model_run_id",
    "simulator_attestation_id",
    "idempotency_key",
    "occurred_at",
    "previous_hash",
    "event_hash",
  ];
  const ids = new Set();
  const hashes = new Set();
  let previousHash = "0".repeat(64);
  let previousOccurredAt = Date.parse(runReceipt?.started_at_utc);
  const runEndedAt = Date.parse(runReceipt?.ended_at_utc);
  let hashesValid = true;
  let firstTrajectoryMismatch = null;
  for (let index = 0; index < audit.events.length; index += 1) {
    const event = audit.events[index];
    const fieldPath = `${base}.events[${index}]`;
    if (!checkObject(event, fieldPath, eventKeys, failures)) {
      hashesValid = false;
      continue;
    }
    for (const key of ["id", "case_id", "type", "actor", "idempotency_key"]) requireReceiptIdentifier(event, key, fieldPath, failures);
    if (event.case_id !== audit.case_id || event.sequence !== index + 1) {
      addFailure(failures, "CHAIN_AUDIT_SEQUENCE", `${fieldPath} must preserve the canonical case ID and contiguous sequence.`);
    }
    if (!allowedCustodyStates.has(event.from_state) || !allowedCustodyStates.has(event.to_state)) {
      addFailure(failures, "CHAIN_AUDIT_STATE", `${fieldPath} contains an unsupported custody state.`);
    }
    const [expectedType, expectedFromState, expectedToState] = expectedFrozenDemoTrajectory[index];
    if (
      firstTrajectoryMismatch === null
      && (
        event.type !== expectedType
        || event.from_state !== expectedFromState
        || event.to_state !== expectedToState
      )
    ) {
      firstTrajectoryMismatch = index + 1;
    }
    if (typeof event.reason !== "string" || !event.reason.trim() || event.reason.length > 1_000) {
      addFailure(failures, "CHAIN_AUDIT_EVENT", `${fieldPath}.reason must be a bounded non-empty disclosure.`);
    }
    if (!Array.isArray(event.evidence_refs) || event.evidence_refs.length > 12 || event.evidence_refs.some((value) => typeof value !== "string" || !value || value.length > 512)) {
      addFailure(failures, "CHAIN_AUDIT_EVENT", `${fieldPath}.evidence_refs must be a bounded string array.`);
    }
    for (const key of ["tool", "task_id", "model_run_id", "simulator_attestation_id"]) {
      if (event[key] !== null) requireIdentifier(event[key], `${fieldPath}.${key}`, failures);
    }
    requireUtcInstant(event.occurred_at, `${fieldPath}.occurred_at`, failures);
    const occurredAt = Date.parse(event.occurred_at);
    if (!Number.isFinite(occurredAt) || !Number.isFinite(previousOccurredAt) || !Number.isFinite(runEndedAt) || occurredAt <= previousOccurredAt || occurredAt >= runEndedAt) {
      addFailure(failures, "CHAIN_AUDIT_TIME", `${fieldPath}.occurred_at must be strictly ordered inside the canonical run interval.`);
    }
    previousOccurredAt = occurredAt;
    requireSha256(event.previous_hash, `${fieldPath}.previous_hash`, failures);
    requireSha256(event.event_hash, `${fieldPath}.event_hash`, failures);
    if (event.previous_hash !== previousHash || ids.has(event.id) || hashes.has(event.event_hash)) {
      hashesValid = false;
      addFailure(failures, "CHAIN_AUDIT_LINK", `${fieldPath} must have a unique ID/hash and link to the preceding event.`);
    }
    ids.add(event.id);
    hashes.add(event.event_hash);
    try {
      const recomputed = sha256(canonicalJsonBuffer(eventUnsignedForHash(event)));
      if (recomputed !== event.event_hash) {
        hashesValid = false;
        addFailure(failures, "CHAIN_AUDIT_HASH", `${fieldPath}.event_hash does not match the canonical event bytes.`);
      }
    } catch {
      hashesValid = false;
      addFailure(failures, "CHAIN_AUDIT_HASH", `${fieldPath} cannot be represented by the frozen canonical hashing contract.`);
    }
    previousHash = event.event_hash;
  }
  if (firstTrajectoryMismatch !== null) {
    addFailure(
      failures,
      "CHAIN_AUDIT_TRAJECTORY",
      `${base}.events must match the exact frozen service trajectory; the first mismatch is event ${firstTrajectoryMismatch}.`,
    );
  }

  const manifest = audit.manifest;
  const disclosure = "This application-enforced manifest checks service event consistency. It does not prove physical possession or a real-world transfer.";
  const manifestKeys = [
    "schema_version",
    "manifest_id",
    "case_id",
    "final_state",
    "final_version",
    "event_count",
    "first_event_hash",
    "final_event_hash",
    "event_ids",
    "evidence_digests",
    "internally_consistent",
    "physical_transfer_proven",
    "disclosure",
  ];
  if (!checkObject(manifest, `${base}.manifest`, manifestKeys, failures)) return;
  const evidenceRefs = [...new Set(audit.events.flatMap((event) => Array.isArray(event.evidence_refs) ? event.evidence_refs : []))].sort();
  let evidenceDigests = [];
  let expectedManifestId = null;
  let manifestDigest = null;
  try {
    evidenceDigests = evidenceRefs.map((evidenceRef) => sha256(canonicalJsonBuffer({ evidence_ref: evidenceRef })));
    const manifestBody = {
      case_id: audit.case_id,
      final_version: 19,
      event_hashes: audit.events.map((event) => event.event_hash),
      evidence_digests: evidenceDigests,
    };
    expectedManifestId = `manifest-${sha256(canonicalJsonBuffer(manifestBody)).slice(0, 24)}`;
    manifestDigest = sha256(canonicalJsonBuffer(manifest));
  } catch {
    addFailure(failures, "CHAIN_AUDIT_MANIFEST", `${base}.manifest cannot be represented by the frozen canonical hashing contract.`);
  }
  const expectedEventIds = audit.events.map((event) => event.id);
  const exactManifest = (
    manifest.schema_version === "1"
    && manifest.manifest_id === expectedManifestId
    && manifest.case_id === audit.case_id
    && manifest.final_state === "CLOSED"
    && manifest.final_version === 19
    && manifest.event_count === 19
    && manifest.first_event_hash === audit.events[0]?.event_hash
    && manifest.final_event_hash === audit.events[18]?.event_hash
    && Array.isArray(manifest.event_ids)
    && manifest.event_ids.length === 19
    && manifest.event_ids.every((value, index) => value === expectedEventIds[index])
    && Array.isArray(manifest.evidence_digests)
    && manifest.evidence_digests.length === evidenceDigests.length
    && manifest.evidence_digests.every((value, index) => value === evidenceDigests[index])
    && manifest.internally_consistent === true
    && manifest.physical_transfer_proven === false
    && manifest.disclosure === disclosure
  );
  if (!exactManifest || !hashesValid) {
    addFailure(failures, "CHAIN_AUDIT_MANIFEST", `${base}.manifest must be recomputable from the exact linked event chain.`);
  }

  const actorBindings = [
    [audit.events[8]?.actor, preparationReceipt?.staff_actor_id],
    [audit.events[10]?.actor, preparationReceipt?.supervisor_actor_id],
    [audit.events[12]?.actor, "simulator:relay-post"],
    [audit.events[14]?.actor, "simulator:custodian-scanner"],
    [audit.events[15]?.actor, "simulator:claimant-scanner"],
    [audit.events[16]?.actor, preparationReceipt?.staff_actor_id],
    [audit.events[17]?.actor, "simulator:relay-post"],
  ];
  if (actorBindings.some(([actual, expected]) => !expected || actual !== expected)) {
    addFailure(failures, "CHAIN_AUDIT_TRAJECTORY", `${base} must preserve the frozen staff, supervisor, and simulated relay actor boundaries.`);
  }
  const modelRunId = runReceipt?.live_agent?.model_run_id;
  if (!modelRunId || audit.events[3]?.model_run_id !== modelRunId || audit.events[4]?.model_run_id !== modelRunId) {
    addFailure(failures, "CHAIN_AUDIT_TRAJECTORY", `${base} must bind the live Gemini model run to the proposal and private-evidence request events.`);
  }
  const releaseTaskName = runReceipt?.cloud_boundary?.task_name;
  if (!releaseTaskName || audit.events[16]?.task_id !== releaseTaskName || audit.events[17]?.task_id !== releaseTaskName) {
    addFailure(failures, "CHAIN_AUDIT_TRAJECTORY", `${base} must bind the recorded completed-release Cloud Task to its request and attestation events.`);
  }
  if (audit.events[17]?.simulator_attestation_id !== runReceipt?.cloud_boundary?.attestation_id) {
    addFailure(failures, "CHAIN_AUDIT_TRAJECTORY", `${base} must bind the recorded simulator attestation to the release event.`);
  }
  const expectedEvidenceRefs = [
    `evidence://${preparationReceipt?.evidence?.original_id}?sha256=${preparationReceipt?.evidence?.original_sha256}`,
    `evidence://${preparationReceipt?.evidence?.preview_id}?sha256=${preparationReceipt?.evidence?.preview_sha256}`,
  ];
  for (const expectedEvidenceRef of expectedEvidenceRefs) {
    if (!evidenceRefs.includes(expectedEvidenceRef)) {
      addFailure(failures, "CHAIN_AUDIT_TRAJECTORY", `${base} must bind the exact prepared original and model-authorized preview evidence references.`);
      break;
    }
  }
  const closure = runReceipt?.closure;
  for (const [actual, expected, key] of [
    [closure?.final_version, 19, "final_version"],
    [closure?.event_count, 19, "event_count"],
    [closure?.manifest_id, manifest.manifest_id, "manifest_id"],
    [lowercase(closure?.manifest_sha256), lowercase(manifestDigest), "manifest_sha256"],
    [lowercase(closure?.first_event_hash), lowercase(manifest.first_event_hash), "first_event_hash"],
    [lowercase(closure?.final_event_hash), lowercase(manifest.final_event_hash), "final_event_hash"],
  ]) {
    if (actual !== expected) addFailure(failures, "CHAIN_AUDIT_BINDING", `${base}.${key} must match the canonical run closure.`);
  }
}

function validateCanonicalPrivacyReceipt(receipt, runBindings, releaseRecord, failures) {
  if (!receipt) return;
  const base = "canonical_privacy_receipt";
  if (!checkObject(receipt, base, [
    "schema_version",
    "kind",
    "status",
    "submitted_commit",
    "run_ids",
    "unresolved_findings",
    "binary_media_review_confirmed",
    "raw_sensitive_content_included",
    "log_trace_ranges_covered",
  ], failures)) return;
  for (const [key, expected] of Object.entries({
    schema_version: "1",
    kind: "found-roll-canonical-privacy",
    status: "PASS",
    unresolved_findings: 0,
    binary_media_review_confirmed: true,
    raw_sensitive_content_included: false,
    log_trace_ranges_covered: true,
  })) requireReceiptValue(receipt, key, expected, base, failures);
  requireIdentifier(receipt.submitted_commit, `${base}.submitted_commit`, failures, commitPattern);
  const releaseCommit = releaseRecord?.repository?.commit_sha;
  if (typeof receipt.submitted_commit !== "string" || typeof releaseCommit !== "string" || receipt.submitted_commit.toLowerCase() !== releaseCommit.toLowerCase()) {
    addFailure(failures, "RECEIPT_BINDING", `${base}.submitted_commit must match the release commit.`);
  }
  if (!Array.isArray(receipt.run_ids) || receipt.run_ids.length !== 5) {
    addFailure(failures, "CANONICAL_PRIVACY", `${base}.run_ids must be an array of exactly five identifiers.`);
  } else {
    receipt.run_ids.forEach((runId, index) => requireIdentifier(runId, `${base}.run_ids[${index}]`, failures));
  }
  const expectedRunIds = new Set((runBindings || []).map((binding) => binding.run_id));
  const actualRunIds = new Set(Array.isArray(receipt.run_ids) ? receipt.run_ids : []);
  if (actualRunIds.size !== 5 || expectedRunIds.size !== 5 || [...expectedRunIds].some((runId) => !actualRunIds.has(runId))) {
    addFailure(failures, "CANONICAL_PRIVACY", `${base}.run_ids must cover the exact five canonical runs.`);
  }
}

function validateCleanBrowserReceipt(receipt, runReceipts, releaseRecord, failures, nowMilliseconds = Date.now()) {
  if (!receipt) return;
  const base = "clean_browser_receipt";
  if (!checkObject(receipt, base, [
    "schema_version",
    "kind",
    "status",
    "verified_at_utc",
    "submitted_commit",
    "hosted_url",
    "app_revision",
    "simulator_revision",
    "frontend_manifest_sha256",
    "judge_access_verified",
    "current_rendered_design_verified",
  ], failures)) return;
  for (const [key, expected] of Object.entries({
    schema_version: "1",
    kind: "found-roll-clean-browser",
    status: "PASS",
    judge_access_verified: true,
    current_rendered_design_verified: true,
  })) requireReceiptValue(receipt, key, expected, base, failures);
  const verifiedValid = requireUtcTimestamp(receipt.verified_at_utc, `${base}.verified_at_utc`, failures);
  requireIdentifier(receipt.submitted_commit, `${base}.submitted_commit`, failures, commitPattern);
  requireReceiptIdentifier(receipt, "app_revision", base, failures);
  requireReceiptIdentifier(receipt, "simulator_revision", base, failures);
  requireSha256(receipt.frontend_manifest_sha256, `${base}.frontend_manifest_sha256`, failures);
  parseHttpsUrl(receipt.hosted_url, `${base}.hosted_url`, failures);
  const referenceRun = (runReceipts || []).find(Boolean);
  const lowercase = (value) => (typeof value === "string" ? value.toLowerCase() : null);
  const matches = [
    [lowercase(receipt.submitted_commit), lowercase(releaseRecord?.repository?.commit_sha), "submitted_commit"],
    [receipt.hosted_url, releaseRecord?.hosted_project?.url, "hosted_url"],
    [receipt.app_revision, referenceRun?.app_revision, "app_revision"],
    [receipt.simulator_revision, referenceRun?.simulator_revision, "simulator_revision"],
    [lowercase(receipt.frontend_manifest_sha256), lowercase(referenceRun?.frontend_manifest_sha256), "frontend_manifest_sha256"],
    [lowercase(receipt.frontend_manifest_sha256), lowercase(releaseRecord?.frontend_artifact?.sha256), "frontend_manifest_sha256"],
  ];
  for (const [actual, expected, key] of matches) {
    if (!expected || actual !== expected) addFailure(failures, "RECEIPT_BINDING", `${base}.${key} must match the frozen release and canonical revision.`);
  }
  const releaseValid = requireUtcTimestamp(releaseRecord?.created_at_utc, "release_record.created_at_utc", failures);
  const endedTimes = (runReceipts || []).map((runReceipt) => Date.parse(runReceipt?.ended_at_utc));
  if (!verifiedValid || !releaseValid) return;
  if (endedTimes.length !== 5 || endedTimes.some((endedTime) => !Number.isFinite(endedTime))) {
    addFailure(failures, "CLEAN_BROWSER_FRESHNESS", `${base}.verified_at_utc requires all five canonical run completion times.`);
    return;
  }
  const verifiedTime = Date.parse(receipt.verified_at_utc);
  const releaseTime = Date.parse(releaseRecord.created_at_utc);
  const currentTime = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  if (verifiedTime <= Math.max(...endedTimes)) {
    addFailure(failures, "CLEAN_BROWSER_FRESHNESS", `${base}.verified_at_utc must follow completion of all five canonical runs.`);
  }
  if (verifiedTime >= releaseTime || releaseTime - verifiedTime > preflightFreshnessMilliseconds) {
    addFailure(failures, "CLEAN_BROWSER_FRESHNESS", `${base}.verified_at_utc must precede the release record by no more than 24 hours.`);
  }
  if (
    verifiedTime > currentTime + preflightFutureSkewMilliseconds
    || currentTime - verifiedTime > preflightFreshnessMilliseconds
  ) {
    addFailure(failures, "CLEAN_BROWSER_FRESHNESS", `${base}.verified_at_utc must be within 24 hours of the current wall clock and not more than five minutes in the future.`);
  }
}

function validateCanonicalRunSet(runBindings, preparationReceipts, runReceipts, releaseRecord, failures) {
  if (!Array.isArray(runBindings) || runBindings.length !== 5) return;
  const dimensions = [
    [runBindings.map((binding) => binding?.run_id), "run IDs"],
    [runBindings.map((binding) => binding?.ordinal), "ordinals"],
    [runBindings.map((binding) => binding?.preparation_path), "preparation paths"],
    [runBindings.map((binding) => binding?.preparation_sha256?.toLowerCase?.()), "preparation digests"],
    [runBindings.map((binding) => binding?.run_path), "run paths"],
    [runBindings.map((binding) => binding?.run_sha256?.toLowerCase?.()), "run digests"],
    [runBindings.map((binding) => binding?.chain_audit_path), "chain-audit paths"],
    [runBindings.map((binding) => binding?.chain_audit_sha256?.toLowerCase?.()), "chain-audit digests"],
    [preparationReceipts.map((receipt) => receipt?.workflow_epoch), "workflow epochs"],
    [preparationReceipts.map((receipt) => receipt?.evidence?.original_id), "original evidence IDs"],
    [preparationReceipts.map((receipt) => receipt?.evidence?.preview_id), "preview evidence IDs"],
    [runReceipts.map((receipt) => receipt?.live_agent?.model_run_id), "model run IDs"],
    [runReceipts.map((receipt) => receipt?.live_agent?.trace_id), "trace IDs"],
    [runReceipts.map((receipt) => receipt?.cloud_boundary?.task_name), "Cloud Task names"],
    [runReceipts.map((receipt) => receipt?.cloud_boundary?.simulator_request_id), "simulator request IDs"],
    [runReceipts.map((receipt) => receipt?.cloud_boundary?.reservation_id), "reservation IDs"],
    [runReceipts.map((receipt) => receipt?.cloud_boundary?.attestation_id), "attestation IDs"],
    [runReceipts.map((receipt) => receipt?.closure?.manifest_id), "manifest IDs"],
    [runReceipts.map((receipt) => receipt?.closure?.final_event_hash?.toLowerCase?.()), "final event hashes"],
  ];
  for (const [values, label] of dimensions) {
    if (values.some((value) => value === undefined || value === null || value === "") || new Set(values).size !== 5) {
      addFailure(failures, "CANONICAL_RUN_UNIQUENESS", `The five canonical ${label} must be present and unique.`);
    }
  }
  const ordinals = runBindings.map((binding) => binding?.ordinal).sort((left, right) => left - right);
  if (ordinals.join(",") !== "1,2,3,4,5") {
    addFailure(failures, "CANONICAL_RUN_ORDINAL", "The canonical run set must contain each ordinal from 1 through 5 exactly once.");
  }
  const chronological = runBindings
    .map((binding, index) => ({
      ordinal: binding?.ordinal,
      prepared: Date.parse(preparationReceipts[index]?.prepared_at),
      started: Date.parse(runReceipts[index]?.started_at_utc),
      ended: Date.parse(runReceipts[index]?.ended_at_utc),
    }))
    .sort((left, right) => left.ordinal - right.ordinal);
  let previousEnd = null;
  for (const item of chronological) {
    if (![item.prepared, item.started, item.ended].every(Number.isFinite) || !(item.started < item.prepared && item.prepared < item.ended)) {
      addFailure(failures, "CANONICAL_RUN_TIME", "Every canonical run must start before preparation and end after preparation.");
      break;
    }
    if (previousEnd !== null && item.started <= previousEnd) {
      addFailure(failures, "CANONICAL_RUN_TIME", "Canonical runs must be non-overlapping and chronologically ordered by ordinal.");
      break;
    }
    previousEnd = item.ended;
  }
  const referenceRun = runReceipts.find(Boolean);
  for (const receipt of runReceipts.filter(Boolean)) {
    if (referenceRun && (
      receipt.app_origin !== referenceRun.app_origin
      || receipt.simulator_origin !== referenceRun.simulator_origin
      || receipt.app_revision !== referenceRun.app_revision
      || receipt.simulator_revision !== referenceRun.simulator_revision
    )) {
      addFailure(failures, "CANONICAL_REVISION_DRIFT", "All five canonical runs must use the same frozen app and simulator origins and revisions.");
      break;
    }
  }
  const videoRunId = releaseRecord?.video?.canonical_run_id;
  if (!runBindings.some((binding) => binding?.run_id === videoRunId)) {
    addFailure(failures, "VIDEO_RUN_BINDING", "release_record.video.canonical_run_id must identify one of the exact five canonical runs.");
  }
  const releaseCreated = Date.parse(releaseRecord?.created_at_utc);
  const endedTimes = runReceipts.map((receipt) => Date.parse(receipt?.ended_at_utc)).filter(Number.isFinite);
  if (Number.isFinite(releaseCreated) && endedTimes.length === 5 && releaseCreated < Math.max(...endedTimes)) {
    addFailure(failures, "RELEASE_TIME_BINDING", "release_record.created_at_utc must not precede any canonical run completion.");
  }
}

async function listSubmissionMarkdown(repoRoot) {
  const files = [];
  const readme = path.join(repoRoot, "README.md");
  try {
    await readRegularFileWithin(repoRoot, readme, maxArtifactBytes);
    files.push(readme);
  } catch {
    // The missing README is reported by the placeholder scan caller.
  }
  const docsRoot = path.join(repoRoot, "docs");
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else {
        const relative = normalizeRelativePath(path.relative(repoRoot, target));
        // The checked JSON template must retain placeholders and false confirmations by design.
        if (relative !== SUBMISSION_TEMPLATE_PATH && entry.name.toLowerCase().endsWith(".md")) files.push(target);
      }
    }
  }
  await walk(docsRoot);
  return files;
}

async function scanSubmissionMarkdown(repoRoot, failures) {
  const files = await listSubmissionMarkdown(repoRoot);
  if (!files.some((file) => normalizeRelativePath(path.relative(repoRoot, file)) === "README.md")) {
    addFailure(failures, "SUBMISSION_MARKDOWN", "README.md is required for the submission placeholder scan.");
  }
  for (const file of files) {
    let content;
    try {
      content = (await readRegularFileWithin(repoRoot, file, maxArtifactBytes)).toString("utf8");
    } catch {
      addFailure(failures, "SUBMISSION_MARKDOWN", `${normalizeRelativePath(path.relative(repoRoot, file))} could not be scanned.`);
      continue;
    }
    const matchedLines = [];
    content.split(/\r?\n/).forEach((line, index) => {
      if (placeholderPatterns.some((pattern) => pattern.test(line))) matchedLines.push(index + 1);
    });
    if (matchedLines.length) {
      addFailure(
        failures,
        "SUBMISSION_PLACEHOLDER",
        `${normalizeRelativePath(path.relative(repoRoot, file))} contains unresolved submission placeholder markers on line(s) ${matchedLines.join(", ")}.`,
      );
    }
  }
}

function normalizeRepositoryLocation(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  const sshMatch = candidate.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch) candidate = `https://${sshMatch[1]}/${sshMatch[2]}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.search || url.hash || (url.username && url.username !== "git")) return null;
  const pathname = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
  return `${url.hostname.toLowerCase()}${pathname.toLowerCase()}`;
}

function validateGitState(releaseRecord, gitState, failures) {
  if (!gitState?.available) {
    addFailure(failures, "GIT_UNAVAILABLE", "The verifier could not inspect the local Git repository.");
    return;
  }
  const recordedCommit = releaseRecord?.repository?.commit_sha;
  const normalizedRecordedCommit = typeof recordedCommit === "string" ? recordedCommit.toLowerCase() : null;
  const normalizedHeadCommit = typeof gitState.headCommit === "string" ? gitState.headCommit.toLowerCase() : null;
  const normalizedTagCommit = typeof gitState.tagCommit === "string" ? gitState.tagCommit.toLowerCase() : null;
  const recordedTree = typeof releaseRecord?.repository?.tree_sha === "string" ? releaseRecord.repository.tree_sha.toLowerCase() : null;
  const normalizedHeadTree = typeof gitState.headTree === "string" ? gitState.headTree.toLowerCase() : null;
  const normalizedTagTree = typeof gitState.tagTree === "string" ? gitState.tagTree.toLowerCase() : null;
  if (!normalizedRecordedCommit || normalizedHeadCommit !== normalizedRecordedCommit) {
    addFailure(failures, "HEAD_MISMATCH", "The release record commit does not equal the repository HEAD commit.");
  }
  if (!normalizedRecordedCommit || normalizedTagCommit !== normalizedRecordedCommit) {
    addFailure(failures, "TAG_MISMATCH", "The configured release tag does not resolve to the recorded HEAD commit.");
  }
  if (!recordedTree || normalizedHeadTree !== recordedTree || normalizedTagTree !== recordedTree) {
    addFailure(failures, "TREE_MISMATCH", "The release record tree must equal both the HEAD tree and the tagged tree.");
  }
  const expectedRemote = normalizeRepositoryLocation(releaseRecord?.repository?.url);
  const fetchRemoteMatches = expectedRemote && (gitState.remoteUrls || []).some((value) => normalizeRepositoryLocation(value) === expectedRemote);
  const pushRemoteMatches = expectedRemote && (gitState.remotePushUrls || []).some((value) => normalizeRepositoryLocation(value) === expectedRemote);
  if (!fetchRemoteMatches || !pushRemoteMatches) addFailure(failures, "REMOTE_MISMATCH", "No secure configured Git fetch/push remote matches the release-record repository URL.");
  if (gitState.privateArtifactsSafe !== true) addFailure(failures, "PRIVATE_ARTIFACT_GIT_STATE", "Every private release record, receipt, and artifact must be ignored and absent from Git tracking.");
  if (gitState.clean !== true) addFailure(failures, "WORKTREE_DIRTY", "The Git worktree must be clean, including untracked files, at submission freeze.");
}

function validatePrivateArtifactGitState(gitState, failures) {
  if (!gitState?.available) {
    addFailure(failures, "GIT_UNAVAILABLE", "The preflight verifier could not inspect the local Git repository.");
    return;
  }
  if (gitState.privateArtifactsSafe !== true) {
    addFailure(failures, "PRIVATE_ARTIFACT_GIT_STATE", "The private preflight release record, receipts, and captures must be ignored and absent from Git tracking.");
  }
}

function gitArguments(repoRoot, args) {
  let canonicalRepoRoot = null;
  try {
    canonicalRepoRoot = realpathSync.native(repoRoot);
  } catch {
    return args;
  }
  const normalizeForComparison = (value) => (
    process.platform === "win32" ? value.toLowerCase() : value
  );
  if (normalizeForComparison(canonicalRepoRoot) !== normalizeForComparison(canonicalDefaultRepoRoot)) return args;
  const safeDirectory = canonicalDefaultRepoRoot.replaceAll("\\", "/");
  return ["-c", `safe.directory=${safeDirectory}`, ...args];
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", gitArguments(repoRoot, args), {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) return null;
  return result.stdout.trim();
}

function runGitStatus(repoRoot, args) {
  const result = spawnSync("git", gitArguments(repoRoot, args), {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return null;
  return result.status;
}

function collectPrivateArtifactBindings(repoRoot, recordPath, releaseRecord, loadedPreflightReceipts = {}) {
  const values = [];
  if (recordPath) values.push(normalizeRelativePath(path.relative(repoRoot, path.resolve(recordPath))));
  const receipts = releaseRecord?.receipts;
  if (isPlainObject(receipts)) {
    values.push(receipts.canonical_privacy_path, receipts.clean_browser_path);
    if (Array.isArray(receipts.canonical_runs)) {
      for (const binding of receipts.canonical_runs.slice(0, 5)) {
        values.push(binding?.preparation_path, binding?.run_path, binding?.chain_audit_path);
      }
    }
  }
  const preflightReceipts = releaseRecord?.google_cloud?.preflight_receipts;
  if (isPlainObject(preflightReceipts)) {
    for (const key of ["billing_overview", "cloud_run_spend_cap", "agent_platform_spend_cap"]) {
      values.push(preflightReceipts[key]?.path);
    }
  }
  const projectStorageReceipts = releaseRecord?.google_cloud?.project_storage_receipts;
  if (isPlainObject(projectStorageReceipts)) {
    values.push(
      projectStorageReceipts.after_app_source_deploy?.path,
      projectStorageReceipts.after_simulator_source_deploy?.path,
    );
  }
  return values.filter((value) => typeof value === "string");
}

export function collectGitState(repoRoot, releaseTag, privateArtifactPaths = []) {
  const headCommit = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const headTree = runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const status = runGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const remoteNames = runGit(repoRoot, ["remote"]);
  if (headCommit === null || headTree === null || status === null || remoteNames === null) return { available: false };
  const remoteUrls = [];
  const remotePushUrls = [];
  for (const name of remoteNames.split(/\r?\n/).filter(Boolean)) {
    const urls = runGit(repoRoot, ["remote", "get-url", "--all", name]);
    if (urls !== null) remoteUrls.push(...urls.split(/\r?\n/).filter(Boolean));
    const pushUrls = runGit(repoRoot, ["remote", "get-url", "--push", "--all", name]);
    if (pushUrls !== null) remotePushUrls.push(...pushUrls.split(/\r?\n/).filter(Boolean));
  }
  const safeTag = typeof releaseTag === "string" && tagPattern.test(releaseTag) && !/\.\.|@\{|\/\//.test(releaseTag) && !/[/.]$/.test(releaseTag);
  const tagCommit = safeTag ? runGit(repoRoot, ["rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`]) : null;
  const tagTree = safeTag ? runGit(repoRoot, ["rev-parse", "--verify", `refs/tags/${releaseTag}^{tree}`]) : null;
  const safePrivatePaths = privateArtifactPaths
    .filter((value) => typeof value === "string" && !path.isAbsolute(value))
    .map(normalizeRelativePath)
    .filter((value) => value.startsWith("artifacts/private/") && !value.startsWith("artifacts/private/../"));
  const privateRootIgnored = runGitStatus(repoRoot, ["check-ignore", "--no-index", "--quiet", "--", "artifacts/private/.submission-readiness-probe"]);
  const trackedPrivateArtifacts = runGit(repoRoot, ["ls-files", "--", "artifacts/private"]);
  const privateArtifactsSafe = (
    privateRootIgnored === 0
    && trackedPrivateArtifacts === ""
    && safePrivatePaths.length === privateArtifactPaths.length
    && safePrivatePaths.every((relativePath) => {
    const ignoredStatus = runGitStatus(repoRoot, ["check-ignore", "--no-index", "--quiet", "--", relativePath]);
    const trackedStatus = runGitStatus(repoRoot, ["ls-files", "--error-unmatch", "--", relativePath]);
    return ignoredStatus === 0 && trackedStatus !== 0 && trackedStatus !== null;
    })
  );
  return {
    available: true,
    headCommit,
    headTree,
    tagCommit,
    tagTree,
    remoteUrls,
    remotePushUrls,
    privateArtifactsSafe,
    clean: status.length === 0,
  };
}

export async function verifySubmissionReadiness(releaseRecord, {
  repoRoot = defaultRepoRoot,
  gitState,
  recordPath,
  nowMilliseconds = Date.now(),
} = {}) {
  const failures = [];
  const preflightNowMilliseconds = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  scanSensitiveContent(releaseRecord, "release_record", failures);
  validateReleaseRecord(releaseRecord, failures);

  if (recordPath) {
    const relative = normalizeRelativePath(path.relative(repoRoot, path.resolve(recordPath)));
    if (relative.startsWith("../") || path.isAbsolute(relative) || !relative.startsWith("artifacts/private/")) {
      addFailure(failures, "PRIVATE_RELEASE_RECORD", "The filled release record must be stored under ignored artifacts/private/.");
    }
  }

  validatePreflightReleaseTimestamp(
    releaseRecord,
    failures,
    preflightNowMilliseconds,
    operationalPreflightFreshnessMilliseconds,
  );
  await validateGoogleCloudResourceIdentity(repoRoot, releaseRecord, failures);
  const loadedPreflightReceipts = await loadAndValidateGoogleCloudPreflightReceipts(
    repoRoot,
    releaseRecord,
    failures,
    preflightNowMilliseconds,
    operationalPreflightFreshnessMilliseconds,
  );
  const projectStorageReceipts = await loadAndValidateProjectStorageReceipts(repoRoot, releaseRecord, failures);

  await validateFrozenContractSources(repoRoot, releaseRecord?.frozen_contracts, failures);
  const frozenFileBindings = new Map(
    (Array.isArray(releaseRecord?.frozen_files) ? releaseRecord.frozen_files.slice(0, requiredFrozenFilePaths.length + 1) : [])
      .filter((binding) => isPlainObject(binding) && typeof binding.path === "string")
      .map((binding) => [normalizeRelativePath(binding.path), binding]),
  );
  await validateFrozenFiles(repoRoot, releaseRecord?.frozen_files, failures);
  await validateFrontendArtifact(repoRoot, releaseRecord?.frontend_artifact, frozenFileBindings, failures);

  const runBindings = Array.isArray(releaseRecord?.receipts?.canonical_runs)
    ? releaseRecord.receipts.canonical_runs.slice(0, 5)
    : [];
  const preparationReceipts = [];
  const runReceipts = [];
  const chainAudits = [];
  for (let index = 0; index < runBindings.length; index += 1) {
    const binding = runBindings[index];
    const preparationReceipt = await loadReceipt(
      repoRoot,
      binding?.preparation_path,
      binding?.preparation_sha256,
      `canonical_preparation_receipt[${index + 1}]`,
      failures,
    );
    const runReceipt = await loadReceipt(
      repoRoot,
      binding?.run_path,
      binding?.run_sha256,
      `canonical_run_receipt[${index + 1}]`,
      failures,
    );
    const chainAudit = await loadReceipt(
      repoRoot,
      binding?.chain_audit_path,
      binding?.chain_audit_sha256,
      `canonical_chain_audit[${index + 1}]`,
      failures,
      { rejectRichArtifacts: false },
    );
    preparationReceipts.push(preparationReceipt);
    runReceipts.push(runReceipt);
    chainAudits.push(chainAudit);
    validatePreparationReceipt(preparationReceipt, failures);
    if (preparationReceipt) {
      const preparationBindings = [
        [preparationReceipt.prompt_version, releaseRecord?.frozen_contracts?.prompt?.version, "prompt_version"],
        [preparationReceipt.output_schema_version, releaseRecord?.frozen_contracts?.output_schema?.version, "output_schema_version"],
        [preparationReceipt.policy_version, releaseRecord?.frozen_contracts?.policy?.version, "policy_version"],
        [preparationReceipt.preparation_script_sha256, frozenFileBindings.get("scripts/prepare-canonical-run.ps1")?.sha256, "preparation_script_sha256"],
        [preparationReceipt.evidence?.original_sha256, frozenFileBindings.get("public/assets/pouch-front.jpg")?.sha256, "evidence.original_sha256"],
      ];
      for (const [actual, expected, key] of preparationBindings) {
        if (typeof expected !== "string" || typeof actual !== "string" || actual.toLowerCase() !== expected.toLowerCase()) {
          addFailure(failures, "RECEIPT_BINDING", `canonical_preparation_receipt[${index + 1}].${key} must match the frozen source contract.`);
        }
      }
    }
    validateRunReceipt(runReceipt, binding, releaseRecord, preparationReceipt, frozenFileBindings, failures);
    validateChainAudit(chainAudit, binding, runReceipt, preparationReceipt, releaseRecord, failures);
  }

  let canonicalPrivacyReceipt = null;
  let cleanBrowserReceipt = null;
  if (isPlainObject(releaseRecord?.receipts)) {
    canonicalPrivacyReceipt = await loadReceipt(
      repoRoot,
      releaseRecord.receipts.canonical_privacy_path,
      releaseRecord.receipts.canonical_privacy_sha256,
      "canonical_privacy_receipt",
      failures,
    );
    cleanBrowserReceipt = await loadReceipt(
      repoRoot,
      releaseRecord.receipts.clean_browser_path,
      releaseRecord.receipts.clean_browser_sha256,
      "clean_browser_receipt",
      failures,
    );
  }
  validateCanonicalRunSet(runBindings, preparationReceipts, runReceipts, releaseRecord, failures);
  validateCanonicalRevisionImageBindings(
    releaseRecord,
    projectStorageReceipts,
    preparationReceipts,
    runReceipts,
    failures,
  );
  validateCanonicalPrivacyReceipt(canonicalPrivacyReceipt, runBindings, releaseRecord, failures);
  validateCleanBrowserReceipt(cleanBrowserReceipt, runReceipts, releaseRecord, failures, preflightNowMilliseconds);
  await scanSubmissionMarkdown(repoRoot, failures);
  const privateArtifactPaths = collectPrivateArtifactBindings(repoRoot, recordPath, releaseRecord, loadedPreflightReceipts);
  validateGitState(
    releaseRecord,
    gitState || collectGitState(repoRoot, releaseRecord?.repository?.release_tag, privateArtifactPaths),
    failures,
  );

  return { ok: failures.length === 0, failures };
}

export async function verifyGoogleCloudPreflight(releaseRecord, {
  repoRoot = defaultRepoRoot,
  gitState,
  recordPath,
  nowMilliseconds = Date.now(),
} = {}) {
  const failures = [];
  const preflightNowMilliseconds = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  scanSensitiveContent(releaseRecord, "release_record", failures);
  if (!isPlainObject(releaseRecord)) {
    addFailure(failures, "RECORD_SCHEMA", "release_record must be an object.");
    return { ok: false, failures };
  }
  if (releaseRecord.schema_version !== RELEASE_RECORD_SCHEMA_VERSION) {
    addFailure(failures, "SCHEMA_VERSION", "release_record.schema_version must match the supported schema version.");
  }
  if (releaseRecord.kind !== "found-roll-submission-release") {
    addFailure(failures, "RELEASE_KIND", "release_record.kind must be found-roll-submission-release.");
  }
  validatePreflightReleaseTimestamp(
    releaseRecord,
    failures,
    preflightNowMilliseconds,
    operationalPreflightFreshnessMilliseconds,
  );
  validateGoogleCloudRecord(releaseRecord.google_cloud, failures, { requireDeploymentReady: false });
  if (recordPath) {
    const relative = normalizeRelativePath(path.relative(repoRoot, path.resolve(recordPath)));
    if (relative.startsWith("../") || path.isAbsolute(relative) || !relative.startsWith("artifacts/private/")) {
      addFailure(failures, "PRIVATE_RELEASE_RECORD", "The preflight release record must be stored under ignored artifacts/private/.");
    }
  }
  await validateGoogleCloudResourceIdentity(repoRoot, releaseRecord, failures);
  const loadedPreflightReceipts = await loadAndValidateGoogleCloudPreflightReceipts(
    repoRoot,
    releaseRecord,
    failures,
    preflightNowMilliseconds,
    operationalPreflightFreshnessMilliseconds,
  );
  const privateArtifactPaths = collectPrivateArtifactBindings(repoRoot, recordPath, releaseRecord, loadedPreflightReceipts);
  validatePrivateArtifactGitState(
    gitState || collectGitState(repoRoot, releaseRecord?.repository?.release_tag, privateArtifactPaths),
    failures,
  );
  return { ok: failures.length === 0, failures };
}

export async function verifyGoogleCloudTeardownIdentity(releaseRecord, {
  repoRoot = defaultRepoRoot,
  gitState,
  recordPath,
} = {}) {
  const failures = [];
  scanSensitiveContent(releaseRecord, "release_record", failures);
  validateReleaseRecord(releaseRecord, failures);
  if (recordPath) {
    const relative = normalizeRelativePath(path.relative(repoRoot, path.resolve(recordPath)));
    if (relative.startsWith("../") || path.isAbsolute(relative) || !relative.startsWith("artifacts/private/")) {
      addFailure(failures, "PRIVATE_RELEASE_RECORD", "The frozen release record must remain under ignored artifacts/private/ for teardown verification.");
    }
  }
  await validateGoogleCloudResourceIdentity(repoRoot, releaseRecord, failures);
  await validateFrozenFiles(repoRoot, releaseRecord?.frozen_files, failures);
  const privateArtifactPaths = collectPrivateArtifactBindings(repoRoot, recordPath, releaseRecord);
  validateGitState(
    releaseRecord,
    gitState || collectGitState(repoRoot, releaseRecord?.repository?.release_tag, privateArtifactPaths),
    failures,
  );
  return { ok: failures.length === 0, failures };
}

export function formatReadinessResult(result) {
  if (result.ok) return "SUBMISSION READINESS: PASS\nAll offline release-record, receipt, publication, and Git freeze checks passed.\n";
  const lines = [`SUBMISSION READINESS: FAIL (${result.failures.length})`];
  for (const failure of result.failures) lines.push(`- [${failure.code}] ${failure.message}`);
  return `${lines.join("\n")}\n`;
}

export function formatGoogleCloudPreflightResult(result) {
  if (result.ok) return "GOOGLE CLOUD PREFLIGHT: PASS\nThe entrant-attested Free Trial and spend caps are hash-bound, and the billing link is freshly CLI-corroborated.\n";
  const lines = [`GOOGLE CLOUD PREFLIGHT: FAIL (${result.failures.length})`];
  for (const failure of result.failures) lines.push(`- [${failure.code}] ${failure.message}`);
  return `${lines.join("\n")}\n`;
}

export function formatGoogleCloudTeardownIdentityResult(result) {
  if (result.ok) return "GOOGLE CLOUD TEARDOWN IDENTITY: PASS\nThe frozen release tag and dedicated-project identity are cross-bound for teardown.\n";
  const lines = [`GOOGLE CLOUD TEARDOWN IDENTITY: FAIL (${result.failures.length})`];
  for (const failure of result.failures) lines.push(`- [${failure.code}] ${failure.message}`);
  return `${lines.join("\n")}\n`;
}

function parseCliArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const parsed = {
    repoRoot: defaultRepoRoot,
    recordPath: null,
    preflightOnly: false,
    teardownIdentityOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--record" && argv[index + 1]) parsed.recordPath = path.resolve(argv[++index]);
    else if (argument === "--repo-root" && argv[index + 1]) parsed.repoRoot = path.resolve(argv[++index]);
    else if (argument === "--preflight-only" && !parsed.preflightOnly) parsed.preflightOnly = true;
    else if (argument === "--teardown-identity-only" && !parsed.teardownIdentityOnly) parsed.teardownIdentityOnly = true;
    else return { error: true };
  }
  if (!parsed.recordPath || (parsed.preflightOnly && parsed.teardownIdentityOnly)) return { error: true };
  return parsed;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseCliArgs(argv);
  if (args.help) {
    stdout.write("Usage: node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json [--repo-root <path>] [--preflight-only | --teardown-identity-only]\n");
    return 0;
  }
  if (args.error) {
    stderr.write("SUBMISSION READINESS: FAIL (1)\n- [CLI_USAGE] Supply exactly --record and, optionally, --repo-root and one verification mode.\n");
    return 1;
  }
  try {
    const [realRecord, realPrivateRoot] = await Promise.all([
      realpath(args.recordPath),
      realpath(path.join(args.repoRoot, "artifacts", "private")),
    ]);
    const privateRelative = path.relative(realPrivateRoot, realRecord);
    if (privateRelative.startsWith("..") || path.isAbsolute(privateRelative)) throw new Error("outside private root");
  } catch {
    stderr.write("SUBMISSION READINESS: FAIL (1)\n- [PRIVATE_RELEASE_RECORD] Store the filled release record under ignored artifacts/private/.\n");
    return 1;
  }
  let raw;
  let record;
  try {
    raw = await readRegularFileWithin(path.join(args.repoRoot, "artifacts", "private"), args.recordPath, maxJsonBytes);
    record = JSON.parse(raw.toString("utf8"));
  } catch {
    stderr.write("SUBMISSION READINESS: FAIL (1)\n- [RELEASE_RECORD_UNREADABLE] The release record could not be read as bounded JSON.\n");
    return 1;
  }
  const result = args.preflightOnly
    ? await verifyGoogleCloudPreflight(record, {
      repoRoot: args.repoRoot,
      recordPath: args.recordPath,
    })
    : args.teardownIdentityOnly
      ? await verifyGoogleCloudTeardownIdentity(record, {
        repoRoot: args.repoRoot,
        recordPath: args.recordPath,
      })
    : await verifySubmissionReadiness(record, {
      repoRoot: args.repoRoot,
      recordPath: args.recordPath,
    });
  const output = args.preflightOnly
    ? formatGoogleCloudPreflightResult(result)
    : args.teardownIdentityOnly
      ? formatGoogleCloudTeardownIdentityResult(result)
      : formatReadinessResult(result);
  (result.ok ? stdout : stderr).write(output);
  return result.ok ? 0 : 1;
}

async function isDirectInvocation(invokedValue) {
  if (!invokedValue) return false;
  try {
    const [realInvokedPath, realScriptPath] = await Promise.all([
      realpath(path.resolve(invokedValue)),
      realpath(scriptPath),
    ]);
    return path.relative(realInvokedPath, realScriptPath) === "";
  } catch {
    return false;
  }
}

if (await isDirectInvocation(process.argv[1])) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("SUBMISSION READINESS: FAIL (1)\n- [VERIFIER_ERROR] The offline verifier could not complete safely.\n");
    process.exitCode = 1;
  });
}
