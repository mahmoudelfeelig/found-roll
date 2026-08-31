"""Typed custody, event, handoff, and API contracts."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


MAX_LLM_INVOCATIONS = 12


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class CustodyState(StrEnum):
    RECEIVED = "RECEIVED"
    EVIDENCE_READY = "EVIDENCE_READY"
    ANALYZING = "ANALYZING"
    CANDIDATES_READY = "CANDIDATES_READY"
    CLARIFICATION_REQUIRED = "CLARIFICATION_REQUIRED"
    CLAIM_EVIDENCE_ACCEPTED = "CLAIM_EVIDENCE_ACCEPTED"
    IDENTITY_ATTESTED = "IDENTITY_ATTESTED"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    RESERVE_REQUESTED = "RESERVE_REQUESTED"
    RESERVED = "RESERVED"
    CLAIMANT_PRESENT = "CLAIMANT_PRESENT"
    RELEASE_REQUESTED = "RELEASE_REQUESTED"
    RELEASED = "RELEASED"
    CLOSED = "CLOSED"
    SECURITY_ESCALATION = "SECURITY_ESCALATION"
    NO_MATCH = "NO_MATCH"
    MANUAL_REVIEW = "MANUAL_REVIEW"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED"


class RiskTier(StrEnum):
    ORDINARY = "ORDINARY"
    VALUABLE = "VALUABLE"
    SENSITIVE = "SENSITIVE"
    DANGEROUS = "DANGEROUS"


class PolicyOutcome(StrEnum):
    DENY = "DENY"
    REQUEST_EVIDENCE = "REQUEST_EVIDENCE"
    REQUIRE_REVIEW = "REQUIRE_REVIEW"
    ALLOW_HANDOFF = "ALLOW_HANDOFF"


class OutboxKind(StrEnum):
    ANALYZE_CASE = "ANALYZE_CASE"
    RESERVE_RELAY = "RESERVE_RELAY"
    RELEASE_RELAY = "RELEASE_RELAY"


class OutboxStatus(StrEnum):
    PENDING = "PENDING"
    DISPATCHED = "DISPATCHED"
    COMPLETE = "COMPLETE"
    FAILED = "FAILED"


class OutboxFailureStage(StrEnum):
    PUBLISH = "PUBLISH"
    EXECUTE = "EXECUTE"


class ExecutionClaimDisposition(StrEnum):
    ACQUIRED = "ACQUIRED"
    IN_PROGRESS = "IN_PROGRESS"
    STALE_RECOVERY = "STALE_RECOVERY"


class HandoffStatus(StrEnum):
    PENDING = "PENDING"
    HELD = "HELD"
    RELEASED = "RELEASED"
    EXPIRED = "EXPIRED"


class TokenPurpose(StrEnum):
    CLAIMANT = "CLAIMANT"
    CUSTODIAN = "CUSTODIAN"


class EvidenceOrigin(StrEnum):
    ORIGINAL = "ORIGINAL"
    DERIVED = "DERIVED"


class EvidenceVisibility(StrEnum):
    STAFF_ONLY = "STAFF_ONLY"
    MODEL_AUTHORIZED = "MODEL_AUTHORIZED"


class EvidenceProvenance(BaseModel):
    """Immutable link from a stored image to its source and transform."""

    model_config = ConfigDict(extra="forbid")

    origin: EvidenceOrigin
    source_evidence_id: str | None = None
    transform: str

    @model_validator(mode="after")
    def source_matches_origin(self) -> "EvidenceProvenance":
        if self.origin == EvidenceOrigin.ORIGINAL and self.source_evidence_id is not None:
            raise ValueError("original evidence cannot cite a source evidence record")
        if self.origin == EvidenceOrigin.DERIVED and not self.source_evidence_id:
            raise ValueError("derived evidence must cite its source evidence record")
        return self


class EvidenceRecord(BaseModel):
    """Metadata-only evidence contract; bytes are available only through staff storage APIs."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^evd-[a-f0-9]{32}$")
    case_id: str
    workflow_epoch: str = Field(default="legacy", min_length=1, max_length=160)
    object_name: str
    storage_uri: str
    provenance: EvidenceProvenance
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    generation: int = Field(ge=1)
    mime_type: Literal["image/jpeg", "image/png"]
    byte_size: int = Field(ge=1)
    visibility: EvidenceVisibility
    idempotency_key_hash: str | None = Field(
        default=None,
        pattern=r"^[a-f0-9]{64}$",
        exclude=True,
    )
    command_fingerprint: str | None = Field(
        default=None,
        pattern=r"^[a-f0-9]{64}$",
        exclude=True,
    )
    created_at: datetime = Field(default_factory=utc_now)


