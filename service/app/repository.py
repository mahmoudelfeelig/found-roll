"""Repository contract, deterministic demo store, and Firestore adapter."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock
from typing import Any, Protocol
from uuid import NAMESPACE_URL, uuid5

from .domain import (
    AppliedMutation,
    Candidate,
    CaseRecord,
    ClaimLinkRecord,
    CustodyState,
    EventRecord,
    HandoffRecord,
    IdempotencyRecord,
    MutationReceipt,
    OutboxRecord,
    OutboxFailureStage,
    OutboxStatus,
    TokenPurpose,
    TokenRecord,
)
from .config import SYNTHETIC_FIRESTORE_NAMESPACE_SUFFIX
from .errors import Conflict, Forbidden, NotFound, Unavailable
from .hashing import secure_equal, sha256_hex
from .state_machine import assert_transition


@dataclass(slots=True)
class MutationSpec:
    case_id: str
    expected_version: int
    target_state: CustodyState
    event_type: str
    actor: str
    reason: str
    idempotency_key: str
    fingerprint: str
    occurred_at: datetime
    updates: dict[str, Any] = field(default_factory=dict)
    evidence_refs: list[str] = field(default_factory=list)
    tool: str | None = None
    task_id: str | None = None
    model_run_id: str | None = None
    simulator_attestation_id: str | None = None
    outbox: OutboxRecord | None = None
    handoff: HandoffRecord | None = None
    tokens: list[TokenRecord] = field(default_factory=list)
    allow_fact_event: bool = False


@dataclass(slots=True)
class ClaimLinkIssue:
    record: ClaimLinkRecord
    duplicate: bool
    active: bool


@dataclass(slots=True)
class ClaimEvidenceCommit:
    case: CaseRecord
    events: list[EventRecord]
    accepted: bool
    duplicate: bool


class Repository(Protocol):
    def reset(self) -> None: ...

    def replace_synthetic_fixture(
        self,
        case: CaseRecord,
        candidates: list[Candidate],
        *,
        actor: str,
        reason: str,
        idempotency_key: str,
        occurred_at: datetime,
    ) -> AppliedMutation: ...

    def create_case(
        self,
        case: CaseRecord,
        candidates: list[Candidate],
        *,
        actor: str,
        reason: str,
        idempotency_key: str,
        occurred_at: datetime,
        fingerprint: str | None = None,
    ) -> AppliedMutation: ...

    def get_case(self, case_id: str) -> CaseRecord: ...

    def list_cases(self) -> list[CaseRecord]: ...

    def get_candidate(self, candidate_id: str) -> Candidate: ...

    def list_candidates(self, candidate_ids: list[str] | None = None) -> list[Candidate]: ...

    def list_events(self, case_id: str) -> list[EventRecord]: ...

    def get_event(self, case_id: str, event_id: str) -> EventRecord: ...

    def apply_mutation(self, spec: MutationSpec) -> AppliedMutation: ...

    def get_outbox(self, outbox_id: str) -> OutboxRecord: ...

    def list_outboxes(self, case_id: str | None = None) -> list[OutboxRecord]: ...

    def mark_outbox(
        self,
        outbox_id: str,
        status: OutboxStatus,
        *,
        result_attestation_id: str | None = None,
        completed_at: datetime | None = None,
        failure_stage: OutboxFailureStage | None = None,
        failure_code: str | None = None,
    ) -> OutboxRecord: ...

    def record_outbox_replay(
        self,
        outbox_id: str,
        *,
        occurred_at: datetime,
        delivery_task_name: str | None,
    ) -> OutboxRecord: ...

    def get_handoff(self, handoff_id: str) -> HandoffRecord: ...

    def issue_claim_link(
        self,
        record: ClaimLinkRecord,
        *,
        occurred_at: datetime,
    ) -> ClaimLinkIssue: ...

    def inspect_claim_link(
        self,
        *,
        case_id: str,
        token_hash: str,
        occurred_at: datetime,
    ) -> ClaimLinkRecord: ...

    def consume_claim_link_and_apply_mutations(
        self,
        *,
        case_id: str,
        token_hash: str,
        idempotency_key: str,
        fingerprint: str,
        occurred_at: datetime,
        specs: list[MutationSpec],
        accepted: bool,
    ) -> ClaimEvidenceCommit: ...

    def consume_token(
        self,
        *,
        case_id: str,
        handoff_id: str,
        token_hash: str,
        purpose: TokenPurpose,
        expected_version: int,
        target_state: CustodyState,
        actor: str,
        idempotency_key: str,
        fingerprint: str,
        occurred_at: datetime,
        remote_etag: str | None = None,
        remote_version: int | None = None,
    ) -> AppliedMutation: ...


def _event_id(case_id: str, idempotency_key: str) -> str:
    return f"evt-{uuid5(NAMESPACE_URL, f'found-roll:{case_id}:{idempotency_key}').hex[:24]}"


def _make_event(case: CaseRecord, spec: MutationSpec) -> EventRecord:
    sequence = case.last_event_sequence + 1
    event_id = _event_id(case.id, spec.idempotency_key)
    unsigned = {
        "id": event_id,
        "case_id": case.id,
        "sequence": sequence,
        "type": spec.event_type,
        "actor": spec.actor,
        "from_state": case.state.value,
        "to_state": spec.target_state.value,
        "reason": spec.reason,
        "evidence_refs": spec.evidence_refs,
        "tool": spec.tool,
        "task_id": spec.task_id,
        "model_run_id": spec.model_run_id,
        "simulator_attestation_id": spec.simulator_attestation_id,
        "idempotency_key": spec.idempotency_key,
        "occurred_at": spec.occurred_at,
        "previous_hash": case.last_event_hash,
    }
    return EventRecord(**unsigned, event_hash=sha256_hex(unsigned))


def _receipt(event: EventRecord, case: CaseRecord) -> MutationReceipt:
    return MutationReceipt(
        case_id=case.id,
        event_id=event.id,
        event_sequence=event.sequence,
        state=case.state,
        version=case.version,
    )


def _project_mutations(
    current: CaseRecord,
    specs: list[MutationSpec],
) -> tuple[CaseRecord, list[EventRecord]]:
    if not specs:
        raise ValueError("claim evidence commit requires at least one mutation")
    events: list[EventRecord] = []
    projected = current
    for spec in specs:
        if spec.case_id != projected.id:
            raise ValueError("claim evidence mutation does not belong to the Item Passport")
        if spec.expected_version != projected.version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {spec.expected_version}; current version is {projected.version}.",
            )
        if spec.outbox or spec.handoff or spec.tokens:
            raise ValueError("claim evidence mutations cannot attach custody side records")
        illegal = set(spec.updates) - set(CaseRecord.model_fields)
        if illegal:
            raise ValueError(f"unsupported case update fields: {sorted(illegal)}")
        assert_transition(projected.state, spec.target_state, allow_fact_event=spec.allow_fact_event)
        event = _make_event(projected, spec)
        projected = CaseRecord.model_validate(
            projected.model_copy(
                update={
                    **spec.updates,
                    "state": spec.target_state,
                    "version": projected.version + 1,
                    "last_event_sequence": event.sequence,
                    "last_event_hash": event.event_hash,
                    "updated_at": spec.occurred_at,
                }
            )
        )
        events.append(event)
    return projected, events


class InMemoryRepository:
    """Thread-safe canonical demo repository with transactional command commits."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._cases: dict[str, CaseRecord] = {}
        self._candidates: dict[str, Candidate] = {}
        self._events: dict[str, list[EventRecord]] = {}
        self._idempotency: dict[str, IdempotencyRecord] = {}
        self._outboxes: dict[str, OutboxRecord] = {}
        self._handoffs: dict[str, HandoffRecord] = {}
        self._tokens: dict[str, TokenRecord] = {}
        self._claim_links: dict[str, ClaimLinkRecord] = {}
        self._claim_link_issuances: dict[str, ClaimLinkRecord] = {}

    def reset(self) -> None:
        with self._lock:
            self._cases.clear()
            self._candidates.clear()
            self._events.clear()
            self._idempotency.clear()
            self._outboxes.clear()
            self._handoffs.clear()
            self._tokens.clear()
            self._claim_links.clear()
            self._claim_link_issuances.clear()

    def replace_synthetic_fixture(
        self,
        case: CaseRecord,
        candidates: list[Candidate],
        *,
        actor: str,
        reason: str,
        idempotency_key: str,
        occurred_at: datetime,
    ) -> AppliedMutation:
        """Replace only the named synthetic fixture, preserving unrelated records."""

        candidate_ids = {candidate.id for candidate in candidates}
        with self._lock:
            self._cases.pop(case.id, None)
            self._events.pop(case.id, None)
            for candidate_id in candidate_ids:
                self._candidates.pop(candidate_id, None)
            self._outboxes = {
                key: row for key, row in self._outboxes.items() if row.case_id != case.id
            }
            self._handoffs = {
                key: row for key, row in self._handoffs.items() if row.case_id != case.id
            }
            self._tokens = {
                key: row for key, row in self._tokens.items() if row.case_id != case.id
            }
            self._claim_links.pop(case.id, None)
            self._claim_link_issuances = {
                key: row
                for key, row in self._claim_link_issuances.items()
                if row.case_id != case.id
            }
            retained_idempotency: dict[str, IdempotencyRecord] = {}
            for key, row in self._idempotency.items():
                response_case_id = row.case_id or row.response.get("case_id")
                if response_case_id != case.id:
                    retained_idempotency[key] = row
            self._idempotency = retained_idempotency
            return self.create_case(
                case,
                candidates,
                actor=actor,
                reason=reason,
                idempotency_key=idempotency_key,
                occurred_at=occurred_at,
            )

    def _clone(self, model: Any) -> Any:
        return model.model_copy(deep=True)

    def create_case(
        self,
        case: CaseRecord,
        candidates: list[Candidate],
        *,
        actor: str,
        reason: str,
        idempotency_key: str,
        occurred_at: datetime,
        fingerprint: str | None = None,
    ) -> AppliedMutation:
        with self._lock:
            command_fingerprint = fingerprint or sha256_hex({"case_id": case.id, "reason": reason})
            existing = self._idempotency.get(idempotency_key)
            if existing:
                if existing.fingerprint != command_fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                receipt = MutationReceipt.model_validate(existing.response)
                stored_case = self._cases.get(receipt.case_id)
                if stored_case is None or stored_case.version < 1:
                    raise Conflict(
                        "idempotency_receipt_invalid",
                        "The completed intake receipt is missing its committed Item Passport.",
                    )
                return AppliedMutation(
                    receipt=receipt,
                    event=self.get_event(receipt.case_id, receipt.event_id),
                    duplicate=True,
                )
            if case.id in self._cases:
                raise Conflict("case_exists", "An Item Passport with this identifier already exists.")
            base = case.model_copy(update={"version": 0, "last_event_sequence": 0, "last_event_hash": "0" * 64})
            spec = MutationSpec(
                case_id=case.id,
                expected_version=0,
                target_state=CustodyState.RECEIVED,
                event_type="ITEM_PASSPORT_CREATED",
                actor=actor,
                reason=reason,
                idempotency_key=idempotency_key,
                fingerprint=command_fingerprint,
                occurred_at=occurred_at,
                allow_fact_event=True,
            )
            event = _make_event(base, spec)
            updated = CaseRecord.model_validate(
                base.model_copy(
                    update={
                        "state": CustodyState.RECEIVED,
                        "version": 1,
                        "last_event_sequence": event.sequence,
                        "last_event_hash": event.event_hash,
                        "updated_at": occurred_at,
                    }
                )
            )
            receipt = _receipt(event, updated)
            idempotency = IdempotencyRecord(
                key=idempotency_key,
                case_id=case.id,
                fingerprint=command_fingerprint,
                response=receipt.model_dump(mode="json"),
                created_at=occurred_at,
            )

            # Build the complete next state before publishing any of it. This keeps
            # a failed intake from exposing the version-0 base passport to readers.
            next_cases = {**self._cases, case.id: updated}
            next_candidates = dict(self._candidates)
            for candidate in candidates:
                next_candidates[candidate.id] = self._clone(candidate)
            next_events = {**self._events, case.id: [event]}
            next_idempotency = {**self._idempotency, idempotency_key: idempotency}
            self._cases = next_cases
            self._candidates = next_candidates
            self._events = next_events
            self._idempotency = next_idempotency
            return AppliedMutation(receipt=receipt, event=self._clone(event), duplicate=False)

    def get_case(self, case_id: str) -> CaseRecord:
        with self._lock:
            case = self._cases.get(case_id)
            if not case:
                raise NotFound("Item Passport")
            return self._clone(case)

    def list_cases(self) -> list[CaseRecord]:
        with self._lock:
            return [self._clone(case) for case in sorted(self._cases.values(), key=lambda item: item.id)]

    def get_candidate(self, candidate_id: str) -> Candidate:
        with self._lock:
            candidate = self._candidates.get(candidate_id)
            if not candidate:
                raise NotFound("Candidate")
            return self._clone(candidate)

    def list_candidates(self, candidate_ids: list[str] | None = None) -> list[Candidate]:
        with self._lock:
            ids = candidate_ids if candidate_ids is not None else sorted(self._candidates)
            return [self._clone(self._candidates[item_id]) for item_id in ids if item_id in self._candidates]

    def list_events(self, case_id: str) -> list[EventRecord]:
        with self._lock:
            if case_id not in self._cases:
                raise NotFound("Item Passport")
            return [self._clone(event) for event in self._events.get(case_id, [])]

    def get_event(self, case_id: str, event_id: str) -> EventRecord:
        for event in self.list_events(case_id):
            if event.id == event_id:
                return event
        raise NotFound("Custody event")

    def apply_mutation(self, spec: MutationSpec) -> AppliedMutation:
        with self._lock:
            existing = self._idempotency.get(spec.idempotency_key)
            if existing:
                if existing.fingerprint != spec.fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                receipt = MutationReceipt.model_validate(existing.response)
                return AppliedMutation(
                    receipt=receipt,
                    event=self.get_event(spec.case_id, receipt.event_id),
                    duplicate=True,
                )

            current = self._cases.get(spec.case_id)
            if not current:
                raise NotFound("Item Passport")
            if current.version != spec.expected_version:
                raise Conflict(
                    "stale_case_version",
                    f"Expected Item Passport version {spec.expected_version}; current version is {current.version}.",
                )
            assert_transition(current.state, spec.target_state, allow_fact_event=spec.allow_fact_event)

            illegal = set(spec.updates) - set(CaseRecord.model_fields)
            if illegal:
                raise ValueError(f"unsupported case update fields: {sorted(illegal)}")
            event = _make_event(current, spec)
            updated = current.model_copy(
                update={
                    **spec.updates,
                    "state": spec.target_state,
                    "version": current.version + 1,
                    "last_event_sequence": event.sequence,
                    "last_event_hash": event.event_hash,
                    "updated_at": spec.occurred_at,
                }
            )
            updated = CaseRecord.model_validate(updated)

            if spec.outbox:
                if spec.outbox.id in self._outboxes:
                    raise Conflict("outbox_exists", "The deterministic outbox command already exists.")
                if spec.outbox.case_id != spec.case_id or spec.outbox.expected_case_version != updated.version:
                    raise ValueError("outbox does not match the committed Item Passport version")
            if spec.handoff and spec.handoff.case_id != spec.case_id:
                raise ValueError("handoff does not belong to the Item Passport")
            for token in spec.tokens:
                if token.case_id != spec.case_id:
                    raise ValueError("token does not belong to the Item Passport")
                if token.token_hash in self._tokens:
                    raise Conflict("token_hash_exists", "A credential hash collision was detected.")

            self._cases[spec.case_id] = updated
            self._events[spec.case_id].append(event)
            if spec.outbox:
                self._outboxes[spec.outbox.id] = self._clone(spec.outbox)
            if spec.handoff:
                self._handoffs[spec.handoff.id] = self._clone(spec.handoff)
            for token in spec.tokens:
                self._tokens[token.token_hash] = self._clone(token)
            receipt = _receipt(event, updated)
            self._idempotency[spec.idempotency_key] = IdempotencyRecord(
                key=spec.idempotency_key,
                case_id=spec.case_id,
                fingerprint=spec.fingerprint,
                response=receipt.model_dump(mode="json"),
                created_at=spec.occurred_at,
            )
            return AppliedMutation(receipt=receipt, event=self._clone(event), duplicate=False)

    def get_outbox(self, outbox_id: str) -> OutboxRecord:
        with self._lock:
            outbox = self._outboxes.get(outbox_id)
            if not outbox:
                raise NotFound("Outbox command")
            return self._clone(outbox)

    def list_outboxes(self, case_id: str | None = None) -> list[OutboxRecord]:
        with self._lock:
            values = self._outboxes.values()
            if case_id is not None:
                values = [row for row in values if row.case_id == case_id]
            return [self._clone(row) for row in sorted(values, key=lambda item: item.created_at)]

    def mark_outbox(
        self,
        outbox_id: str,
        status: OutboxStatus,
        *,
        result_attestation_id: str | None = None,
        completed_at: datetime | None = None,
        failure_stage: OutboxFailureStage | None = None,
        failure_code: str | None = None,
    ) -> OutboxRecord:
        with self._lock:
            current = self._outboxes.get(outbox_id)
            if not current:
                raise NotFound("Outbox command")
            if current.status == OutboxStatus.COMPLETE:
                return self._clone(current)
            if (
                current.status == OutboxStatus.FAILED
                and current.failure_stage == OutboxFailureStage.EXECUTE
            ):
                return self._clone(current)
            if (
                current.status == OutboxStatus.DISPATCHED
                and status == OutboxStatus.FAILED
                and failure_stage == OutboxFailureStage.PUBLISH
            ):
                return self._clone(current)
            same_marker = (
                current.status == status
                and current.failure_stage == failure_stage
                and current.failure_code == failure_code
            )
            if same_marker:
                return self._clone(current)
            attempts = current.attempt + (
                1 if status == OutboxStatus.DISPATCHED else 0
            )
            updated = current.model_copy(
                update={
                    "status": status,
                    "attempt": attempts,
                    "result_attestation_id": result_attestation_id or current.result_attestation_id,
                    "completed_at": completed_at or current.completed_at,
                    "failure_stage": failure_stage if status == OutboxStatus.FAILED else None,
                    "failure_code": failure_code if status == OutboxStatus.FAILED else None,
                }
            )
            self._outboxes[outbox_id] = updated
            return self._clone(updated)

    def record_outbox_replay(
        self,
        outbox_id: str,
        *,
        occurred_at: datetime,
        delivery_task_name: str | None,
    ) -> OutboxRecord:
        with self._lock:
            current = self._outboxes.get(outbox_id)
            if not current:
                raise NotFound("Outbox command")
            if current.status != OutboxStatus.COMPLETE:
                raise Conflict(
                    "outbox_replay_not_complete",
                    "Only a completed outbox command can record duplicate delivery.",
                )
            updated = current.model_copy(
                update={
                    "replay_count": current.replay_count + 1,
                    "last_replayed_at": occurred_at,
                    "last_replay_task_name": delivery_task_name,
                }
            )
            self._outboxes[outbox_id] = updated
            return self._clone(updated)

    def get_handoff(self, handoff_id: str) -> HandoffRecord:
        with self._lock:
            handoff = self._handoffs.get(handoff_id)
            if not handoff:
                raise NotFound("Handoff")
            return self._clone(handoff)

    @staticmethod
    def _validate_claim_link(
        *,
        case: CaseRecord,
        record: ClaimLinkRecord | None,
        token_hash: str,
        occurred_at: datetime,
        expected_version: int | None = None,
    ) -> ClaimLinkRecord:
        if expected_version is not None and case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        if (
            record is None
            or record.case_id != case.id
            or not secure_equal(record.token_hash, token_hash)
        ):
            raise Conflict(
                "claim_link_invalid",
                "The claimant proof link is invalid for this Item Passport state.",
            )
        if record.used_at is not None:
            raise Conflict("claim_link_replayed", "This claimant proof link has already been used.")
        if record.superseded_at is not None:
            raise Conflict(
                "claim_link_invalid",
                "The claimant proof link is invalid for this Item Passport state.",
            )
        if record.issued_case_version != case.version:
            raise Conflict(
                "claim_link_invalid",
                "The claimant proof link is invalid for this Item Passport state.",
            )
        if occurred_at >= record.expires_at:
            raise Conflict("claim_link_expired", "This claimant proof link has expired.")
        return record

    @staticmethod
    def _claim_link_is_active(
        *,
        case: CaseRecord | None,
        active: ClaimLinkRecord | None,
        record: ClaimLinkRecord,
        occurred_at: datetime,
    ) -> bool:
        return bool(
            case
            and active
            and active.issuance_key_hash == record.issuance_key_hash
            and secure_equal(active.token_hash, record.token_hash)
            and active.used_at is None
            and active.superseded_at is None
            and record.used_at is None
            and record.superseded_at is None
            and record.issued_case_version == case.version
            and occurred_at < record.expires_at
        )

    def issue_claim_link(
        self,
        record: ClaimLinkRecord,
        *,
        occurred_at: datetime,
    ) -> ClaimLinkIssue:
        with self._lock:
            existing = self._claim_link_issuances.get(record.issuance_key_hash)
            if existing:
                if existing.command_fingerprint != record.command_fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                case = self._cases.get(existing.case_id)
                return ClaimLinkIssue(
                    record=self._clone(existing),
                    duplicate=True,
                    active=self._claim_link_is_active(
                        case=case,
                        active=self._claim_links.get(existing.case_id),
                        record=existing,
                        occurred_at=occurred_at,
                    ),
                )
            case = self._cases.get(record.case_id)
            if not case:
                raise NotFound("Item Passport")
            if case.state != CustodyState.CLARIFICATION_REQUIRED:
                raise Conflict(
                    "claim_link_not_allowed",
                    "A claimant proof link can be issued only while private evidence is required.",
                )
            if case.version != record.issued_case_version:
                raise Conflict(
                    "stale_case_version",
                    f"Expected Item Passport version {record.issued_case_version}; current version is {case.version}.",
                )
            previous = self._claim_links.get(record.case_id)
            if previous:
                superseded = previous.model_copy(update={"superseded_at": occurred_at})
                self._claim_links[record.case_id] = superseded
                self._claim_link_issuances[previous.issuance_key_hash] = self._clone(superseded)
            self._claim_links[record.case_id] = self._clone(record)
            self._claim_link_issuances[record.issuance_key_hash] = self._clone(record)
            return ClaimLinkIssue(record=self._clone(record), duplicate=False, active=True)

    def inspect_claim_link(
        self,
        *,
        case_id: str,
        token_hash: str,
        occurred_at: datetime,
    ) -> ClaimLinkRecord:
        with self._lock:
            case = self._cases.get(case_id)
            if not case:
                raise Conflict(
                    "claim_link_invalid",
                    "The claimant proof link is invalid for this Item Passport state.",
                )
            record = self._validate_claim_link(
                case=case,
                record=self._claim_links.get(case_id),
                token_hash=token_hash,
                occurred_at=occurred_at,
            )
            return self._clone(record)

    def consume_claim_link_and_apply_mutations(
        self,
        *,
        case_id: str,
        token_hash: str,
        idempotency_key: str,
        fingerprint: str,
        occurred_at: datetime,
        specs: list[MutationSpec],
        accepted: bool,
    ) -> ClaimEvidenceCommit:
        with self._lock:
            existing = self._idempotency.get(idempotency_key)
            if existing:
                if existing.fingerprint != fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                stored_case = CaseRecord.model_validate(existing.response["case"])
                events = [
                    self.get_event(case_id, event_id)
                    for event_id in existing.response["event_ids"]
                ]
                return ClaimEvidenceCommit(
                    case=stored_case,
                    events=events,
                    accepted=bool(existing.response["accepted"]),
                    duplicate=True,
                )
            case = self._cases.get(case_id)
            if not case:
                raise Conflict(
                    "claim_link_invalid",
                    "The claimant proof link is invalid for this Item Passport state.",
                )
            record = self._validate_claim_link(
                case=case,
                record=self._claim_links.get(case_id),
                token_hash=token_hash,
                occurred_at=occurred_at,
                expected_version=specs[0].expected_version if specs else None,
            )
            if case.state != CustodyState.CLARIFICATION_REQUIRED:
                raise Conflict(
                    "claim_evidence_not_expected",
                    "Private claim evidence is not expected in this state.",
                )
            updated_case, events = _project_mutations(case, specs)
            existing_event_ids = {event.id for event in self._events.get(case_id, [])}
            if any(event.id in existing_event_ids for event in events):
                raise Conflict(
                    "idempotency_conflict",
                    "This idempotency key was already used for a different command.",
                )
            consumed = record.model_copy(update={"used_at": occurred_at})
            response = {
                "case_id": case_id,
                "case": updated_case.model_dump(mode="json"),
                "event_ids": [event.id for event in events],
                "accepted": accepted,
            }
            idempotency = IdempotencyRecord(
                key=idempotency_key,
                case_id=case_id,
                fingerprint=fingerprint,
                response=response,
                created_at=occurred_at,
            )
            self._cases[case_id] = updated_case
            self._events[case_id].extend(events)
            self._claim_links[case_id] = consumed
            self._claim_link_issuances[consumed.issuance_key_hash] = self._clone(consumed)
            self._idempotency[idempotency_key] = idempotency
            return ClaimEvidenceCommit(
                case=self._clone(updated_case),
                events=[self._clone(event) for event in events],
                accepted=accepted,
                duplicate=False,
            )

    def consume_token(
        self,
        *,
        case_id: str,
        handoff_id: str,
        token_hash: str,
        purpose: TokenPurpose,
        expected_version: int,
        target_state: CustodyState,
        actor: str,
        idempotency_key: str,
        fingerprint: str,
        occurred_at: datetime,
        remote_etag: str | None = None,
        remote_version: int | None = None,
    ) -> AppliedMutation:
        with self._lock:
            existing = self._idempotency.get(idempotency_key)
            if existing:
                if existing.fingerprint != fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                receipt = MutationReceipt.model_validate(existing.response)
                return AppliedMutation(
                    receipt=receipt,
                    event=self.get_event(case_id, receipt.event_id),
                    duplicate=True,
                )
            token = self._tokens.get(token_hash)
            if not token or token.case_id != case_id or token.handoff_id != handoff_id or token.purpose != purpose:
                raise Conflict("invalid_token", "The one-time credential is invalid for this handoff.")
            if token.used_at is not None:
                raise Conflict("token_replayed", "This one-time credential has already been presented.")
            if occurred_at >= token.expires_at:
                raise Conflict("token_expired", "This one-time credential has expired.")
            handoff = self._handoffs.get(handoff_id)
            if not handoff:
                raise NotFound("Handoff")
            updated_handoff = handoff.model_copy(
                update={
                    "claimant_attested_at": occurred_at
                    if purpose == TokenPurpose.CLAIMANT
                    else handoff.claimant_attested_at,
                    "custodian_attested_at": occurred_at
                    if purpose == TokenPurpose.CUSTODIAN
                    else handoff.custodian_attested_at,
                    "remote_etag": remote_etag or handoff.remote_etag,
                    "remote_version": remote_version
                    if remote_version is not None
                    else handoff.remote_version,
                }
            )
            spec = MutationSpec(
                case_id=case_id,
                expected_version=expected_version,
                target_state=target_state,
                event_type="TOKEN_PRESENTED",
                actor=actor,
                reason=(
                    f"The {purpose.value.lower()} one-time credential was presented. "
                    "This records a service token attestation, not physical possession."
                ),
                idempotency_key=idempotency_key,
                fingerprint=fingerprint,
                occurred_at=occurred_at,
                handoff=updated_handoff,
                allow_fact_event=target_state == self._cases[case_id].state,
            )
            result = self.apply_mutation(spec)
            self._tokens[token_hash] = token.model_copy(update={"used_at": occurred_at})
            return result


