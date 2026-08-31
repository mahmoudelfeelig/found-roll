const CASE_ID = "FR-20260829-0042";

function uniqueKey(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ui:${prefix}:${suffix}`;
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser cannot create a stable intake receipt.");
  }
  const bytes = value instanceof ArrayBuffer ? value : new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function intakeCommandKey(intake) {
  const commandDigest = await sha256Hex(JSON.stringify({
    safetyResult: "ORDINARY_ITEM",
    category: intake.category || "camera_pouch",
    riskTier: intake.riskTier || "VALUABLE",
    assignedTenant: intake.assignedTenant,
    currentHolder: intake.currentHolder,
    publicDescription: intake.publicDescription,
    foundAt: intake.foundAt,
    foundZone: intake.foundZone,
    reportRoute: intake.reportRoute,
  }));
  return `ui:intake:${commandDigest}`;
}

export async function evidenceCommandKey(caseId, intake, file) {
  const fileDigest = await sha256Hex(await file.arrayBuffer());
  const commandDigest = await sha256Hex(JSON.stringify({
    caseId,
    authorizePreviewForModel: Boolean(intake.authorizePreviewForModel),
    fileDigest,
    fileType: file.type,
  }));
  return `ui:evidence:${commandDigest}`;
}

function displayTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function eventLabel(type = "SERVICE_EVENT") {
  return type
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function stateNotice(state, flags, riskTier, analysisAutoStartArmed = false) {
  if (flags.tokenReplayRejected) return "Credential replay was rejected by the custody service. No custody state changed.";
  if (flags.callbackReplayHandled) return "Duplicate release work was acknowledged idempotently. The service event chain did not advance.";
  const notices = {
    RECEIVED: analysisAutoStartArmed
      ? "This ordinary intake will queue bounded analysis only after staff authorizes its derived preview."
      : "The prepared synthetic case is waiting for its bounded analysis command.",
    EVIDENCE_READY: analysisAutoStartArmed
      ? "The server is committing the authorized evidence packet and queued analysis command."
      : "Service evidence is ready for bounded analysis.",
    ANALYZING: "The custody service queued and is running bounded candidate analysis.",
    CANDIDATES_READY: "Candidates are structured; the service is preparing a private discriminator.",
    CLARIFICATION_REQUIRED: "Visual similarity is insufficient. The connected service requires private evidence.",
    CLAIM_EVIDENCE_ACCEPTED: "The service accepted claim evidence. Staff identity attestation is still required.",
    IDENTITY_ATTESTED: riskTier === "STANDARD"
      ? "Identity is attested. Standard-item policy permits the operator to request a simulated relay reservation."
      : "Identity is attested. The service is evaluating the valuable-item approval boundary.",
    APPROVAL_REQUIRED: "The connected service requires accountable supervisor approval.",
    RESERVE_REQUESTED: "The reservation outbox is committed and awaiting the simulator attestation.",
    RESERVED: "The SIMULATED relay reservation is held. Current-session credentials can be presented once.",
    CLAIMANT_PRESENT: "At least one credential presentation is attested; both are required before release.",
    RELEASE_REQUESTED: "The release outbox is committed and awaiting the simulator attestation.",
    RELEASED: "The simulator release attestation was accepted. The passport can now close.",
    CLOSED: "The service closed the Item Passport and generated an internally consistent manifest.",
    MANUAL_REVIEW: "The custody service paused automatic work for manual review.",
  };
  return notices[state] || `Connected custody state: ${String(state || "UNKNOWN").replaceAll("_", " ")}.`;
}

function credentialProjection(role, handoff, rawValue) {
  const attested = Boolean(handoff?.[`${role}_attested`]);
  const issued = Boolean(handoff?.tokens_issued);
  return {
    id: issued ? `${role.toUpperCase()} · ${handoff.id.slice(-8).toUpperCase()}` : `${role.toUpperCase()} · NOT ISSUED`,
    value: rawValue || null,
    status: attested ? "USED" : issued ? "ISSUED" : "NOT_ISSUED",
    usedAt: attested ? "service-attested" : null,
    available: Boolean(rawValue),
  };
}

/**
 * Project the service's public custody snapshot into the presentation model.
 * The projector never invents a state transition. Raw credentials enter only
 * through sessionSecrets, which is populated from the token-issuance response.
 */
export function projectCustodySnapshot(snapshot, session = {}) {
  if (!snapshot?.case) throw new Error("Custody snapshot is missing its authoritative case record.");
  const custodyCase = snapshot.case;
  const handoff = snapshot.handoff || null;
  const flags = {
    tokenReplayRejected: Boolean(session.tokenReplayRejected),
    callbackReplayHandled: Boolean(session.callbackReplayHandled),
  };
  const events = (snapshot.events || []).map((event) => ({
    ...event,
    time: displayTime(event.occurred_at),
    label: eventLabel(event.type),
    detail: event.reason,
    actor: event.actor,
  }));
  const reservation = handoff ? {
    id: handoff.reservation_id || handoff.id,
    handoffId: handoff.id,
    provider: handoff.provider,
    itemId: handoff.item_id,
    status: handoff.status,
    expiresAt: handoff.expires_at,
    remoteEtag: handoff.remote_etag,
    remoteVersion: handoff.remote_version,
    simulated: handoff.simulated,
  } : null;
  const callbackAccepted = ["RELEASED", "CLOSED"].includes(custodyCase.state);

  return {
    authoritative: true,
    source: "service",
    caseId: custodyCase.id,
    state: custodyCase.state,
    version: custodyCase.version,
    claimAnswer: "",
    answerAttempts: custodyCase.wrong_answer_count || 0,
    claimAcceptedAt: custodyCase.accepted_claim_evidence ? custodyCase.updated_at : null,
    identity: custodyCase.identity_attested
      ? { method: "Staff attestation retained by service", at: custodyCase.updated_at }
      : null,
    approval: custodyCase.approval_recorded
      ? { decision: "APPROVED", at: custodyCase.updated_at }
      : null,
    reservation,
    handoff,
    claimLink: session.claimLink ? {
      value: session.claimLink.token || null,
      expiresAt: session.claimLink.expiresAt || null,
      issuedCaseVersion: session.claimLink.issuedCaseVersion ?? null,
      available: Boolean(session.claimLink.token),
    } : null,
    claimantToken: credentialProjection("claimant", handoff, session.tokens?.claimant),
    custodianToken: credentialProjection("custodian", handoff, session.tokens?.custodian),
    callback: {
      status: callbackAccepted ? "ACCEPTED" : "WAITING",
      replayHandled: flags.callbackReplayHandled,
    },
    tokenReplayRejected: flags.tokenReplayRejected,
    events,
    manifest: session.manifest || null,
    authoritativeCase: custodyCase,
    candidates: snapshot.candidates || [],
    intakeEvidence: session.intakeEvidence || null,
    execution: snapshot.execution || null,
    disclosure: snapshot.disclosure || null,
    lastNotice: stateNotice(
      custodyCase.state,
      flags,
      custodyCase.risk_tier,
      custodyCase.analysis_auto_start_armed,
    ),
  };
}

export function projectClaimantCase(claimantCase, session = {}) {
  if (!claimantCase?.id) throw new Error("Claimant projection is missing its case identifier.");
  const link = claimantCase.link || {};
  const sessionLink = session.claimLink || null;
  return {
    authoritative: true,
    source: "claimant_service",
    caseId: claimantCase.id,
    state: claimantCase.state,
    version: claimantCase.version,
    claimAnswer: "",
    answerAttempts: claimantCase.attempt_count || 0,
    claimAcceptedAt: claimantCase.state === "CLAIM_EVIDENCE_ACCEPTED" ? "service-attested" : null,
    identity: null,
    approval: null,
    reservation: null,
    handoff: null,
    claimLink: {
      value: sessionLink?.token || null,
      expiresAt: sessionLink?.expiresAt || link.expires_at || null,
      issuedCaseVersion: sessionLink?.issuedCaseVersion ?? link.issued_case_version ?? null,
      available: Boolean(sessionLink?.token && (sessionLink.active ?? true)),
    },
    claimantToken: credentialProjection("claimant", null, null),
    custodianToken: credentialProjection("custodian", null, null),
    callback: { status: "WAITING", replayHandled: false },
    tokenReplayRejected: false,
    events: [],
    manifest: null,
    authoritativeCase: null,
    claimantCase,
    candidates: [],
    execution: null,
    disclosure: null,
    lastNotice: claimantCase.state === "CLAIM_EVIDENCE_ACCEPTED"
      ? "The custody service accepted this private evidence. Staff release gates remain outstanding."
      : "The scoped claimant link is active for one private evidence submission.",
  };
}

export async function configureRuntimeSession(client, credentials = {}) {
  const demoToken = typeof credentials.demoToken === "string" ? credentials.demoToken.trim() : "";
  const staffToken = typeof credentials.staffToken === "string" ? credentials.staffToken.trim() : "";
  const supervisorToken = typeof credentials.supervisorToken === "string" ? credentials.supervisorToken.trim() : "";
  const supplied = [demoToken, staffToken, supervisorToken].filter(Boolean).length;

  client.clearSession();
  if (supplied === 0) {
    return { configured: false, projection: null, roles: null };
  }
  if (supplied !== 3) {
    throw new Error("Load all three distinct runtime role credentials.");
  }

  client.setDemoToken(demoToken);
  client.setStaffToken(staffToken);
  client.setSupervisorToken(supervisorToken);
  try {
    const roles = await client.verifyRuntimeCredentials();
    const projection = await client.loadProjection();
    return { configured: true, projection, roles };
  } catch (error) {
    client.clearSession();
    throw error;
  }
}

function isDefinitiveServiceRejection(error) {
  const status = Number(error?.status);
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && ![408, 425, 429].includes(status);
}

export async function recoverConnectedActionFailure(client, scope, error) {
  if (scope === "claimant") {
    return isDefinitiveServiceRejection(error)
      ? { kind: "claimant_unavailable", caseId: client.caseId }
      : { kind: "preserve_claimant" };
  }
  if (scope === "relay") return { kind: "preserve_relay" };
  return { kind: "projection", projection: await client.loadProjection() };
}

export class ServiceDemoClient {
  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.caseId = CASE_ID;
    this.demoToken = "";
    this.staffToken = "";
    this.supervisorToken = "";
    this.runtimeRoles = null;
    this.case = null;
    this.handoff = null;
    this.claimLink = null;
    this.tokens = null;
    this.releaseTask = null;
    this.releaseOutbox = null;
    this.manifest = null;
    this.intakeEvidence = null;
    this.pendingIntake = null;
    this.pendingClaim = null;
    this.tokenReplayRejected = false;
    this.callbackReplayHandled = false;
  }

  clearSession() {
    this.demoToken = "";
    this.staffToken = "";
    this.supervisorToken = "";
    this.runtimeRoles = null;
    this.case = null;
    this.handoff = null;
    this.claimLink = null;
    this.tokens = null;
    this.releaseTask = null;
    this.releaseOutbox = null;
    this.manifest = null;
    this.pendingIntake = null;
    this.pendingClaim = null;
    this.tokenReplayRejected = false;
    this.callbackReplayHandled = false;
    this.replaceIntakeEvidence(null);
  }

  replaceIntakeEvidence(nextEvidence) {
    const previousUrl = this.intakeEvidence?.objectUrl;
    if (previousUrl && previousUrl !== nextEvidence?.objectUrl) {
      URL.revokeObjectURL?.(previousUrl);
    }
    this.intakeEvidence = nextEvidence || null;
  }

  setDemoToken(value) {
    this.demoToken = typeof value === "string" ? value.trim() : "";
    this.runtimeRoles = null;
    this.tokens = null;
    this.releaseTask = null;
    this.releaseOutbox = null;
    this.tokenReplayRejected = false;
    this.callbackReplayHandled = false;
    return Boolean(this.demoToken);
  }

  setStaffToken(value) {
    this.staffToken = typeof value === "string" ? value.trim() : "";
    this.runtimeRoles = null;
    if (!this.staffToken) this.replaceIntakeEvidence(null);
    return Boolean(this.staffToken);
  }

  setSupervisorToken(value) {
    this.supervisorToken = typeof value === "string" ? value.trim() : "";
    this.runtimeRoles = null;
    return Boolean(this.supervisorToken);
  }

  setCaseId(value) {
    const next = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z0-9._:-]{3,100}$/.test(next)) return false;
    if (next !== this.caseId) {
      this.caseId = next;
      this.case = null;
      this.handoff = null;
      this.claimLink = null;
      this.tokens = null;
      this.releaseTask = null;
      this.releaseOutbox = null;
      this.manifest = null;
      this.pendingClaim = null;
      this.replaceIntakeEvidence(null);
    }
    return true;
  }

  setClaimLinkToken(value) {
    const token = typeof value === "string" ? value.trim() : "";
    if (token !== this.claimLink?.token) this.pendingClaim = null;
    this.claimLink = token ? { token, expiresAt: null, issuedCaseVersion: null } : null;
    return Boolean(token);
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const detail = payload?.error?.message || `Custody service returned ${response.status}`;
      const error = new Error(detail);
      error.code = payload?.error?.code || `http_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  post(path, body) {
    return this.request(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      headers: this.demoToken ? { "X-Found-Roll-Demo-Token": this.demoToken } : {},
    });
  }

  async verifyRuntimeCredentials() {
    if (!this.demoToken || !this.staffToken || !this.supervisorToken) {
      throw new Error("Load all three distinct runtime role credentials.");
    }
    const roles = await this.request("/api/v1/auth/runtime-roles", {
      method: "GET",
      cache: "no-store",
      headers: {
        "X-Found-Roll-Demo-Token": this.demoToken,
        "X-Found-Roll-Staff-Token": this.staffToken,
        "X-Found-Roll-Supervisor-Token": this.supervisorToken,
      },
    });
    if (
      roles?.authenticated !== true
      || typeof roles.staff_actor_id !== "string"
      || typeof roles.supervisor_actor_id !== "string"
    ) {
      throw new Error("The custody service returned an invalid runtime role receipt.");
    }
    this.runtimeRoles = roles;
    return roles;
  }

  async snapshot() {
    const snapshot = await this.request(`/api/v1/passports/${this.caseId}`, {
      headers: this.staffToken ? { "X-Found-Roll-Staff-Token": this.staffToken } : {},
    });
    const previousHandoffId = this.handoff?.id || null;
    this.case = snapshot.case;
    this.handoff = snapshot.handoff || null;
    if (!this.handoff || (previousHandoffId && previousHandoffId !== this.handoff.id)) {
      this.tokens = null;
      this.releaseTask = null;
      this.releaseOutbox = null;
      this.tokenReplayRejected = false;
      this.callbackReplayHandled = false;
    }
    if (snapshot.case.state !== "CLOSED") this.manifest = null;
    return snapshot;
  }

  projectionSession() {
    return {
      tokens: this.tokens,
      manifest: this.manifest,
      tokenReplayRejected: this.tokenReplayRejected,
      callbackReplayHandled: this.callbackReplayHandled,
      claimLink: this.claimLink,
      intakeEvidence: this.intakeEvidence,
    };
  }

  projectKnownCase(custodyCase = this.case) {
    if (!custodyCase) throw new Error("Custody service did not return an authoritative case projection.");
    return projectCustodySnapshot({
      case: custodyCase,
      handoff: this.handoff,
      events: [],
      candidates: [],
      execution: null,
      disclosure: null,
    }, this.projectionSession());
  }

  async loadProjection() {
    const snapshot = await this.snapshot();
    await this.loadCurrentEvidencePreview(snapshot.case);
    if (this.claimLink?.token && !this.claimLink.expiresAt && snapshot.case.state === "CLARIFICATION_REQUIRED") {
      try {
        const inspected = await this.inspectClaimLink();
        this.claimLink = {
          ...this.claimLink,
          expiresAt: inspected.expires_at,
          issuedCaseVersion: inspected.issued_case_version,
          errorCode: null,
        };
      } catch (error) {
        this.claimLink = {
          token: null,
          expiresAt: null,
          issuedCaseVersion: null,
          errorCode: error?.code || "claim_link_invalid",
        };
      }
    }
    if (snapshot.case.state === "CLOSED" && !this.manifest) {
      this.manifest = await this.request(`/api/v1/passports/${this.caseId}/manifest`, {
        headers: this.staffToken ? { "X-Found-Roll-Staff-Token": this.staffToken } : {},
      });
    }
    return projectCustodySnapshot(snapshot, this.projectionSession());
  }

  async loadCurrentEvidencePreview(custodyCase = this.case) {
    if (!this.staffToken || !custodyCase?.id || !custodyCase.workflow_epoch) return null;
    const listing = await this.request(
      `/api/v1/staff/passports/${custodyCase.id}/evidence`,
      { headers: { "X-Found-Roll-Staff-Token": this.staffToken } },
    );
    if (listing.workflow_epoch !== custodyCase.workflow_epoch) {
      throw new Error("The evidence listing does not match the current workflow epoch.");
    }
    const activeIds = new Set(listing.active_pair_ids || []);
    const preview = (listing.items || []).find((record) => (
      activeIds.has(record.id)
      && record.workflow_epoch === custodyCase.workflow_epoch
      && record.provenance?.origin === "DERIVED"
    ));
    if (!preview) {
      this.replaceIntakeEvidence(null);
      return null;
    }
    if (
      this.intakeEvidence?.id === preview.id
      && this.intakeEvidence?.workflowEpoch === custodyCase.workflow_epoch
      && this.intakeEvidence?.displaySource === "server-derived-preview"
    ) {
      return this.intakeEvidence;
    }
    const displayBlob = await this.readStaffEvidence(preview.id);
    const objectUrl = URL.createObjectURL?.(displayBlob) || null;
    this.replaceIntakeEvidence({
      id: preview.id,
      originalId: preview.provenance.source_evidence_id,
      caseId: custodyCase.id,
      workflowEpoch: custodyCase.workflow_epoch,
      filename: "staff-authorized-preview.jpg",
      mimeType: preview.mime_type,
      sha256: preview.sha256,
      displaySource: "server-derived-preview",
      src: objectUrl,
      objectUrl,
    });
    return this.intakeEvidence;
  }

  async loadClaimantProjection() {
    if (!this.claimLink?.token) {
      throw new Error("This claimant session does not hold an active scoped proof link.");
    }
    const inspected = await this.inspectClaimLink();
    this.caseId = inspected.case.id;
    this.case = inspected.case;
    this.claimLink = {
      ...this.claimLink,
      expiresAt: inspected.expires_at,
      issuedCaseVersion: inspected.issued_case_version,
    };
    return projectClaimantCase(inspected.case, { claimLink: this.claimLink });
  }

  async readStaffEvidence(evidenceId) {
    if (!this.staffToken) throw new Error("Load the staff evidence credential before reading intake media.");
    const response = await fetch(
      `${this.baseUrl}/api/v1/staff/passports/${this.caseId}/evidence/${evidenceId}`,
      {
        headers: {
          Accept: "image/jpeg,image/png",
          "X-Found-Roll-Staff-Token": this.staffToken,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Staff evidence preview returned ${response.status}`);
    }
    const mimeType = response.headers.get("content-type") || "";
    if (!["image/jpeg", "image/png"].includes(mimeType)) {
      throw new Error("Staff evidence preview returned an unsupported media type.");
    }
    return response.blob();
  }

  async waitForState(expectedState, timeoutMs = 25_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const snapshot = await this.snapshot();
      if (snapshot.case.state === expectedState) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for custody state ${expectedState}`);
  }

  async completeTask(result, expectedState) {
    const task = result.task;
    if (!task) throw new Error("Custody service did not return a task receipt.");
    if (task.mode === "inline") {
      if (!task.payload) throw new Error("Custody service did not return an opaque task payload.");
      const completed = await this.post("/tasks/outbox", task.payload);
      this.case = completed.case;
      this.handoff = completed.handoff || this.handoff;
      return completed;
    }
    if (task.mode === "cloud_tasks") {
      if (!task.queued || !task.task_name) {
        throw new Error("Custody service returned an incomplete Cloud Tasks receipt.");
      }
      return this.waitForState(expectedState);
    }
    throw new Error(`Unsupported custody task mode: ${task.mode || "missing"}`);
  }

  async beginAnalysis(idempotencyKey = uniqueKey("analysis")) {
    if (!this.case) await this.snapshot();
    const started = await this.post(`/api/v1/passports/${this.caseId}/analysis-jobs`, {
      expected_version: this.case.version,
      idempotency_key: idempotencyKey,
    });
    this.case = started.case;
    return this.completeTask(started, "CLARIFICATION_REQUIRED");
  }

  async submitClaim(answer) {
    if (!this.pendingClaim && !this.claimLink?.token) {
      throw new Error("This claimant session does not hold an active scoped proof link.");
    }
    if (!this.pendingClaim) {
      this.pendingClaim = {
        path: `/api/v1/passports/${this.caseId}/claim-evidence`,
        token: this.claimLink.token,
        body: JSON.stringify({
          expected_version: this.case.version,
          idempotency_key: uniqueKey("claim"),
          answer,
        }),
      };
    }
    const pending = this.pendingClaim;
    try {
      const result = await this.request(pending.path, {
        method: "POST",
        body: pending.body,
        headers: { "X-Found-Roll-Claim-Link": pending.token },
      });
      const nextClaimLink = result.replacement_claim_link ? {
        token: result.replacement_claim_link.token,
        expiresAt: result.replacement_claim_link.expires_at,
        issuedCaseVersion: result.replacement_claim_link.issued_case_version,
      } : null;
      const projection = projectClaimantCase(result.case, { claimLink: nextClaimLink });
      this.case = result.case;
      this.claimLink = nextClaimLink;
      this.pendingClaim = null;
      return { ...result, projection };
    } catch (error) {
      if (isDefinitiveServiceRejection(error)) this.pendingClaim = null;
      throw error;
    }
  }

  async issueClaimLink() {
    if (!this.demoToken) throw new Error("Load the operator demo credential before issuing a claimant proof link.");
    if (!this.staffToken) throw new Error("Load the staff role credential before issuing a claimant proof link.");
    const issued = await this.request(`/api/v1/passports/${this.caseId}/claim-links`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: this.case.version,
        idempotency_key: uniqueKey("claim-link"),
      }),
      headers: {
        ...(this.demoToken ? { "X-Found-Roll-Demo-Token": this.demoToken } : {}),
        "X-Found-Roll-Staff-Token": this.staffToken,
      },
    });
    this.claimLink = {
      token: issued.token,
      expiresAt: issued.expires_at,
      issuedCaseVersion: issued.issued_case_version,
    };
    return issued;
  }

  inspectClaimLink() {
    if (!this.claimLink?.token) throw new Error("No claimant proof link is loaded in this tab.");
    return this.request(`/api/v1/passports/${this.caseId}/claim-link`, {
      headers: { "X-Found-Roll-Claim-Link": this.claimLink.token },
    });
  }

  async importIntake(intake, { onQueuedProjection } = {}) {
    if (!this.demoToken) {
      throw new Error("Load the operator demo credential before creating an intake.");
    }
    if (!this.staffToken) {
      throw new Error("Load the staff evidence credential before importing intake media.");
    }
    let file = intake.file || null;
    if (!file && intake.useSyntheticFixture) {
      const response = await fetch("/assets/pouch-front.jpg", { headers: { Accept: "image/jpeg" } });
      if (!response.ok) throw new Error("The synthetic intake photo could not be loaded.");
      const blob = await response.blob();
      file = new File([blob], "NPA29_042_A.JPG", { type: "image/jpeg" });
    }
    if (!file) throw new Error("Choose a JPEG or PNG intake photo.");
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      throw new Error("Found Roll accepts JPEG or PNG intake photos only.");
    }

    const idempotencyKey = await intakeCommandKey(intake);
    const isRetry = this.pendingIntake?.idempotencyKey === idempotencyKey;
    if (!isRetry) {
      this.pendingIntake = {
        idempotencyKey,
        caseId: null,
        evidenceKey: null,
        uploaded: null,
      };
    }
    const pending = this.pendingIntake;
    const created = await this.request("/api/v1/intakes", {
      method: "POST",
      body: JSON.stringify({
        safety_result: "ORDINARY_ITEM",
        category: intake.category || "camera_pouch",
        risk_tier: intake.riskTier || "VALUABLE",
        assigned_tenant: intake.assignedTenant,
        current_holder: intake.currentHolder,
        public_description: intake.publicDescription,
        found_at: intake.foundAt,
        found_zone: intake.foundZone,
        report_route: intake.reportRoute,
        idempotency_key: idempotencyKey,
      }),
      headers: {
        ...(this.demoToken ? { "X-Found-Roll-Demo-Token": this.demoToken } : {}),
        "X-Found-Roll-Staff-Token": this.staffToken,
      },
    });
    this.setCaseId(created.case.id);
    this.case = created.case;
    pending.caseId = created.case.id;

    const evidenceKey = await evidenceCommandKey(created.case.id, intake, file);
    if (pending.evidenceKey !== evidenceKey) {
      pending.evidenceKey = evidenceKey;
      pending.uploaded = null;
    }
    let uploaded = pending.uploaded;
    if (!uploaded) {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("authorize_preview_for_model", intake.authorizePreviewForModel ? "true" : "false");
      form.append("idempotency_key", evidenceKey);
      uploaded = await this.request(`/api/v1/staff/passports/${this.caseId}/evidence`, {
        method: "POST",
        body: form,
        headers: { "X-Found-Roll-Staff-Token": this.staffToken },
      });
      pending.uploaded = uploaded;
    }
    let displayBlob;
    let displaySource = "server-derived-preview";
    try {
      displayBlob = await this.readStaffEvidence(uploaded.preview.id);
    } catch {
      displayBlob = file;
      displaySource = "accepted-upload-local-preview";
    }
    const objectUrl = URL.createObjectURL?.(displayBlob);
    this.replaceIntakeEvidence({
      id: uploaded.preview.id,
      originalId: uploaded.original.id,
      caseId: this.caseId,
      workflowEpoch: uploaded.workflow_epoch || this.case?.workflow_epoch || null,
      filename: file.name,
      mimeType: uploaded.preview.mime_type,
      sha256: uploaded.preview.sha256,
      displaySource,
      src: objectUrl || null,
      objectUrl: objectUrl || null,
    });
    const publishQueuedProjection = () => {
      if (this.case?.state !== "ANALYZING" || typeof onQueuedProjection !== "function") return;
      onQueuedProjection(this.projectKnownCase());
    };
    if (uploaded.analysis_job) {
      this.case = uploaded.analysis_job.case;
      publishQueuedProjection();
      await this.completeTask(uploaded.analysis_job, "CLARIFICATION_REQUIRED");
    } else {
      const current = await this.snapshot();
      // A response can be lost after the server committed the background command.
      // In that case the retry observes the running task instead of issuing one.
      if (current.case.state === "ANALYZING") {
        publishQueuedProjection();
        await this.waitForState("CLARIFICATION_REQUIRED");
      }
    }
    this.pendingIntake = null;
  }

  async attestIdentity() {
    if (!this.staffToken) throw new Error("Load the staff role credential before recording identity attestation.");
    const result = await this.request(`/api/v1/passports/${this.caseId}/identity-attestations`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: this.case.version,
        idempotency_key: uniqueKey("identity"),
        method: "government_id_visual_check",
      }),
      headers: { "X-Found-Roll-Staff-Token": this.staffToken },
    });
    this.case = result.case;
    return result;
  }

  async approve() {
    if (!this.supervisorToken) throw new Error("Load the supervisor role credential before approving a valuable item.");
    const result = await this.request(`/api/v1/passports/${this.caseId}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: this.case.version,
        idempotency_key: uniqueKey("approval"),
        approved: true,
        reason: "Private evidence and staff identity attestation satisfy the valuable-item policy.",
      }),
      headers: { "X-Found-Roll-Supervisor-Token": this.supervisorToken },
    });
    this.case = result.case;
    return result;
  }

  async reserveAndIssueTokens() {
    const candidates = await this.request(`/api/v1/passports/${this.caseId}/candidates`, {
      headers: this.staffToken ? { "X-Found-Roll-Staff-Token": this.staffToken } : {},
    });
    const selected = candidates.items.find((candidate) => candidate.id === this.case.selected_item_id);
    if (!selected?.remote_etag) throw new Error("Selected candidate is missing its current remote eTag.");
    const requested = await this.post(`/api/v1/passports/${this.caseId}/reservations`, {
      expected_version: this.case.version,
      idempotency_key: uniqueKey("reserve"),
      expected_remote_etag: selected.remote_etag,
    });
    this.case = requested.case;
    await this.completeTask(requested, "RESERVED");
    const issued = await this.post(`/api/v1/passports/${this.caseId}/tokens`, {
      expected_version: this.case.version,
      idempotency_key: uniqueKey("tokens"),
    });
    this.case = issued.case;
    this.handoff = issued.handoff;
    this.tokens = {
      claimant: issued.claimant_token,
      custodian: issued.custodian_token,
    };
    return issued;
  }

  async presentToken(role) {
    if (!this.tokens?.[role] || !this.handoff) {
      throw new Error("This browser session does not hold the service-issued credential. Reset the demo to issue a fresh pair.");
    }
    const purpose = role === "claimant" ? "CLAIMANT" : "CUSTODIAN";
    const result = await this.post(`/api/v1/passports/${this.caseId}/token-attestations`, {
      expected_version: this.case.version,
      idempotency_key: uniqueKey(`token-${role}`),
      handoff_id: this.handoff.id,
      purpose,
      token: this.tokens[role],
    });
    this.case = result.case;
    this.handoff = result.handoff;
    return result;
  }

  async releaseAndClose() {
    if (!this.staffToken) throw new Error("Load the staff role credential before releasing custody.");
    const requested = await this.request(`/api/v1/passports/${this.caseId}/releases`, {
      method: "POST",
      body: JSON.stringify({
        expected_version: this.case.version,
        idempotency_key: uniqueKey("release"),
      }),
      headers: { "X-Found-Roll-Staff-Token": this.staffToken },
    });
    this.case = requested.case;
    this.releaseTask = requested.task;
    this.releaseOutbox = requested.outbox;
    await this.completeTask(requested, "RELEASED");
    this.manifest = await this.post(`/api/v1/passports/${this.caseId}/close`, {
      expected_version: this.case.version,
      idempotency_key: uniqueKey("close"),
    });
    return this.manifest;
  }

  async replayReleaseTask() {
    if (!this.releaseOutbox?.id) throw new Error("No completed release command is available to replay.");
    if (!this.demoToken || !this.staffToken) {
      throw new Error("Load both the operator demo and staff credentials before queueing a duplicate delivery.");
    }
    const queued = await this.request(`/api/v1/passports/${this.caseId}/release-task-replays`, {
      method: "POST",
      body: JSON.stringify({ idempotency_key: uniqueKey("release-replay") }),
      headers: {
        "X-Found-Roll-Demo-Token": this.demoToken,
        "X-Found-Roll-Staff-Token": this.staffToken,
      },
    });
    const task = queued.task;
    if (task?.mode === "inline") {
      if (!task.payload) throw new Error("The local replay receipt is missing its opaque payload.");
      return this.request("/tasks/outbox", {
        method: "POST",
        body: JSON.stringify(task.payload),
        headers: { "X-CloudTasks-TaskName": task.task_name },
      });
    }
    if (task?.mode !== "cloud_tasks" || !task.queued || !task.task_name) {
      throw new Error("The custody service returned an incomplete replay task receipt.");
    }
    const baseline = Number(queued.baseline_replay_count || 0);
    const started = Date.now();
    while (Date.now() - started < 25_000) {
      const snapshot = await this.snapshot();
      const outbox = (snapshot.outbox || []).find((row) => row.id === this.releaseOutbox.id);
      if (Number(outbox?.replay_count || 0) > baseline) {
        return { case: snapshot.case, outbox, replayed: true, task };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Timed out waiting for the authenticated duplicate Cloud Task delivery.");
  }

  async perform(action, { onQueuedProjection } = {}) {
    if (action.type === "REFRESH") return this.loadProjection();
    if (!this.case) await this.snapshot();
    switch (action.type) {
      case "ANALYZE":
        if (this.case?.analysis_auto_start_armed) {
          throw new Error("This ordinary intake is server-queued after its authorized preview; refresh its authoritative state instead.");
        }
        await this.beginAnalysis();
        break;
      case "SUBMIT_CLAIM":
        {
          const submitted = await this.submitClaim(action.answer || "");
          if (!this.staffToken) return submitted.projection;
        }
        break;
      case "OPEN_CLAIMANT_PROOF":
        if (!this.claimLink?.token) await this.issueClaimLink();
        break;
      case "IMPORT_INTAKE":
        await this.importIntake(action.intake || {}, { onQueuedProjection });
        break;
      case "ATTEST_IDENTITY":
        await this.attestIdentity();
        break;
      case "APPROVE":
        await this.approve();
        break;
      case "RESERVE":
        await this.reserveAndIssueTokens();
        break;
      case "PRESENT_TOKEN": {
        const alreadyAttested = Boolean(this.handoff?.[`${action.role}_attested`]);
        try {
          await this.presentToken(action.role);
        } catch (error) {
          if (alreadyAttested && (error?.status === 409 || error?.status === 422)) {
            this.tokenReplayRejected = true;
            break;
          }
          throw error;
        }
        if (alreadyAttested) throw new Error("The custody service unexpectedly accepted a consumed one-time credential.");
        break;
      }
      case "CONFIRM_HANDOFF":
        await this.releaseAndClose();
        break;
      case "REPLAY_CALLBACK":
        await this.replayReleaseTask();
        this.callbackReplayHandled = true;
        break;
      default:
        throw new Error(`Unsupported custody action: ${action.type}`);
    }
    return this.loadProjection();
  }
}