class AgentToolOutcome(BaseModel):
    """Sanitized evidence from one observed ADK function response."""

    model_config = ConfigDict(extra="forbid")

    name: Literal[
        "search_custodian",
        "load_candidate",
        "submit_observations",
        "propose_discriminator",
        "request_manual_review",
    ]
    outcome: Literal["success", "denied", "abstained", "unavailable"]


class AgentExecutionEvidence(BaseModel):
    """Identifier-only execution evidence safe to persist with the passport."""

    model_config = ConfigDict(extra="forbid")

    trace_id: str = Field(min_length=1, max_length=200)
    invocation_count: int = Field(ge=1, le=MAX_LLM_INVOCATIONS)
    tool_trajectory: list[AgentToolOutcome] = Field(min_length=1, max_length=12)
    typed_output_valid: bool


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    tenant_name: str
    category: str
    coarse_description: str
    found_at: datetime
    found_zone: str
    availability: Literal["AVAILABLE", "HELD", "RELEASED"] = "AVAILABLE"
    public_signals: list[str]
    route_compatible: bool
    time_compatible: bool
    visible_signal_count: int = Field(ge=0)
    frozen_score: float = Field(ge=0, le=1)
    remote_etag: str
    remote_version: int = Field(ge=0)
    restricted_attribute_id: str | None = Field(default=None, exclude=True)
    restricted_value_hash: str | None = Field(default=None, exclude=True)


class CaseRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    workflow_epoch: str = "legacy"
    state: CustodyState
    version: int = Field(ge=0)
    category: str
    risk_tier: RiskTier
    assigned_tenant: str
    current_holder: str
    public_description: str
    found_at: datetime
    found_zone: str
    report_route: list[str]
    candidate_ids: list[str] = Field(default_factory=list)
    selected_item_id: str | None = None
    accepted_claim_evidence: bool = False
    identity_attestation_ref: str | None = None
    approval_ref: str | None = None
    wrong_answer_count: int = 0
    next_question: str | None = None
    policy_outcome: PolicyOutcome = PolicyOutcome.REQUEST_EVIDENCE
    policy_version: str = "found-roll-release-v1"
    handoff_id: str | None = None
    model_run_id: str | None = None
    model_trace_id: str | None = None
    model_name: str | None = None
    model_mode: str | None = None
    model_invocation_count: int | None = Field(default=None, ge=0, le=MAX_LLM_INVOCATIONS)
    model_tool_trajectory: list[AgentToolOutcome] = Field(default_factory=list, max_length=12)
    model_typed_output_valid: bool = False
    # Only ordinary intakes created through the combined demo-and-staff boundary
    # may enqueue their first bounded analysis after staff explicitly authorizes
    # the derived preview. Existing persisted cases remain safely unarmed.
    analysis_auto_start_armed: bool = False
    last_event_hash: str = "0" * 64
    last_event_sequence: int = 0
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class EventRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    case_id: str
    sequence: int = Field(ge=1)
    type: str
    actor: str
    from_state: CustodyState
    to_state: CustodyState
    reason: str
    evidence_refs: list[str] = Field(default_factory=list)
    tool: str | None = None
    task_id: str | None = None
    model_run_id: str | None = None
    simulator_attestation_id: str | None = None
    idempotency_key: str
    occurred_at: datetime
    previous_hash: str
    event_hash: str


class OutboxRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    task_name: str
    kind: OutboxKind
    case_id: str
    expected_case_version: int
    status: OutboxStatus = OutboxStatus.PENDING
    attempt: int = 0
    created_at: datetime = Field(default_factory=utc_now)
    completed_at: datetime | None = None
    result_attestation_id: str | None = None
    failure_stage: OutboxFailureStage | None = None
    failure_code: str | None = Field(default=None, pattern=r"^[a-z0-9_]{3,80}$")
    replay_count: int = Field(default=0, ge=0)
    last_replayed_at: datetime | None = None
    last_replay_task_name: str | None = Field(default=None, max_length=1024)


class OutboxExecutionClaim(BaseModel):
    """Internal single-flight lease for one outbox execution.

    The raw winner token is never persisted. A stale lease is replaced only so
    the replacement owner can terminalize the ambiguous run without invoking
    the analyst again.
    """

    model_config = ConfigDict(extra="forbid")

    outbox_id: str
    case_id: str
    token_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    claimed_at: datetime
    lease_expires_at: datetime
    recovery_required: bool = False
    terminal_status: OutboxStatus | None = None
    completed_at: datetime | None = None

    @model_validator(mode="after")
    def lease_and_terminal_state_are_consistent(self) -> "OutboxExecutionClaim":
        if self.lease_expires_at <= self.claimed_at:
            raise ValueError("execution claim lease must expire after it is acquired")
        if self.terminal_status not in {None, OutboxStatus.COMPLETE, OutboxStatus.FAILED}:
            raise ValueError("execution claim terminal status must be COMPLETE or FAILED")
        if (self.terminal_status is None) != (self.completed_at is None):
            raise ValueError("execution claim terminal status and completion time must be set together")
        return self


class HandoffRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    case_id: str
    item_id: str
    provider: str = "Relay Post (SIMULATED)"
    reservation_id: str | None = None
    simulator_request_id: str | None = None
    status: HandoffStatus = HandoffStatus.PENDING
    reservation_case_version: int = Field(ge=1)
    remote_etag: str
    remote_version: int = Field(ge=0)
    expires_at: datetime | None = None
    claimant_token_hash: str | None = Field(default=None, exclude=True)
    custodian_token_hash: str | None = Field(default=None, exclude=True)
    claimant_attested_at: datetime | None = None
    custodian_attested_at: datetime | None = None
    staff_confirmed_at: datetime | None = None
    tokens_issued: bool = False
    simulated: Literal[True] = True


class TokenRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token_hash: str
    case_id: str
    handoff_id: str
    item_id: str
    purpose: TokenPurpose
    issued_at: datetime
    expires_at: datetime
    used_at: datetime | None = None


class ClaimLinkRecord(BaseModel):
    """One-time claimant proof grant; only keyed digests and metadata persist."""

    model_config = ConfigDict(extra="forbid")

    token_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    issuance_key_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    command_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    case_id: str
    issued_case_version: int = Field(ge=0)
    issued_at: datetime
    expires_at: datetime
    used_at: datetime | None = None
    superseded_at: datetime | None = None

    @model_validator(mode="after")
    def expiry_follows_issue(self) -> "ClaimLinkRecord":
        if self.expires_at <= self.issued_at:
            raise ValueError("claim link expiry must follow issuance")
        return self


class IdempotencyRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    case_id: str | None = None
    fingerprint: str
    response: dict[str, Any]
    created_at: datetime


ANALYSIS_PROPOSAL_SCHEMA_VERSION = "found-roll-analysis-proposal-v1"


class AnalysisProposal(BaseModel):
    """Proposal-only model output. It contains no release authority or answer."""

    model_config = ConfigDict(extra="forbid")

    ranked_candidate_ids: list[str] = Field(min_length=1, max_length=5)
    selected_candidate_id: str | None
    visible_signals: list[str] = Field(max_length=8)
    # google-genai 2.20.0 rejects non-string Literal values while translating
    # an ADK output schema for Vertex AI. Keep the transport schema boolean and
    # enforce the same fail-closed invariant during typed validation instead.
    evidence_sufficient_for_claim: bool = Field(default=False, strict=True)
    restricted_attribute_id: str
    next_question: str = Field(min_length=12, max_length=240)
    manual_review_reason: str | None = None
    tool_trajectory: list[str] = Field(min_length=1, max_length=12)

    @field_validator("evidence_sufficient_for_claim")
    @classmethod
    def evidence_can_never_authorize_a_claim(cls, value: bool) -> bool:
        if value is not False:
            raise ValueError("the analyst cannot declare evidence sufficient for a claim")
        return value

    @field_validator("next_question")
    @classmethod
    def question_must_not_contain_numeric_answer(cls, value: str) -> str:
        compact = "".join(ch for ch in value if ch.isalnum())
        if any(compact[index : index + 4].isdigit() for index in range(max(0, len(compact) - 3))):
            raise ValueError("claimant question must not contain a four-digit answer")
        return value


class PolicyDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: PolicyOutcome
    policy_version: str = "found-roll-release-v1"
    reason_codes: list[str]
    next_action: str


class MutationReceipt(BaseModel):
    case_id: str
    event_id: str
    event_sequence: int
    state: CustodyState
    version: int


class AppliedMutation(BaseModel):
    receipt: MutationReceipt
    event: EventRecord
    duplicate: bool = False


class OpaqueTaskPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1"] = "1"
    case_id: str
    outbox_id: str


class RelayAttestation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1"] = "1"
    attestation_id: str
    operation: Literal["RESERVE", "RELEASE"]
    status: Literal["HELD", "RELEASED"]
    case_id: str
    item_id: str
    outbox_id: str
    reservation_id: str
    remote_etag: str
    remote_version: int = Field(ge=0)
    expected_case_version: int
    occurred_at: datetime
    expires_at: datetime | None = None
    simulated: Literal[True]

    @model_validator(mode="after")
    def operation_matches_status(self) -> "RelayAttestation":
        expected = "HELD" if self.operation == "RESERVE" else "RELEASED"
        if self.status != expected:
            raise ValueError("attestation operation and status disagree")
        return self


class SimulationDisclosure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["SIMULATED"]
    notice: str = Field(min_length=8, max_length=500)