class FirestoreRepository:
    """Firestore implementation of the same transaction boundary.

    Imports are lazy so the deterministic local service and tests do not require
    Google credentials. Each custody mutation, event, idempotency receipt, and
    optional outbox/handoff/token write is committed in one Firestore transaction.
    """

    def __init__(self, *, project: str | None, namespace: str = "foundRoll") -> None:
        try:
            from google.cloud import firestore
        except ImportError as exc:  # pragma: no cover - exercised only in cloud mode
            raise Unavailable(
                "firestore_dependency_missing",
                "Install google-cloud-firestore to use the Firestore repository.",
            ) from exc
        self._firestore = firestore
        self._client = firestore.Client(project=project)
        self._prefix = namespace

    def _collection(self, suffix: str):
        return self._client.collection(f"{self._prefix}_{suffix}")

    @staticmethod
    def _storage(model: Any) -> dict[str, Any]:
        data = model.model_dump(mode="python")
        if isinstance(model, Candidate):
            data["restricted_attribute_id"] = model.restricted_attribute_id
            data["restricted_value_hash"] = model.restricted_value_hash
        if isinstance(model, HandoffRecord):
            data["claimant_token_hash"] = model.claimant_token_hash
            data["custodian_token_hash"] = model.custodian_token_hash
        return data

    def reset(self) -> None:
        raise Conflict(
            "firestore_reset_disabled",
            "The HTTP demo reset is intentionally disabled for Firestore; use the scoped fixture reset tool.",
        )

    def replace_synthetic_fixture(
        self,
        case: CaseRecord,
        candidates: list[Candidate],
        *,
        actor: str,
        reason: str,
        idempotency_key: str,
        occurred_at: datetime,
    ) -> AppliedMutation:
        """Atomically replace one frozen fixture inside an explicit synthetic namespace.

        The operation never enumerates or deletes arbitrary database collections. It
        touches only the canonical fixture passport, its nested events, exact fixture
        inventory IDs, and rows whose stored ``case_id`` points at that passport.
        """

        if not self._prefix.endswith(SYNTHETIC_FIRESTORE_NAMESPACE_SUFFIX):
            raise Forbidden(
                "synthetic_namespace_required",
                "The scoped demo reset requires an explicitly synthetic Firestore namespace.",
            )
        if case.id != "FR-20260829-0042" or idempotency_key != "fixture:camera-pouch:create:v1":
            raise Forbidden(
                "synthetic_fixture_scope_invalid",
                "The scoped reset accepts only the frozen Found Roll synthetic fixture.",
            )
        candidate_ids = {candidate.id for candidate in candidates}
        if candidate_ids != {"GH-PCH-104", "ML-PCH-219", "NA-PCH-231"}:
            raise Forbidden(
                "synthetic_fixture_scope_invalid",
                "The scoped reset accepts only the frozen Found Roll synthetic inventory.",
            )

        case_ref = self._collection("passports").document(case.id)
        base = case.model_copy(
            update={"version": 0, "last_event_sequence": 0, "last_event_hash": "0" * 64}
        )
        spec = MutationSpec(
            case_id=case.id,
            expected_version=0,
            target_state=CustodyState.RECEIVED,
            event_type="ITEM_PASSPORT_CREATED",
            actor=actor,
            reason=reason,
            idempotency_key=idempotency_key,
            fingerprint=sha256_hex({"case_id": case.id, "reason": reason}),
            occurred_at=occurred_at,
            allow_fact_event=True,
        )
        event = _make_event(base, spec)
        updated = CaseRecord.model_validate(
            base.model_copy(
                update={
                    "state": CustodyState.RECEIVED,
                    "version": 1,
                    "last_event_sequence": event.sequence,
                    "last_event_hash": event.event_hash,
                    "updated_at": occurred_at,
                }
            )
        )
        receipt = _receipt(event, updated)
        event_ref = case_ref.collection("events").document(event.id)
        idem_ref = self._collection("idempotency").document(sha256_hex(idempotency_key))
        set_paths = {case_ref.path, event_ref.path, idem_ref.path}
        set_paths.update(
            self._collection("inventoryItems").document(candidate.id).path
            for candidate in candidates
        )

        transaction = self._client.transaction()

        @self._firestore.transactional
        def replace(txn):
            # Every query/read happens before the first write. Reading the case and
            # related rows makes concurrent custody or outbox updates conflict and
            # retry rather than leaving an orphaned post-reset event or task row.
            case_ref.get(transaction=txn)
            refs_by_path: dict[str, Any] = {case_ref.path: case_ref}
            for row in case_ref.collection("events").stream(transaction=txn):
                refs_by_path[row.reference.path] = row.reference
            for suffix in (
                "outbox",
                "handoffs",
                "tokens",
                "claimLinks",
                "claimLinkIssuances",
            ):
                query = self._collection(suffix).where("case_id", "==", case.id)
                for row in query.stream(transaction=txn):
                    refs_by_path[row.reference.path] = row.reference
            idempotency_query = self._collection("idempotency").where(
                "response.case_id", "==", case.id
            )
            for row in idempotency_query.stream(transaction=txn):
                refs_by_path[row.reference.path] = row.reference
            for candidate_id in sorted(candidate_ids):
                ref = self._collection("inventoryItems").document(candidate_id)
                ref.get(transaction=txn)
                refs_by_path[ref.path] = ref

            if len(refs_by_path) > 200:
                raise Conflict(
                    "synthetic_reset_scope_too_large",
                    "The bounded synthetic reset exceeded its 200-document safety limit.",
                )

            for path, ref in sorted(refs_by_path.items()):
                if path not in set_paths:
                    txn.delete(ref)
            txn.set(case_ref, self._storage(updated))
            for candidate in candidates:
                txn.set(
                    self._collection("inventoryItems").document(candidate.id),
                    self._storage(candidate),
                )
            txn.set(event_ref, self._storage(event))
            txn.set(
                idem_ref,
                self._storage(
                    IdempotencyRecord(
                        key=idempotency_key,
                        case_id=case.id,
                        fingerprint=spec.fingerprint,
                        response=receipt.model_dump(mode="json"),
                        created_at=occurred_at,
                    )
                ),
            )

        replace(transaction)
        return AppliedMutation(receipt=receipt, event=event, duplicate=False)

    def create_case(
        self,
        case: CaseRecord,
        candidates: list[Candidate],
        *,
        actor: str,
        reason: str,
        idempotency_key: str,
        occurred_at: datetime,
        fingerprint: str | None = None,
    ) -> AppliedMutation:
        case_ref = self._collection("passports").document(case.id)
        command_fingerprint = fingerprint or sha256_hex({"case_id": case.id, "reason": reason})
        base = case.model_copy(
            update={"version": 0, "last_event_sequence": 0, "last_event_hash": "0" * 64}
        )
        spec = MutationSpec(
            case_id=case.id,
            expected_version=0,
            target_state=CustodyState.RECEIVED,
            event_type="ITEM_PASSPORT_CREATED",
            actor=actor,
            reason=reason,
            idempotency_key=idempotency_key,
            fingerprint=command_fingerprint,
            occurred_at=occurred_at,
            allow_fact_event=True,
        )
        event = _make_event(base, spec)
        updated = CaseRecord.model_validate(
            base.model_copy(
                update={
                    "state": CustodyState.RECEIVED,
                    "version": 1,
                    "last_event_sequence": event.sequence,
                    "last_event_hash": event.event_hash,
                    "updated_at": occurred_at,
                }
            )
        )
        receipt = _receipt(event, updated)
        event_ref = case_ref.collection("events").document(event.id)
        idem_ref = self._collection("idempotency").document(sha256_hex(idempotency_key))
        transaction = self._client.transaction()

        @self._firestore.transactional
        def seed(txn):
            idem_snapshot = idem_ref.get(transaction=txn)
            if idem_snapshot.exists:
                record = IdempotencyRecord.model_validate(idem_snapshot.to_dict())
                if record.fingerprint != command_fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                stored_receipt = MutationReceipt.model_validate(record.response)
                stored_case = case_ref.get(transaction=txn)
                stored_event_ref = case_ref.collection("events").document(stored_receipt.event_id)
                stored_event = stored_event_ref.get(transaction=txn)
                if (
                    not stored_case.exists
                    or CaseRecord.model_validate(stored_case.to_dict()).version < 1
                    or not stored_event.exists
                ):
                    raise Conflict(
                        "idempotency_receipt_invalid",
                        "The completed intake receipt is missing its committed custody records.",
                    )
                return (
                    stored_receipt,
                    EventRecord.model_validate(stored_event.to_dict()),
                    True,
                )
            snapshot = case_ref.get(transaction=txn)
            if snapshot.exists:
                raise Conflict("case_exists", "An Item Passport with this identifier already exists.")
            txn.create(case_ref, self._storage(updated))
            for candidate in candidates:
                txn.set(self._collection("inventoryItems").document(candidate.id), self._storage(candidate))
            txn.create(event_ref, self._storage(event))
            txn.create(
                idem_ref,
                self._storage(
                    IdempotencyRecord(
                        key=idempotency_key,
                        case_id=case.id,
                        fingerprint=command_fingerprint,
                        response=receipt.model_dump(mode="json"),
                        created_at=occurred_at,
                    )
                ),
            )
            return receipt, event, False

        stored_receipt, stored_event, duplicate = seed(transaction)
        return AppliedMutation(
            receipt=stored_receipt,
            event=stored_event,
            duplicate=duplicate,
        )

    def get_case(self, case_id: str) -> CaseRecord:
        snapshot = self._collection("passports").document(case_id).get()
        if not snapshot.exists:
            raise NotFound("Item Passport")
        return CaseRecord.model_validate(snapshot.to_dict())

    def list_cases(self) -> list[CaseRecord]:
        return [CaseRecord.model_validate(row.to_dict()) for row in self._collection("passports").stream()]

    def get_candidate(self, candidate_id: str) -> Candidate:
        snapshot = self._collection("inventoryItems").document(candidate_id).get()
        if not snapshot.exists:
            raise NotFound("Candidate")
        return Candidate.model_validate(snapshot.to_dict())

    def list_candidates(self, candidate_ids: list[str] | None = None) -> list[Candidate]:
        if candidate_ids is None:
            return [Candidate.model_validate(row.to_dict()) for row in self._collection("inventoryItems").stream()]
        return [self.get_candidate(candidate_id) for candidate_id in candidate_ids]

    def list_events(self, case_id: str) -> list[EventRecord]:
        self.get_case(case_id)
        query = self._collection("passports").document(case_id).collection("events").order_by("sequence")
        return [EventRecord.model_validate(row.to_dict()) for row in query.stream()]

    def get_event(self, case_id: str, event_id: str) -> EventRecord:
        row = self._collection("passports").document(case_id).collection("events").document(event_id).get()
        if not row.exists:
            raise NotFound("Custody event")
        return EventRecord.model_validate(row.to_dict())

    def apply_mutation(self, spec: MutationSpec) -> AppliedMutation:
        case_ref = self._collection("passports").document(spec.case_id)
        idem_ref = self._collection("idempotency").document(sha256_hex(spec.idempotency_key))
        transaction = self._client.transaction()

        @self._firestore.transactional
        def commit(txn):
            idem = idem_ref.get(transaction=txn)
            if idem.exists:
                record = IdempotencyRecord.model_validate(idem.to_dict())
                if record.fingerprint != spec.fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                return MutationReceipt.model_validate(record.response), True
            snapshot = case_ref.get(transaction=txn)
            if not snapshot.exists:
                raise NotFound("Item Passport")
            current = CaseRecord.model_validate(snapshot.to_dict())
            if current.version != spec.expected_version:
                raise Conflict(
                    "stale_case_version",
                    f"Expected Item Passport version {spec.expected_version}; current version is {current.version}.",
                )
            assert_transition(current.state, spec.target_state, allow_fact_event=spec.allow_fact_event)
            if spec.outbox and (
                spec.outbox.case_id != spec.case_id
                or spec.outbox.expected_case_version != current.version + 1
            ):
                raise ValueError("outbox does not match the committed Item Passport version")
            if spec.handoff and spec.handoff.case_id != spec.case_id:
                raise ValueError("handoff does not belong to the Item Passport")
            if any(token.case_id != spec.case_id for token in spec.tokens):
                raise ValueError("token does not belong to the Item Passport")
            event = _make_event(current, spec)
            updated = CaseRecord.model_validate(
                current.model_copy(
                    update={
                        **spec.updates,
                        "state": spec.target_state,
                        "version": current.version + 1,
                        "last_event_sequence": event.sequence,
                        "last_event_hash": event.event_hash,
                        "updated_at": spec.occurred_at,
                    }
                )
            )
            receipt = _receipt(event, updated)
            txn.set(case_ref, self._storage(updated))
            txn.create(case_ref.collection("events").document(event.id), self._storage(event))
            if spec.outbox:
                txn.create(self._collection("outbox").document(spec.outbox.id), self._storage(spec.outbox))
            if spec.handoff:
                txn.set(self._collection("handoffs").document(spec.handoff.id), self._storage(spec.handoff))
            for token in spec.tokens:
                txn.create(self._collection("tokens").document(token.token_hash), self._storage(token))
            txn.create(
                idem_ref,
                self._storage(
                    IdempotencyRecord(
                        key=spec.idempotency_key,
                        case_id=spec.case_id,
                        fingerprint=spec.fingerprint,
                        response=receipt.model_dump(mode="json"),
                        created_at=spec.occurred_at,
                    )
                ),
            )
            return receipt, False

        receipt, duplicate = commit(transaction)
        return AppliedMutation(
            receipt=receipt,
            event=self.get_event(spec.case_id, receipt.event_id),
            duplicate=duplicate,
        )

    def get_outbox(self, outbox_id: str) -> OutboxRecord:
        row = self._collection("outbox").document(outbox_id).get()
        if not row.exists:
            raise NotFound("Outbox command")
        return OutboxRecord.model_validate(row.to_dict())

    def list_outboxes(self, case_id: str | None = None) -> list[OutboxRecord]:
        query = self._collection("outbox")
        if case_id is not None:
            query = query.where("case_id", "==", case_id)
        return [OutboxRecord.model_validate(row.to_dict()) for row in query.stream()]

    def mark_outbox(
        self,
        outbox_id: str,
        status: OutboxStatus,
        *,
        result_attestation_id: str | None = None,
        completed_at: datetime | None = None,
        failure_stage: OutboxFailureStage | None = None,
        failure_code: str | None = None,
    ) -> OutboxRecord:
        ref = self._collection("outbox").document(outbox_id)
        transaction = self._client.transaction()

        @self._firestore.transactional
        def update(txn):
            row = ref.get(transaction=txn)
            if not row.exists:
                raise NotFound("Outbox command")
            current = OutboxRecord.model_validate(row.to_dict())
            if current.status == OutboxStatus.COMPLETE:
                return current
            if (
                current.status == OutboxStatus.FAILED
                and current.failure_stage == OutboxFailureStage.EXECUTE
            ):
                return current
            if (
                current.status == OutboxStatus.DISPATCHED
                and status == OutboxStatus.FAILED
                and failure_stage == OutboxFailureStage.PUBLISH
            ):
                return current
            same_marker = (
                current.status == status
                and current.failure_stage == failure_stage
                and current.failure_code == failure_code
            )
            if same_marker:
                return current
            updated = current.model_copy(
                update={
                    "status": status,
                    "attempt": current.attempt + (1 if status == OutboxStatus.DISPATCHED else 0),
                    "result_attestation_id": result_attestation_id or current.result_attestation_id,
                    "completed_at": completed_at or current.completed_at,
                    "failure_stage": failure_stage if status == OutboxStatus.FAILED else None,
                    "failure_code": failure_code if status == OutboxStatus.FAILED else None,
                }
            )
            txn.set(ref, self._storage(updated))
            return updated

        return update(transaction)

    def record_outbox_replay(
        self,
        outbox_id: str,
        *,
        occurred_at: datetime,
        delivery_task_name: str | None,
    ) -> OutboxRecord:
        ref = self._collection("outbox").document(outbox_id)
        transaction = self._client.transaction()

        @self._firestore.transactional
        def update(txn):
            row = ref.get(transaction=txn)
            if not row.exists:
                raise NotFound("Outbox command")
            current = OutboxRecord.model_validate(row.to_dict())
            if current.status != OutboxStatus.COMPLETE:
                raise Conflict(
                    "outbox_replay_not_complete",
                    "Only a completed outbox command can record duplicate delivery.",
                )
            updated = current.model_copy(
                update={
                    "replay_count": current.replay_count + 1,
                    "last_replayed_at": occurred_at,
                    "last_replay_task_name": delivery_task_name,
                }
            )
            txn.set(ref, self._storage(updated))
            return updated

        return update(transaction)

    def get_handoff(self, handoff_id: str) -> HandoffRecord:
        row = self._collection("handoffs").document(handoff_id).get()
        if not row.exists:
            raise NotFound("Handoff")
        return HandoffRecord.model_validate(row.to_dict())

    @staticmethod
    def _validate_claim_link(
        *,
        case: CaseRecord,
        record: ClaimLinkRecord | None,
        token_hash: str,
        occurred_at: datetime,
        expected_version: int | None = None,
    ) -> ClaimLinkRecord:
        return InMemoryRepository._validate_claim_link(
            case=case,
            record=record,
            token_hash=token_hash,
            occurred_at=occurred_at,
            expected_version=expected_version,
        )

    def issue_claim_link(
        self,
        record: ClaimLinkRecord,
        *,
        occurred_at: datetime,
    ) -> ClaimLinkIssue:
        case_ref = self._collection("passports").document(record.case_id)
        link_ref = self._collection("claimLinks").document(record.case_id)
        issuance_ref = self._collection("claimLinkIssuances").document(record.issuance_key_hash)
        transaction = self._client.transaction()

        @self._firestore.transactional
        def issue(txn):
            existing_row = issuance_ref.get(transaction=txn)
            case_row = case_ref.get(transaction=txn)
            link_row = link_ref.get(transaction=txn)
            active = ClaimLinkRecord.model_validate(link_row.to_dict()) if link_row.exists else None
            if existing_row.exists:
                existing = ClaimLinkRecord.model_validate(existing_row.to_dict())
                if (
                    existing.case_id != record.case_id
                    or existing.command_fingerprint != record.command_fingerprint
                ):
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                case = CaseRecord.model_validate(case_row.to_dict()) if case_row.exists else None
                return (
                    existing,
                    InMemoryRepository._claim_link_is_active(
                        case=case,
                        active=active,
                        record=existing,
                        occurred_at=occurred_at,
                    ),
                    True,
                )
            if not case_row.exists:
                raise NotFound("Item Passport")
            case = CaseRecord.model_validate(case_row.to_dict())
            if case.state != CustodyState.CLARIFICATION_REQUIRED:
                raise Conflict(
                    "claim_link_not_allowed",
                    "A claimant proof link can be issued only while private evidence is required.",
                )
            if case.version != record.issued_case_version:
                raise Conflict(
                    "stale_case_version",
                    f"Expected Item Passport version {record.issued_case_version}; current version is {case.version}.",
                )
            if active:
                superseded = active.model_copy(update={"superseded_at": occurred_at})
                txn.set(
                    self._collection("claimLinkIssuances").document(active.issuance_key_hash),
                    self._storage(superseded),
                )
            txn.set(issuance_ref, self._storage(record))
            txn.set(link_ref, self._storage(record))
            return record, True, False

        stored, active, duplicate = issue(transaction)
        return ClaimLinkIssue(record=stored, duplicate=duplicate, active=active)

    def inspect_claim_link(
        self,
        *,
        case_id: str,
        token_hash: str,
        occurred_at: datetime,
    ) -> ClaimLinkRecord:
        case_row = self._collection("passports").document(case_id).get()
        link_row = self._collection("claimLinks").document(case_id).get()
        if not case_row.exists:
            raise Conflict(
                "claim_link_invalid",
                "The claimant proof link is invalid for this Item Passport state.",
            )
        case = CaseRecord.model_validate(case_row.to_dict())
        record = ClaimLinkRecord.model_validate(link_row.to_dict()) if link_row.exists else None
        return self._validate_claim_link(
            case=case,
            record=record,
            token_hash=token_hash,
            occurred_at=occurred_at,
        )

    def consume_claim_link_and_apply_mutations(
        self,
        *,
        case_id: str,
        token_hash: str,
        idempotency_key: str,
        fingerprint: str,
        occurred_at: datetime,
        specs: list[MutationSpec],
        accepted: bool,
    ) -> ClaimEvidenceCommit:
        case_ref = self._collection("passports").document(case_id)
        link_ref = self._collection("claimLinks").document(case_id)
        idem_ref = self._collection("idempotency").document(sha256_hex(idempotency_key))
        transaction = self._client.transaction()

        @self._firestore.transactional
        def consume(txn):
            idem_row = idem_ref.get(transaction=txn)
            if idem_row.exists:
                idempotency = IdempotencyRecord.model_validate(idem_row.to_dict())
                if idempotency.fingerprint != fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                stored_case = CaseRecord.model_validate(idempotency.response["case"])
                stored_events: list[EventRecord] = []
                for event_id in idempotency.response["event_ids"]:
                    event_row = case_ref.collection("events").document(event_id).get(transaction=txn)
                    if not event_row.exists:
                        raise Conflict(
                            "idempotency_receipt_invalid",
                            "The completed claim evidence receipt is missing its custody event.",
                        )
                    stored_events.append(EventRecord.model_validate(event_row.to_dict()))
                return (
                    stored_case,
                    stored_events,
                    bool(idempotency.response["accepted"]),
                    True,
                )
            case_row = case_ref.get(transaction=txn)
            link_row = link_ref.get(transaction=txn)
            if not case_row.exists:
                raise Conflict(
                    "claim_link_invalid",
                    "The claimant proof link is invalid for this Item Passport state.",
                )
            case = CaseRecord.model_validate(case_row.to_dict())
            record = ClaimLinkRecord.model_validate(link_row.to_dict()) if link_row.exists else None
            validated = self._validate_claim_link(
                case=case,
                record=record,
                token_hash=token_hash,
                occurred_at=occurred_at,
                expected_version=specs[0].expected_version if specs else None,
            )
            if case.state != CustodyState.CLARIFICATION_REQUIRED:
                raise Conflict(
                    "claim_evidence_not_expected",
                    "Private claim evidence is not expected in this state.",
                )
            updated_case, events = _project_mutations(case, specs)
            consumed = validated.model_copy(update={"used_at": occurred_at})
            response = {
                "case_id": case_id,
                "case": updated_case.model_dump(mode="json"),
                "event_ids": [event.id for event in events],
                "accepted": accepted,
            }
            txn.set(case_ref, self._storage(updated_case))
            for event in events:
                txn.create(case_ref.collection("events").document(event.id), self._storage(event))
            txn.set(link_ref, self._storage(consumed))
            txn.set(
                self._collection("claimLinkIssuances").document(consumed.issuance_key_hash),
                self._storage(consumed),
            )
            txn.create(
                idem_ref,
                self._storage(
                    IdempotencyRecord(
                        key=idempotency_key,
                        case_id=case_id,
                        fingerprint=fingerprint,
                        response=response,
                        created_at=occurred_at,
                    )
                ),
            )
            return updated_case, events, accepted, False

        stored_case, events, stored_accepted, duplicate = consume(transaction)
        return ClaimEvidenceCommit(
            case=stored_case,
            events=events,
            accepted=stored_accepted,
            duplicate=duplicate,
        )

    def consume_token(
        self,
        *,
        case_id: str,
        handoff_id: str,
        token_hash: str,
        purpose: TokenPurpose,
        expected_version: int,
        target_state: CustodyState,
        actor: str,
        idempotency_key: str,
        fingerprint: str,
        occurred_at: datetime,
        remote_etag: str | None = None,
        remote_version: int | None = None,
    ) -> AppliedMutation:
        case_ref = self._collection("passports").document(case_id)
        token_ref = self._collection("tokens").document(token_hash)
        handoff_ref = self._collection("handoffs").document(handoff_id)
        idem_ref = self._collection("idempotency").document(sha256_hex(idempotency_key))
        transaction = self._client.transaction()

        @self._firestore.transactional
        def consume(txn):
            idem_row = idem_ref.get(transaction=txn)
            if idem_row.exists:
                record = IdempotencyRecord.model_validate(idem_row.to_dict())
                if record.fingerprint != fingerprint:
                    raise Conflict(
                        "idempotency_conflict",
                        "This idempotency key was already used for a different command.",
                    )
                return MutationReceipt.model_validate(record.response), True
            case_row = case_ref.get(transaction=txn)
            token_row = token_ref.get(transaction=txn)
            handoff_row = handoff_ref.get(transaction=txn)
            if not case_row.exists:
                raise NotFound("Item Passport")
            if not token_row.exists or not handoff_row.exists:
                raise Conflict("invalid_token", "The one-time credential is invalid for this handoff.")
            current = CaseRecord.model_validate(case_row.to_dict())
            token = TokenRecord.model_validate(token_row.to_dict())
            handoff = HandoffRecord.model_validate(handoff_row.to_dict())
            if current.version != expected_version:
                raise Conflict(
                    "stale_case_version",
                    f"Expected Item Passport version {expected_version}; current version is {current.version}.",
                )
            if token.case_id != case_id or token.handoff_id != handoff_id or token.purpose != purpose:
                raise Conflict("invalid_token", "The one-time credential is invalid for this handoff.")
            if token.used_at is not None:
                raise Conflict("token_replayed", "This one-time credential has already been presented.")
            if occurred_at >= token.expires_at:
                raise Conflict("token_expired", "This one-time credential has expired.")
            assert_transition(
                current.state,
                target_state,
                allow_fact_event=target_state == current.state,
            )
            updated_handoff = handoff.model_copy(
                update={
                    "claimant_attested_at": occurred_at
                    if purpose == TokenPurpose.CLAIMANT
                    else handoff.claimant_attested_at,
                    "custodian_attested_at": occurred_at
                    if purpose == TokenPurpose.CUSTODIAN
                    else handoff.custodian_attested_at,
                    "remote_etag": remote_etag or handoff.remote_etag,
                    "remote_version": remote_version
                    if remote_version is not None
                    else handoff.remote_version,
                }
            )
            spec = MutationSpec(
                case_id=case_id,
                expected_version=expected_version,
                target_state=target_state,
                event_type="TOKEN_PRESENTED",
                actor=actor,
                reason=(
                    f"The {purpose.value.lower()} one-time credential was presented. "
                    "This records a service token attestation, not physical possession."
                ),
                idempotency_key=idempotency_key,
                fingerprint=fingerprint,
                occurred_at=occurred_at,
                handoff=updated_handoff,
                allow_fact_event=target_state == current.state,
            )
            event = _make_event(current, spec)
            updated_case = CaseRecord.model_validate(
                current.model_copy(
                    update={
                        "state": target_state,
                        "version": current.version + 1,
                        "last_event_sequence": event.sequence,
                        "last_event_hash": event.event_hash,
                        "updated_at": occurred_at,
                    }
                )
            )
            receipt = _receipt(event, updated_case)
            txn.set(case_ref, self._storage(updated_case))
            txn.create(case_ref.collection("events").document(event.id), self._storage(event))
            txn.set(handoff_ref, self._storage(updated_handoff))
            txn.set(token_ref, self._storage(token.model_copy(update={"used_at": occurred_at})))
            txn.create(
                idem_ref,
                self._storage(
                    IdempotencyRecord(
                        key=idempotency_key,
                        case_id=case_id,
                        fingerprint=fingerprint,
                        response=receipt.model_dump(mode="json"),
                        created_at=occurred_at,
                    )
                ),
            )
            return receipt, False

        receipt, duplicate = consume(transaction)
        return AppliedMutation(
            receipt=receipt,
            event=self.get_event(case_id, receipt.event_id),
            duplicate=duplicate,
        )
