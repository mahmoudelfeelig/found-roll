import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export const RELEASE_RECORD_SCHEMA_VERSION = "2";
export const SUBMISSION_TEMPLATE_PATH = "docs/submission-release.template.json";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "..");
const maxJsonBytes = 1024 * 1024;
const maxArtifactBytes = 64 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,255}$/;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const projectIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
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
const requiredFrozenFilePaths = [
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
  "public/assets/pouch-serial-detail.jpg",
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
  "docs/architecture.md",
  "docs/architecture-diagram.manifest.json",
  "docs/architecture-diagram.mmd",
  "docs/architecture-diagram.png",
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
  prompt: "found-roll-case-analyst-prompt-v1",
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

  if (checkObject(record.google_cloud, "release_record.google_cloud", [
    "project_id",
    "dedicated_project_confirmed",
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
  ], failures)) {
    requireIdentifier(record.google_cloud.project_id, "release_record.google_cloud.project_id", failures, projectIdPattern);
    if (record.google_cloud.billing_account_type !== "free_trial") {
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
      "required_apis_enabled_confirmed",
      "iam_ready_confirmed",
      "quota_ready_confirmed",
    ]) {
      requireTrue(record.google_cloud[key], `release_record.google_cloud.${key}`, failures);
    }
  }

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

async function readBoundedFile(filePath) {
  const content = await readFile(filePath);
  if (content.byteLength > maxJsonBytes) throw new Error("file too large");
  return content;
}