class SimulatorHandoffCallback(BaseModel):
    """Exact signed callback body emitted by the separate relay simulator."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1"] = "1"
    event_id: str
    event_type: Literal["SIMULATED_TOKEN_HANDOFF_ATTESTED"]
    simulation: SimulationDisclosure
    reservation_id: str
    case_id: str
    case_version: int = Field(ge=0)
    item_id: str
    custodian_id: str
    reservation_version: int = Field(ge=0)
    item_version: int = Field(ge=0)
    occurred_at: datetime
    attestation_statement: str = Field(min_length=8, max_length=500)


class EventManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1"] = "1"
    manifest_id: str
    case_id: str
    final_state: Literal[CustodyState.CLOSED]
    final_version: int
    event_count: int
    first_event_hash: str
    final_event_hash: str
    event_ids: list[str]
    evidence_digests: list[str]
    internally_consistent: Literal[True] = True
    physical_transfer_proven: Literal[False] = False
    disclosure: str = (
        "This application-enforced manifest checks service event consistency. "
        "It does not prove physical possession or a real-world transfer."
    )


class CaseView(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    workflow_epoch: str
    state: CustodyState
    version: int
    category: str
    risk_tier: RiskTier
    assigned_tenant: str
    current_holder: str
    public_description: str
    found_at: datetime
    found_zone: str
    report_route: list[str]
    candidate_ids: list[str]
    selected_item_id: str | None
    accepted_claim_evidence: bool
    identity_attested: bool
    approval_recorded: bool
    wrong_answer_count: int
    next_question: str | None
    policy_outcome: PolicyOutcome
    policy_version: str
    handoff_id: str | None
    model_run_id: str | None
    model_trace_id: str | None
    model_name: str | None
    model_mode: str | None
    model_invocation_count: int | None
    model_tool_trajectory: list[AgentToolOutcome]
    model_typed_output_valid: bool
    analysis_auto_start_armed: bool
    event_count: int
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, case: CaseRecord) -> "CaseView":
        return cls(
            id=case.id,
            workflow_epoch=case.workflow_epoch,
            state=case.state,
            version=case.version,
            category=case.category,
            risk_tier=case.risk_tier,
            assigned_tenant=case.assigned_tenant,
            current_holder=case.current_holder,
            public_description=case.public_description,
            found_at=case.found_at,
            found_zone=case.found_zone,
            report_route=case.report_route,
            candidate_ids=case.candidate_ids,
            selected_item_id=case.selected_item_id,
            accepted_claim_evidence=case.accepted_claim_evidence,
            identity_attested=case.identity_attestation_ref is not None,
            approval_recorded=case.approval_ref is not None,
            wrong_answer_count=case.wrong_answer_count,
            next_question=case.next_question,
            policy_outcome=case.policy_outcome,
            policy_version=case.policy_version,
            handoff_id=case.handoff_id,
            model_run_id=case.model_run_id,
            model_trace_id=case.model_trace_id,
            model_name=case.model_name,
            model_mode=case.model_mode,
            model_invocation_count=case.model_invocation_count,
            model_tool_trajectory=case.model_tool_trajectory,
            model_typed_output_valid=case.model_typed_output_valid,
            analysis_auto_start_armed=case.analysis_auto_start_armed,
            event_count=case.last_event_sequence,
            created_at=case.created_at,
            updated_at=case.updated_at,
        )


class ClaimantLinkView(BaseModel):
    """Non-secret metadata for the one claimant link held by this browser."""

    model_config = ConfigDict(extra="forbid")

    active: bool
    issued_case_version: int = Field(ge=0)
    issued_at: datetime | None = None
    expires_at: datetime | None = None


class ClaimantCaseProjection(BaseModel):
    """Purpose-built claimant view; staff custody and matching fields are absent."""

    model_config = ConfigDict(extra="forbid")

    id: str
    state: CustodyState
    version: int = Field(ge=0)
    public_description: str
    found_date_label: str
    route_label: str
    synthetic_custodian_label: Literal["Participating custodian (SIMULATED)"] = (
        "Participating custodian (SIMULATED)"
    )
    next_question: str | None
    attempt_count: int = Field(ge=0)
    link: ClaimantLinkView

    @classmethod
    def from_record(
        cls,
        case: CaseRecord,
        *,
        link: ClaimantLinkView,
    ) -> "ClaimantCaseProjection":
        found_at = case.found_at
        if found_at.tzinfo is None:
            found_at = found_at.replace(tzinfo=timezone.utc)
        found_date = found_at.astimezone(timezone.utc).date().isoformat()
        route_count = len(case.report_route)
        route_label = f"{route_count} reported route stop{'s' if route_count != 1 else ''}"
        return cls(
            id=case.id,
            state=case.state,
            version=case.version,
            public_description=case.public_description,
            found_date_label=f"{found_date} UTC",
            route_label=route_label,
            next_question=case.next_question,
            attempt_count=case.wrong_answer_count,
            link=link,
        )


class HandoffView(BaseModel):
    id: str
    case_id: str
    item_id: str
    provider: str
    reservation_id: str | None
    simulator_request_id: str | None
    status: HandoffStatus
    reservation_case_version: int = Field(ge=1)
    remote_etag: str
    remote_version: int = Field(ge=0)
    expires_at: datetime | None
    claimant_attested: bool
    custodian_attested: bool
    staff_confirmed: bool
    tokens_issued: bool
    simulated: Literal[True]

    @classmethod
    def from_record(cls, handoff: HandoffRecord) -> "HandoffView":
        return cls(
            id=handoff.id,
            case_id=handoff.case_id,
            item_id=handoff.item_id,
            provider=handoff.provider,
            reservation_id=handoff.reservation_id,
            simulator_request_id=handoff.simulator_request_id,
            status=handoff.status,
            reservation_case_version=handoff.reservation_case_version,
            remote_etag=handoff.remote_etag,
            remote_version=handoff.remote_version,
            expires_at=handoff.expires_at,
            claimant_attested=handoff.claimant_attested_at is not None,
            custodian_attested=handoff.custodian_attested_at is not None,
            staff_confirmed=handoff.staff_confirmed_at is not None,
            tokens_issued=handoff.tokens_issued,
            simulated=handoff.simulated,
        )