async function readBoundedArtifact(filePath) {
  const content = await readFile(filePath);
  if (content.byteLength > maxArtifactBytes) throw new Error("artifact too large");
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
    const [realFile, realRoot] = await Promise.all([realpath(absolute), realpath(repoRoot)]);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("file escaped repository root");
    return await readBoundedArtifact(realFile);
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
      const colorType = data[9];
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
      previousRow = decoded;
    }
    if (distinctColors.size < 8) return null;
  } catch {
    return null;
  }
  return { width, height };
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
    || !/--scaling=auto/i.test(deployment)
    || !/--max=1/i.test(deployment)
    || !/--max-instances=1/i.test(deployment)
    || !/--timeout=120s/i.test(deployment)
    || !/--timeout=20s/i.test(deployment)
    || !/--max-attempts=3/i.test(deployment)
    || !/--max-retry-duration=1s/i.test(deployment)
    || !/gcloud\s+secrets\s+versions\s+destroy/i.test(deployment)
    || !/gcloud\s+artifacts\s+docker\s+images\s+delete/i.test(deployment)
    || !/gcloud\s+storage\s+du\s+--summarize\s+--all-versions/i.test(deployment)
    || !/--soft-delete-duration=0/i.test(deployment)
    || !/--clear-soft-delete/i.test(deployment)
    || !/softDeletePolicy/i.test(deployment)
    || !/ProtectedRevisions/i.test(deployment)
    || !/SecretVersions/i.test(deployment)
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
    || boundedAgent?.max_llm_calls_cap !== 8
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
    const [realReceipt, realPrivateRoot] = await Promise.all([
      realpath(absolute),
      realpath(path.join(repoRoot, "artifacts", "private")),
    ]);
    const realRelative = path.relative(realPrivateRoot, realReceipt);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error("receipt escaped private root");
    raw = await readBoundedFile(absolute);
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
    let raw;
    try {
      raw = await readBoundedFile(path.join(repoRoot, expectedPath));
    } catch {
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
    if (!Number.isInteger(receipt.live_agent.invocation_count) || receipt.live_agent.invocation_count < 1 || receipt.live_agent.invocation_count > 8) {
      addFailure(failures, "LIVE_AGENT_TRAJECTORY", `${base}.live_agent.invocation_count must be between 1 and the frozen cap of 8.`);
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
    for (const key of ["firestore_namespace", "evidence_bucket", "task_name", "simulator_request_id", "reservation_id", "attestation_id", "simulator_etag", "callback_replay_outcome"]) {
      requireReceiptIdentifier(receipt.cloud_boundary, key, `${base}.cloud_boundary`, failures);
    }
    for (const key of ["firestore_transaction_contention_verified", "evidence_generations_verified", "task_oidc_verified", "production_payload_omitted", "simulator_https_verified", "simulator_api_auth_verified", "callback_signature_verified"]) {
      requireTrue(receipt.cloud_boundary[key], `${base}.cloud_boundary.${key}`, failures);
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

function validateCleanBrowserReceipt(receipt, runReceipts, releaseRecord, failures) {
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
  requireUtcTimestamp(receipt.verified_at_utc, `${base}.verified_at_utc`, failures);
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
    if (![item.prepared, item.started, item.ended].every(Number.isFinite) || !(item.prepared < item.started && item.started < item.ended)) {
      addFailure(failures, "CANONICAL_RUN_TIME", "Every canonical preparation must precede its run start and end.");
      break;
    }
    if (previousEnd !== null && item.prepared <= previousEnd) {
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
    await readFile(readme);
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
      content = (await readBoundedFile(file)).toString("utf8");
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

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
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
  const result = spawnSync("git", args, {
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

function collectPrivateArtifactBindings(repoRoot, recordPath, releaseRecord) {
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
} = {}) {
  const failures = [];
  scanSensitiveContent(releaseRecord, "release_record", failures);
  validateReleaseRecord(releaseRecord, failures);

  if (recordPath) {
    const relative = normalizeRelativePath(path.relative(repoRoot, path.resolve(recordPath)));
    if (relative.startsWith("../") || path.isAbsolute(relative) || !relative.startsWith("artifacts/private/")) {
      addFailure(failures, "PRIVATE_RELEASE_RECORD", "The filled release record must be stored under ignored artifacts/private/.");
    }
  }

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
  validateCanonicalPrivacyReceipt(canonicalPrivacyReceipt, runBindings, releaseRecord, failures);
  validateCleanBrowserReceipt(cleanBrowserReceipt, runReceipts, releaseRecord, failures);
  await scanSubmissionMarkdown(repoRoot, failures);
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

function parseCliArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const parsed = { repoRoot: defaultRepoRoot, recordPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--record" && argv[index + 1]) parsed.recordPath = path.resolve(argv[++index]);
    else if (argument === "--repo-root" && argv[index + 1]) parsed.repoRoot = path.resolve(argv[++index]);
    else return { error: true };
  }
  if (!parsed.recordPath) return { error: true };
  return parsed;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseCliArgs(argv);
  if (args.help) {
    stdout.write("Usage: node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json [--repo-root <path>]\n");
    return 0;
  }
  if (args.error) {
    stderr.write("SUBMISSION READINESS: FAIL (1)\n- [CLI_USAGE] Supply exactly --record and, optionally, --repo-root.\n");
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
    raw = await readBoundedFile(args.recordPath);
    record = JSON.parse(raw.toString("utf8"));
  } catch {
    stderr.write("SUBMISSION READINESS: FAIL (1)\n- [RELEASE_RECORD_UNREADABLE] The release record could not be read as bounded JSON.\n");
    return 1;
  }
  const gitState = collectGitState(
    args.repoRoot,
    record?.repository?.release_tag,
    collectPrivateArtifactBindings(args.repoRoot, args.recordPath, record),
  );
  const result = await verifySubmissionReadiness(record, {
    repoRoot: args.repoRoot,
    gitState,
    recordPath: args.recordPath,
  });
  const output = formatReadinessResult(result);
  (result.ok ? stdout : stderr).write(output);
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === scriptPath) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write("SUBMISSION READINESS: FAIL (1)\n- [VERIFIER_ERROR] The offline verifier could not complete safely.\n");
    process.exitCode = 1;
  });
}
