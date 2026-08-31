"""Application service coordinating policy, state, outbox, tokens, and events."""

from __future__ import annotations

from datetime import datetime, timedelta
import secrets
from typing import Callable
from uuid import NAMESPACE_URL, uuid5

from .agent import CaseAnalyst
from .config import Settings
from .correlation import get_or_create_correlation_id
from .domain import (
    AppliedMutation,
    Candidate,
    CaseRecord,
    CaseView,
    ClaimantCaseProjection,
    ClaimantLinkView,
    ClaimLinkRecord,
    CustodyState,
    EvidenceOrigin,
    EvidenceVisibility,
    ExecutionClaimDisposition,
    EventManifest,
    HandoffRecord,
    HandoffStatus,
    HandoffView,
    OpaqueTaskPayload,
    OutboxKind,
    OutboxFailureStage,
    OutboxStatus,
    PolicyOutcome,
    RelayAttestation,
    RiskTier,
    SimulatorHandoffCallback,
    TokenPurpose,
    TokenRecord,
    utc_now,
)
from .errors import Conflict, DomainError, Forbidden, NotFound, Unavailable
from .evidence import EvidenceStore, get_exact_complete_pair
from .fixtures import DEMO_CASE_ID, FIXTURE_DISCLOSURE, reset_demo_repository
from .hashing import secret_digest, secure_equal, sha256_hex
from .outbox import TaskPublisher, make_outbox, opaque_payload
from .policy import POLICY_VERSION, category_requires_specialist, evaluate_release_policy, specialist_intake_guidance
from .relay import RelayGateway
from .repository import MutationSpec, Repository


# Keep the claim shorter than the production queue's 10-second minimum
# backoff. A transport-ambiguous redelivery can then take the stale-recovery
# branch while the replaced worker remains unable to commit model output.
ANALYSIS_EXECUTION_LEASE = timedelta(seconds=5)


class CustodyService:
    def __init__(
        self,
        *,
        repository: Repository,
        evidence_store: EvidenceStore,
        analyst: CaseAnalyst,
        relay: RelayGateway,
        task_publisher: TaskPublisher,
        settings: Settings,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.repository = repository
        self.evidence_store = evidence_store
        self.analyst = analyst
        self.relay = relay
        self.task_publisher = task_publisher
        self.settings = settings
        self.clock = clock

    def reset_demo(self) -> dict:
        if not self.settings.demo_mode:
            raise Forbidden("demo_reset_disabled", "Demo reset is disabled in this environment.")
        reset_demo_repository(
            self.repository,
            self.settings.secret_pepper,
            occurred_at=self.clock(),
        )
        return self.snapshot(DEMO_CASE_ID)

    def _publish_outbox(self, outbox) -> dict:
        """Publish a committed command without losing a recoverable failure marker."""

        try:
            result = self.task_publisher.publish(outbox)
        except Exception as exc:
            self.repository.mark_outbox(
                outbox.id,
                OutboxStatus.FAILED,
                failure_stage=OutboxFailureStage.PUBLISH,
                failure_code="task_publish_failed",
            )
            raise Unavailable(
                "task_publish_failed",
                "The custody command was committed but background publication failed; operator recovery is required.",
            ) from exc
        if result.get("queued"):
            self.repository.mark_outbox(outbox.id, OutboxStatus.DISPATCHED)
        return result

    def _existing_task_receipt(self, outbox) -> dict:
        """Reproduce the publisher contract without exposing a cloud task body."""

        if outbox.status == OutboxStatus.PENDING:
            return self._publish_outbox(outbox)
        if outbox.status == OutboxStatus.FAILED:
            raise Unavailable(
                "task_publish_failed",
                "The custody command is awaiting bounded operator recovery.",
            )
        if self.settings.tasks_mode == "cloud":
            return {
                "queued": True,
                "mode": "cloud_tasks",
                "task_name": outbox.task_name,
                "idempotent_replay": True,
            }
        return {
            "queued": False,
            "mode": "inline",
            "task_name": outbox.task_name,
            "payload": opaque_payload(outbox).model_dump(mode="json"),
        }

    def _existing_analysis_job(self, case: CaseRecord) -> dict:
        """Return the committed analysis command without creating another one."""

        rows = [row for row in self.repository.list_outboxes(case.id) if row.kind == OutboxKind.ANALYZE_CASE]
        if not rows:
            raise Conflict("analysis_outbox_missing", "The analyzing case has no outbox command.")
        outbox = rows[-1]
        return {
            "case": CaseView.from_record(case),
            "outbox": outbox,
            "task": self._existing_task_receipt(outbox),
        }

    def _exact_authorized_evidence_refs(
        self,
        case_id: str,
        *,
        workflow_epoch: str,
        original_id: str,
        preview_id: str,
    ) -> tuple[str, ...] | None:
        """Return refs for the one immutable pair selected by an upload command."""

        pair = get_exact_complete_pair(
            self.evidence_store,
            case_id=case_id,
            workflow_epoch=workflow_epoch,
            original_id=original_id,
            preview_id=preview_id,
        )
        if pair is None:
            return None
        original, preview = pair
        if (
            original.visibility != EvidenceVisibility.STAFF_ONLY
            or preview.visibility != EvidenceVisibility.MODEL_AUTHORIZED
        ):
            return None
        return tuple(
            f"evidence://{record.id}?sha256={record.sha256}"
            for record in sorted(pair, key=lambda item: item.id)
        )

    def _auto_evidence_ready_refs(self, case_id: str, *, base_key: str) -> tuple[str, ...] | None:
        """Read the exact refs committed by a server-managed intake transition."""

        event_key = f"{base_key}:evidence-ready"
        for event in reversed(self.repository.list_events(case_id)):
            if event.idempotency_key == event_key and event.type == "EVIDENCE_PACKET_READY":
                return tuple(event.evidence_refs)
        return None

    def auto_start_authorized_intake_analysis(
        self,
        case_id: str,
        *,
        workflow_epoch: str,
        original_id: str,
        preview_id: str,
    ) -> dict | None:
        """Queue one bounded analysis after a trusted ordinary intake reaches its evidence gate.

        The browser never supplies the queue command.  The stored arm is set only
        by the authenticated ordinary-intake route, and the evidence store must
        still expose the current epoch's complete model-authorized pair.
        """

        frozen_evidence_refs = self._exact_authorized_evidence_refs(
            case_id,
            workflow_epoch=workflow_epoch,
            original_id=original_id,
            preview_id=preview_id,
        )
        if frozen_evidence_refs is None:
            return None
        # Pair-specific identity prevents a second upload from joining an
        # interrupted first transition. A retry of the exact upload still
        # resumes its immutable EVIDENCE_PACKET_READY event.
        pair_digest = sha256_hex(
            {
                "workflow_epoch": workflow_epoch,
                "evidence_refs": frozen_evidence_refs,
            }
        )[:24]
        idempotency_key = f"auto-intake:{workflow_epoch}:{pair_digest}"
        base_key = f"case:{case_id}:analysis:{idempotency_key}"
        last_stale_error: Conflict | None = None
        for _attempt in range(3):
            case = self.repository.get_case(case_id)
            if not case.analysis_auto_start_armed or case.workflow_epoch != workflow_epoch:
                return None
            if case.state == CustodyState.ANALYZING:
                committed_refs = self._auto_evidence_ready_refs(case_id, base_key=base_key)
                return self._existing_analysis_job(case) if committed_refs == frozen_evidence_refs else None
            if case.state not in {CustodyState.RECEIVED, CustodyState.EVIDENCE_READY}:
                return None
            if case.state == CustodyState.EVIDENCE_READY:
                # Only the exact pair that created this intermediate checkpoint
                # can resume it after a process interruption.
                committed_refs = self._auto_evidence_ready_refs(case_id, base_key=base_key)
                if committed_refs != frozen_evidence_refs:
                    return None
            if self._exact_authorized_evidence_refs(
                case_id,
                workflow_epoch=workflow_epoch,
                original_id=original_id,
                preview_id=preview_id,
            ) != frozen_evidence_refs:
                return None
            try:
                return self.begin_analysis(
                    case_id,
                    expected_version=1,
                    idempotency_key=idempotency_key,
                    server_auto=True,
                    frozen_evidence_refs=frozen_evidence_refs,
                )
            except Conflict as error:
                if error.code != "stale_case_version":
                    raise
                # A concurrent upload can observe the committed EVIDENCE_READY
                # event before its sibling commits ANALYZING. Re-entering with
                # the same key resumes that exact first transition safely.
                last_stale_error = error

        raced_case = self.repository.get_case(case_id)
        if raced_case.workflow_epoch == workflow_epoch and raced_case.state == CustodyState.ANALYZING:
            committed_refs = self._auto_evidence_ready_refs(case_id, base_key=base_key)
            if committed_refs == frozen_evidence_refs:
                return self._existing_analysis_job(raced_case)
        assert last_stale_error is not None
        raise last_stale_error

    def _reconcile_publish_outboxes(
        self,
        case_id: str,
        *,
        max_items: int,
        allowed_kinds: set[OutboxKind] | None = None,
    ) -> dict:
        """Republish a bounded set of deterministic commands after enqueue failure."""

        rows = sorted(
            self.repository.list_outboxes(case_id),
            key=lambda row: (row.created_at, row.id),
        )
        eligible = [
            row
            for row in rows
            if (allowed_kinds is None or row.kind in allowed_kinds)
            and (
                row.status == OutboxStatus.PENDING
                or (
                    row.status == OutboxStatus.FAILED
                    and row.failure_stage == OutboxFailureStage.PUBLISH
                )
            )
        ][:max_items]
        items: list[dict] = []
        recovered = 0
        for row in eligible:
            if row.status == OutboxStatus.FAILED:
                # Preserve only the deterministic command identity. A fresh
                # PENDING marker makes the recovery state explicit before the
                # publisher reuses the same Cloud Tasks name.
                self.repository.mark_outbox(row.id, OutboxStatus.PENDING)
            try:
                result = self._publish_outbox(row)
            except Unavailable:
                current = self.repository.get_outbox(row.id)
                items.append(
                    {
                        "outbox_id": current.id,
                        "status": current.status,
                        "failure_stage": current.failure_stage,
                        "failure_code": current.failure_code,
                    }
                )
                continue
            current = self.repository.get_outbox(row.id)
            if result.get("queued") and current.status in {
                OutboxStatus.DISPATCHED,
                OutboxStatus.COMPLETE,
            }:
                recovered += 1
            items.append(
                {
                    "outbox_id": current.id,
                    "status": current.status,
                    "failure_stage": current.failure_stage,
                    "failure_code": current.failure_code,
                }
            )
        return {
            "case_id": case_id,
            "eligible": len(eligible),
            "recovered": recovered,
            "items": items,
        }

    def reconcile_demo_outbox(self, *, max_items: int) -> dict:
        """Republish only bounded, publication-stage failures for the frozen demo case."""

        if not self.settings.demo_mode:
            raise Forbidden("demo_recovery_disabled", "Synthetic demo recovery is disabled.")
        return self._reconcile_publish_outboxes(DEMO_CASE_ID, max_items=max_items)

    def reconcile_authorized_intake_analysis(self, case_id: str, *, max_items: int) -> dict:
        """Recover only the server-created analysis command for one ordinary intake."""

        case = self.repository.get_case(case_id)
        if not case.analysis_auto_start_armed:
            raise Forbidden(
                "ordinary_intake_recovery_not_allowed",
                "This recovery path is reserved for server-managed ordinary intakes.",
            )
        if case.state != CustodyState.ANALYZING:
            raise Conflict(
                "ordinary_intake_recovery_state_invalid",
                "Only an analyzing ordinary intake can recover its analysis publication.",
            )
        return self._reconcile_publish_outboxes(
            case_id,
            max_items=max_items,
            allowed_kinds={OutboxKind.ANALYZE_CASE},
        )

    def snapshot(self, case_id: str) -> dict:
        case = self.repository.get_case(case_id)
        candidates = self.repository.list_candidates(case.candidate_ids)
        handoff = self._handoff_for_case(case)
        return {
            "schema_version": "1",
            "disclosure": FIXTURE_DISCLOSURE,
            "case": CaseView.from_record(case),
            "candidates": candidates,
            "events": self.repository.list_events(case_id),
            "outbox": self.repository.list_outboxes(case_id),
            "handoff": HandoffView.from_record(handoff) if handoff else None,
            "execution": {
                "analyst_mode": self.analyst.mode,
                "model_name": self.analyst.model_name,
                "prompt_version": self.analyst.prompt_version,
                "output_schema_version": self.analyst.output_schema_version,
                "policy_version": POLICY_VERSION,
                "repository": self.settings.repository_backend,
                "relay_mode": self.relay.mode,
                "tasks_mode": self.settings.tasks_mode,
            },
        }

    def _handoff_for_case(self, case: CaseRecord) -> HandoffRecord | None:
        if not case.handoff_id:
            return None
        return self.repository.get_handoff(case.handoff_id)

    def _claim_link_hash(self, raw_token: str) -> str:
        if not raw_token or len(raw_token) < 40:
            raise Forbidden(
                "claim_link_required",
                "A scoped claimant proof link is required for this private submission.",
            )
        return secret_digest(raw_token, self.settings.secret_pepper)

    def issue_claim_link(
        self,
        case_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
    ) -> dict:
        issued_at = self.clock()
        raw_token = "frcl_" + secret_digest(
            sha256_hex({"case_id": case_id, "idempotency_key": idempotency_key}),
            self.settings.secret_pepper,
        )
        token_hash = self._claim_link_hash(raw_token)
        record = ClaimLinkRecord(
            token_hash=token_hash,
            issuance_key_hash=secret_digest(
                f"claim-link-issuance:{idempotency_key}",
                self.settings.secret_pepper,
            ),
            command_fingerprint=sha256_hex(
                {
                    "case_id": case_id,
                    "expected_version": expected_version,
                    "token_hash": token_hash,
                }
            ),
            case_id=case_id,
            issued_case_version=expected_version,
            issued_at=issued_at,
            expires_at=issued_at + timedelta(seconds=self.settings.claim_link_ttl_seconds),
        )
        result = self.repository.issue_claim_link(record, occurred_at=issued_at)
        stored = result.record
        return {
            "case_id": stored.case_id,
            "issued_case_version": stored.issued_case_version,
            "issued_at": stored.issued_at,
            "expires_at": stored.expires_at,
            "active": result.active,
            "token": raw_token,
        }

    def inspect_claim_link(self, case_id: str, raw_token: str) -> dict:
        record = self.repository.inspect_claim_link(
            case_id=case_id,
            token_hash=self._claim_link_hash(raw_token),
            occurred_at=self.clock(),
        )
        claimant_case = ClaimantCaseProjection.from_record(
            self.repository.get_case(case_id),
            link=ClaimantLinkView(
                active=True,
                issued_case_version=record.issued_case_version,
                issued_at=record.issued_at,
                expires_at=record.expires_at,
            ),
        )
        return {
            "case_id": record.case_id,
            "issued_case_version": record.issued_case_version,
            "issued_at": record.issued_at,
            "expires_at": record.expires_at,
            "active": True,
            "case": claimant_case,
        }

    def _mutation_spec(
        self,
        *,
        case: CaseRecord,
        target: CustodyState,
        event_type: str,
        actor: str,
        reason: str,
        key: str,
        fingerprint_data,
        updates: dict | None = None,
        **kwargs,
    ) -> MutationSpec:
        return MutationSpec(
            case_id=case.id,
            expected_version=case.version,
            target_state=target,
            event_type=event_type,
            actor=actor,
            reason=reason,
            idempotency_key=key,
            fingerprint=sha256_hex(fingerprint_data),
            occurred_at=self.clock(),
            updates=updates or {},
            **kwargs,
        )

    def _mutation(
        self,
        *,
        case: CaseRecord,
        target: CustodyState,
        event_type: str,
        actor: str,
        reason: str,
        key: str,
        fingerprint_data,
        updates: dict | None = None,
        execution_claim_outbox_id: str | None = None,
        execution_claim_token: str | None = None,
        **kwargs,
    ) -> AppliedMutation:
        return self.repository.apply_mutation(
            self._mutation_spec(
                case=case,
                target=target,
                event_type=event_type,
                actor=actor,
                reason=reason,
                key=key,
                fingerprint_data=fingerprint_data,
                updates=updates,
                **kwargs,
            ),
            execution_claim_outbox_id=execution_claim_outbox_id,
            execution_claim_token=execution_claim_token,
        )

    def _analysis_evidence_refs(self, case_id: str) -> list[str]:
        if (
            case_id == DEMO_CASE_ID
            and self.settings.environment == "development"
            and self.analyst.mode == "fixture"
        ):
            return ["fixture://camera-pouch/intake-photo"]

        case = self.repository.get_case(case_id)
        records = [
            record
            for record in self.evidence_store.list_records(case_id)
            if record.workflow_epoch == case.workflow_epoch
        ]
        staff_records = [
            record
            for record in records
            if record.visibility == EvidenceVisibility.STAFF_ONLY
            and record.provenance.origin == EvidenceOrigin.ORIGINAL
        ]
        if not staff_records:
            raise Conflict(
                "analysis_evidence_required",
                "Staff evidence must be uploaded before analysis can begin.",
            )
        active_pair = self.evidence_store.latest_complete_pair(case_id, case.workflow_epoch)
        if active_pair is None or active_pair[1].visibility != EvidenceVisibility.MODEL_AUTHORIZED:
            raise Conflict(
                "model_authorized_preview_required",
                "A derived model-authorized preview must exist before analysis can begin.",
            )
        original, preview = active_pair
        return [
            f"evidence://{record.id}?sha256={record.sha256}"
            for record in sorted((original, preview), key=lambda item: item.id)
        ]

    def begin_analysis(
        self,
        case_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
        server_auto: bool = False,
        frozen_evidence_refs: tuple[str, ...] | None = None,
    ) -> dict:
        case = self.repository.get_case(case_id)
        if case.analysis_auto_start_armed and not server_auto:
            raise Conflict(
                "ordinary_intake_auto_queue_only",
                "Ordinary intake analysis is queued only by the authorized evidence workflow.",
            )
        if server_auto:
            if not case.analysis_auto_start_armed or not frozen_evidence_refs:
                raise ValueError("server-managed analysis requires one frozen authorized evidence pair")
        elif frozen_evidence_refs is not None:
            raise ValueError("frozen evidence refs are reserved for server-managed analysis")
        base_key = f"case:{case_id}:analysis:{idempotency_key}"
        replay_event_suffix = {
            CustodyState.EVIDENCE_READY: "evidence-ready",
            CustodyState.ANALYZING: "analyzing",
        }.get(case.state)
        exact_inflight_replay = (
            expected_version == 1
            and replay_event_suffix is not None
            and any(
                event.idempotency_key == f"{base_key}:{replay_event_suffix}"
                for event in self.repository.list_events(case_id)
            )
        )
        if case.version != expected_version and not exact_inflight_replay:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        if case.state == CustodyState.RECEIVED:
            evidence_refs = list(frozen_evidence_refs) if server_auto else self._analysis_evidence_refs(case_id)
            is_fixture = any(reference.startswith("fixture://") for reference in evidence_refs)
            self._mutation(
                case=case,
                target=CustodyState.EVIDENCE_READY,
                event_type="EVIDENCE_PACKET_READY",
                actor="service:intake",
                reason=(
                    "Synthetic intake evidence was normalized and restricted facts remained staff-only."
                    if is_fixture
                    else "Uploaded staff evidence and its derived model-authorized preview passed the intake gate."
                ),
                key=f"{base_key}:evidence-ready",
                fingerprint_data={
                    "case_id": case_id,
                    "action": "evidence-ready",
                    "evidence_refs": evidence_refs,
                },
                evidence_refs=evidence_refs,
            )
            case = self.repository.get_case(case_id)
        if case.state == CustodyState.EVIDENCE_READY:
            if server_auto:
                committed_refs = self._auto_evidence_ready_refs(case_id, base_key=base_key)
                if committed_refs != frozen_evidence_refs:
                    raise Conflict(
                        "ordinary_intake_evidence_pair_mismatch",
                        "The server-managed analysis command is bound to a different evidence pair.",
                    )
            outbox = make_outbox(OutboxKind.ANALYZE_CASE, case, created_at=self.clock())
            self._mutation(
                case=case,
                target=CustodyState.ANALYZING,
                event_type="ANALYSIS_REQUESTED",
                actor="service:workflow",
                reason="Queued a bounded proposal-only Case Analyst run with opaque task identifiers.",
                key=f"{base_key}:analyzing",
                fingerprint_data={
                    "case_id": case_id,
                    "action": "analyzing",
                    "evidence_refs": list(frozen_evidence_refs or ()),
                },
                outbox=outbox,
                task_id=outbox.task_name,
            )
            publish_result = self._publish_outbox(outbox)
            return {
                "case": CaseView.from_record(self.repository.get_case(case_id)),
                "outbox": outbox,
                "task": publish_result,
            }
        if case.state == CustodyState.ANALYZING:
            return self._existing_analysis_job(case)
        raise Conflict("analysis_not_allowed", f"Analysis cannot start from {case.state.value}.")

    def queue_release_task_replay(self, case_id: str, *, idempotency_key: str) -> dict:
        if not self.settings.demo_mode:
            raise Forbidden(
                "demo_replay_scope_invalid",
                "Duplicate task delivery can be queued only while the synthetic demo workflow is enabled.",
            )
        case = self.repository.get_case(case_id)
        if case.state != CustodyState.CLOSED:
            raise Conflict(
                "release_replay_not_closed",
                "Duplicate release delivery can be demonstrated only after the passport is closed.",
            )
        rows = [
            row
            for row in self.repository.list_outboxes(case_id)
            if row.kind == OutboxKind.RELEASE_RELAY
        ]
        if not rows:
            raise Conflict("release_outbox_missing", "The case has no release command to replay.")
        outbox = rows[-1]
        if outbox.status != OutboxStatus.COMPLETE:
            raise Conflict(
                "release_replay_not_complete",
                "Only a completed release command can be delivered as an idempotency demonstration.",
            )
        task = self.task_publisher.publish_replay(outbox, idempotency_key)
        return {
            "case": CaseView.from_record(case),
            "outbox": outbox,
            "task": task,
            "baseline_replay_count": outbox.replay_count,
        }

    def process_outbox(
        self,
        payload: OpaqueTaskPayload,
        *,
        delivery_task_name: str | None = None,
    ) -> dict:
        outbox = self.repository.get_outbox(payload.outbox_id)
        if outbox.case_id != payload.case_id:
            raise Conflict("task_scope_mismatch", "The opaque task does not match the Item Passport.")
        if outbox.status == OutboxStatus.COMPLETE:
            replayed_outbox = self.repository.record_outbox_replay(
                outbox.id,
                occurred_at=self.clock(),
                delivery_task_name=delivery_task_name,
            )
            return {
                "outbox": replayed_outbox,
                "case": CaseView.from_record(self.repository.get_case(outbox.case_id)),
                "replayed": True,
            }
        if outbox.status == OutboxStatus.FAILED:
            if outbox.failure_stage == OutboxFailureStage.PUBLISH:
                raise Conflict(
                    "outbox_publication_not_recovered",
                    "The committed command must be republished by an authorized operator before delivery.",
                )
            if outbox.failure_stage == OutboxFailureStage.EXECUTE:
                return {
                    "outbox": outbox,
                    "case": CaseView.from_record(self.repository.get_case(outbox.case_id)),
                    "replayed": False,
                    "terminal_failure_acknowledged": True,
                    "retryable": False,
                    "manual_action_required": True,
                }
            raise Conflict(
                "outbox_execution_failed",
                "The failed command requires manual reconciliation and cannot be redelivered automatically.",
            )
        if outbox.status == OutboxStatus.PENDING:
            self.repository.mark_outbox(outbox.id, OutboxStatus.DISPATCHED)
        if outbox.kind == OutboxKind.ANALYZE_CASE:
            claimed_at = self.clock()
            claim_token = secrets.token_urlsafe(32)
            claim = self.repository.claim_outbox_execution(
                outbox.id,
                claim_token=claim_token,
                claimed_at=claimed_at,
                lease_expires_at=claimed_at + ANALYSIS_EXECUTION_LEASE,
            )
            if claim.disposition == ExecutionClaimDisposition.IN_PROGRESS:
                raise Unavailable(
                    "analysis_execution_in_progress",
                    "Another analyst execution owns the active lease; this delivery may be retried.",
                )
            if claim.disposition == ExecutionClaimDisposition.STALE_RECOVERY:
                case = self.repository.get_case(outbox.case_id)
                recovered = self._recover_analysis_failure(case, outbox, claim_token)
                if recovered is not None:
                    return recovered
                if case.state == CustodyState.ANALYZING:
                    ambiguous = Unavailable(
                        "analysis_execution_ambiguous",
                        "An earlier analyst execution became ambiguous; no second model call was made.",
                    )
                    self._terminalize_analysis_failure(
                        case,
                        outbox,
                        ambiguous,
                        claim_token,
                        reason=(
                            "An earlier analyst execution became ambiguous; custody work stopped for "
                            "manual review without a second model call."
                        ),
                    )
                    raise ambiguous
            result = self._process_analysis(outbox, claim_token)
        elif outbox.kind in {OutboxKind.RESERVE_RELAY, OutboxKind.RELEASE_RELAY}:
            result = self._process_relay(outbox)
        else:  # pragma: no cover - exhaustive enum guard
            raise Conflict("unsupported_outbox_kind", "The outbox command kind is unsupported.")
        return result

    @staticmethod
    def _analysis_failure_code(event_type: str) -> str | None:
        return {
            "ANALYST_UNAVAILABLE": "analyst_unavailable",
            "ANALYST_REVIEW_REQUIRED": "analyst_policy_conflict",
        }.get(event_type)

    def _recover_analysis_failure(
        self,
        case: CaseRecord,
        outbox,
        claim_token: str,
    ) -> dict | None:
        if case.state != CustodyState.MANUAL_REVIEW:
            return None
        recovery_key = f"outbox:{outbox.id}:manual-review"
        failure_event = next(
            (
                event
                for event in reversed(self.repository.list_events(case.id))
                if event.idempotency_key == recovery_key
                and event.task_id == outbox.task_name
                and event.from_state == CustodyState.ANALYZING
                and event.to_state == CustodyState.MANUAL_REVIEW
                and self._analysis_failure_code(event.type) is not None
            ),
            None,
        )
        if failure_event is None:
            return None
        failed = self.repository.mark_outbox_execution(
            outbox.id,
            OutboxStatus.FAILED,
            claim_token=claim_token,
            completed_at=self.clock(),
            failure_stage=OutboxFailureStage.EXECUTE,
            failure_code=self._analysis_failure_code(failure_event.type),
        )
        return {
            "outbox": failed,
            "case": CaseView.from_record(case),
            "replayed": False,
            "terminal_failure_acknowledged": True,
            "retryable": False,
            "manual_action_required": True,
        }

    def _terminalize_analysis_failure(
        self,
        case: CaseRecord,
        outbox,
        exc: DomainError,
        claim_token: str,
        *,
        reason: str | None = None,
    ) -> None:
        unavailable = isinstance(exc, Unavailable)
        event_type = "ANALYST_UNAVAILABLE" if unavailable else "ANALYST_REVIEW_REQUIRED"
        failure_code = "analyst_unavailable" if unavailable else "analyst_policy_conflict"
        failure_reason = reason or (
            "The bounded analyst was unavailable; custody work stopped for manual review."
            if unavailable
            else (
                "The analysis workflow could not produce an acceptable custody proposal; "
                "custody work stopped for manual review."
            )
        )
        self._mutation(
            case=case,
            target=CustodyState.MANUAL_REVIEW,
            event_type=event_type,
            actor="service:workflow",
            reason=failure_reason,
            key=f"outbox:{outbox.id}:manual-review",
            fingerprint_data={"outbox_id": outbox.id, "reason": failure_code},
            task_id=outbox.task_name,
            execution_claim_outbox_id=outbox.id,
            execution_claim_token=claim_token,
        )
        self.repository.mark_outbox_execution(
            outbox.id,
            OutboxStatus.FAILED,
            claim_token=claim_token,
            completed_at=self.clock(),
            failure_stage=OutboxFailureStage.EXECUTE,
            failure_code=failure_code,
        )

    def _process_analysis(self, outbox, claim_token: str) -> dict:
        case = self.repository.get_case(outbox.case_id)
        recovered = self._recover_analysis_failure(case, outbox, claim_token)
        if recovered is not None:
            return recovered
        if case.state == CustodyState.ANALYZING:
            candidates = self.repository.list_candidates()
            try:
                analysis_result = self.analyst.analyze(case, candidates)
                if len(analysis_result) == 3:
                    run_id, proposal, execution = analysis_result
                else:
                    # Test doubles that predate identifier-only execution evidence
                    # remain valid outside canonical Vertex mode.
                    run_id, proposal = analysis_result
                    execution = None
                authorized_ids = {candidate.id for candidate in candidates}
                if set(proposal.ranked_candidate_ids) - authorized_ids:
                    raise Conflict("agent_scope_violation", "The analyst referenced an unauthorized candidate.")
                selected = (
                    self.repository.get_candidate(proposal.selected_candidate_id)
                    if proposal.selected_candidate_id
                    else None
                )
                if not selected:
                    raise Conflict("agent_selection_missing", "The analyst did not select a candidate.")
                if proposal.restricted_attribute_id != selected.restricted_attribute_id:
                    raise Conflict(
                        "agent_discriminator_invalid",
                        "The analyst proposed an attribute that is not available as restricted staff evidence.",
                    )
            except (Unavailable, Conflict) as exc:
                self._terminalize_analysis_failure(case, outbox, exc, claim_token)
                raise
            self._mutation(
                case=case,
                target=CustodyState.CANDIDATES_READY,
                event_type="CANDIDATE_PACKET_PROPOSED",
                actor="agent:case-analyst",
                reason=(
                    "The bounded Case Analyst ranked authorized candidates and abstained from accepting claim evidence."
                ),
                key=f"outbox:{outbox.id}:candidates-ready",
                fingerprint_data={"outbox_id": outbox.id, "proposal": proposal.model_dump(mode="json")},
                updates={
                    "candidate_ids": proposal.ranked_candidate_ids,
                    "selected_item_id": proposal.selected_candidate_id,
                    "next_question": proposal.next_question,
                    "model_run_id": run_id,
                    "model_trace_id": execution.trace_id if execution is not None else None,
                    "model_name": self.analyst.model_name,
                    "model_mode": self.analyst.mode,
                    "model_invocation_count": (
                        execution.invocation_count if execution is not None else None
                    ),
                    "model_tool_trajectory": (
                        execution.tool_trajectory if execution is not None else []
                    ),
                    "model_typed_output_valid": (
                        execution.typed_output_valid if execution is not None else False
                    ),
                },
                tool="case_analyst.submit_observations",
                task_id=outbox.task_name,
                model_run_id=run_id,
                evidence_refs=[f"candidate://{item_id}" for item_id in proposal.ranked_candidate_ids],
                execution_claim_outbox_id=outbox.id,
                execution_claim_token=claim_token,
            )
            case = self.repository.get_case(outbox.case_id)
        if case.state == CustodyState.CANDIDATES_READY:
            decision = evaluate_release_policy(case)
            self._mutation(
                case=case,
                target=CustodyState.CLARIFICATION_REQUIRED,
                event_type="PRIVATE_EVIDENCE_REQUESTED",
                actor="service:policy",
                reason="Visual and route evidence remained insufficient; one non-leading private question was requested.",
                key=f"outbox:{outbox.id}:clarification-required",
                fingerprint_data={"outbox_id": outbox.id, "question": case.next_question},
                updates={"policy_outcome": decision.outcome},
                tool="propose_discriminator",
                task_id=outbox.task_name,
                model_run_id=case.model_run_id,
                execution_claim_outbox_id=outbox.id,
                execution_claim_token=claim_token,
            )
            case = self.repository.get_case(outbox.case_id)
        if case.state != CustodyState.CLARIFICATION_REQUIRED:
            raise Conflict("analysis_result_state_invalid", f"Analysis cannot complete in {case.state.value}.")
        completed = self.repository.mark_outbox_execution(
            outbox.id,
            OutboxStatus.COMPLETE,
            claim_token=claim_token,
            completed_at=self.clock(),
        )
        return {"outbox": completed, "case": CaseView.from_record(case), "replayed": False}

    def submit_claim_evidence(
        self,
        case_id: str,
        raw_token: str,
        *,
        expected_version: int,
        answer: str,
        idempotency_key: str,
    ) -> dict:
        token_hash = self._claim_link_hash(raw_token)
        case = self.repository.get_case(case_id)
        if not case.selected_item_id:
            raise Conflict("selected_candidate_missing", "No candidate is ready for private evidence comparison.")
        selected = self.repository.get_candidate(case.selected_item_id)
        ranked = self.repository.list_candidates(case.candidate_ids)
        runner_up = max(
            (candidate.frozen_score for candidate in ranked if candidate.id != selected.id), default=0.0
        )
        hard_gates = (
            selected.category == case.category
            and selected.route_compatible
            and selected.time_compatible
            and selected.availability == "AVAILABLE"
            and selected.visible_signal_count >= 2
            and selected.frozen_score - runner_up >= 0.10
            and selected.restricted_value_hash is not None
        )
        submitted_hash = secret_digest(answer, self.settings.secret_pepper)
        correct = hard_gates and secure_equal(submitted_hash, selected.restricted_value_hash or "")
        base_key = f"case:{case_id}:claim:{idempotency_key}"
        command_fingerprint = sha256_hex(
            {
                "case_id": case_id,
                "expected_version": expected_version,
                "submitted_digest": submitted_hash,
                "token_hash": token_hash,
            }
        )
        occurred_at = self.clock()
        spec_case = case.model_copy(
            update={
                "state": CustodyState.CLARIFICATION_REQUIRED,
                "version": expected_version,
            }
        )
        specs: list[MutationSpec] = []
        if not correct:
            wrong_count = case.wrong_answer_count + 1
            specs.append(
                self._mutation_spec(
                    case=spec_case,
                    target=CustodyState.CLARIFICATION_REQUIRED,
                    event_type="CLAIM_EVIDENCE_REJECTED",
                    actor="claimant:private-link",
                    reason="The submitted private evidence did not satisfy deterministic claim-evidence gates.",
                    key=f"{base_key}:rejected",
                    fingerprint_data={"case_id": case_id, "submitted_digest": submitted_hash},
                    updates={"wrong_answer_count": wrong_count},
                    allow_fact_event=True,
                )
            )
            if wrong_count > 3:
                spec_case = spec_case.model_copy(
                    update={
                        "version": expected_version + 1,
                        "wrong_answer_count": wrong_count,
                    }
                )
                specs.append(
                    self._mutation_spec(
                        case=spec_case,
                        target=CustodyState.ANALYZING,
                        event_type="CLAIM_ATTEMPT_LIMIT_REACHED",
                        actor="service:policy",
                        reason="More than three incorrect private answers require a manual review.",
                        key=f"{base_key}:attempt-limit",
                        fingerprint_data={"case_id": case_id, "wrong_count": wrong_count},
                    )
                )
                spec_case = spec_case.model_copy(
                    update={"state": CustodyState.ANALYZING, "version": expected_version + 2}
                )
                specs.append(
                    self._mutation_spec(
                        case=spec_case,
                        target=CustodyState.MANUAL_REVIEW,
                        event_type="MANUAL_REVIEW_REQUIRED",
                        actor="service:policy",
                        reason="Custody work paused after repeated incorrect private evidence.",
                        key=f"{base_key}:manual-review",
                        fingerprint_data={"case_id": case_id, "wrong_count": wrong_count},
                        updates={"policy_outcome": PolicyOutcome.REQUIRE_REVIEW},
                    )
                )
        else:
            specs.append(
                self._mutation_spec(
                    case=spec_case,
                    target=CustodyState.ANALYZING,
                    event_type="PRIVATE_EVIDENCE_RECEIVED",
                    actor="claimant:private-link",
                    reason="Private evidence was received through the claimant link and compared only in policy code.",
                    key=f"{base_key}:received",
                    fingerprint_data={"case_id": case_id, "submitted_digest": submitted_hash},
                )
            )
            spec_case = spec_case.model_copy(
                update={"state": CustodyState.ANALYZING, "version": expected_version + 1}
            )
            specs.append(
                self._mutation_spec(
                    case=spec_case,
                    target=CustodyState.CANDIDATES_READY,
                    event_type="CANDIDATE_PACKET_RECHECKED",
                    actor="service:policy",
                    reason="Deterministic category, route, time, availability, signal, and score-margin gates passed.",
                    key=f"{base_key}:rechecked",
                    fingerprint_data={"case_id": case_id, "candidate_id": selected.id},
                )
            )
            spec_case = spec_case.model_copy(
                update={"state": CustodyState.CANDIDATES_READY, "version": expected_version + 2}
            )
            projected = case.model_copy(update={"accepted_claim_evidence": True, "next_question": None})
            decision = evaluate_release_policy(projected)
            specs.append(
                self._mutation_spec(
                    case=spec_case,
                    target=CustodyState.CLAIM_EVIDENCE_ACCEPTED,
                    event_type="CLAIM_EVIDENCE_ACCEPTED",
                    actor="service:policy",
                    reason=(
                        "Deterministic claim-evidence gates accepted the evidence packet. "
                        "This is not an ownership or identity determination."
                    ),
                    key=f"{base_key}:accepted",
                    fingerprint_data={
                        "case_id": case_id,
                        "candidate_id": selected.id,
                        "policy": decision.outcome,
                    },
                    updates={
                        "accepted_claim_evidence": True,
                        "next_question": None,
                        "policy_outcome": decision.outcome,
                    },
                    evidence_refs=[f"restricted-attribute://{selected.restricted_attribute_id}"],
                )
            )

        committed = self.repository.consume_claim_link_and_apply_mutations(
            case_id=case_id,
            token_hash=token_hash,
            idempotency_key=base_key,
            fingerprint=command_fingerprint,
            occurred_at=occurred_at,
            specs=specs,
            accepted=correct,
        )
        return {
            "accepted": committed.accepted,
            "case": ClaimantCaseProjection.from_record(
                committed.case,
                link=ClaimantLinkView(
                    active=False,
                    issued_case_version=expected_version,
                ),
            ),
            "replayed": committed.duplicate,
        }

    def record_identity_attestation(
        self,
        case_id: str,
        *,
        expected_version: int,
        staff_user_id: str,
        method: str,
        idempotency_key: str,
    ) -> dict:
        allowed_methods = {"government_id_visual_check", "booking_record_check", "employee_badge_check"}
        if method not in allowed_methods:
            raise Conflict("identity_method_invalid", "Use an approved attestation method; do not upload ID media.")
        case = self.repository.get_case(case_id)
        if case.state not in {CustodyState.CLAIM_EVIDENCE_ACCEPTED, CustodyState.IDENTITY_ATTESTED, CustodyState.APPROVAL_REQUIRED}:
            raise Conflict("identity_attestation_not_allowed", "Identity attestation is not allowed in this state.")
        if case.identity_attestation_ref:
            return {"case": CaseView.from_record(case), "replayed": True}
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        attestation_ref = f"identity-att-{sha256_hex({'case': case_id, 'staff': staff_user_id, 'method': method})[:20]}"
        projected = case.model_copy(update={"identity_attestation_ref": attestation_ref})
        decision = evaluate_release_policy(projected)
        base_key = f"case:{case_id}:identity:{idempotency_key}"
        self._mutation(
            case=case,
            target=CustodyState.IDENTITY_ATTESTED,
            event_type="IDENTITY_ATTESTED",
            actor=staff_user_id,
            reason=(
                f"Staff recorded a {method.replace('_', ' ')} attestation. "
                "No ID number, text, or image was retained."
            ),
            key=f"{base_key}:attested",
            fingerprint_data={"case_id": case_id, "staff": staff_user_id, "method": method},
            updates={"identity_attestation_ref": attestation_ref, "policy_outcome": decision.outcome},
            evidence_refs=[f"identity-attestation://{attestation_ref}"],
        )
        case = self.repository.get_case(case_id)
        if case.risk_tier == RiskTier.VALUABLE:
            self._mutation(
                case=case,
                target=CustodyState.APPROVAL_REQUIRED,
                event_type="SUPERVISOR_APPROVAL_REQUIRED",
                actor="service:policy",
                reason="Valuable electronics require accountable supervisor approval before a relay reservation.",
                key=f"{base_key}:approval-required",
                fingerprint_data={"case_id": case_id, "risk_tier": case.risk_tier},
                updates={"policy_outcome": PolicyOutcome.REQUIRE_REVIEW},
            )
        return {"case": CaseView.from_record(self.repository.get_case(case_id)), "replayed": False}

    def record_approval(
        self,
        case_id: str,
        *,
        expected_version: int,
        supervisor_user_id: str,
        approved: bool,
        reason: str,
        idempotency_key: str,
    ) -> dict:
        case = self.repository.get_case(case_id)
        if case.state != CustodyState.APPROVAL_REQUIRED:
            raise Conflict("approval_not_expected", "Supervisor approval is not expected in this state.")
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        if len(reason.strip()) < 8:
            raise Conflict("approval_reason_required", "Record a concise accountable reason for the decision.")
        base_key = f"case:{case_id}:approval:{idempotency_key}"
        if not approved:
            self._mutation(
                case=case,
                target=CustodyState.REJECTED,
                event_type="SUPERVISOR_REJECTED",
                actor=supervisor_user_id,
                reason=reason.strip(),
                key=f"{base_key}:rejected",
                fingerprint_data={"case_id": case_id, "approved": False, "reason": reason.strip()},
                updates={"policy_outcome": PolicyOutcome.DENY},
            )
            return {"case": CaseView.from_record(self.repository.get_case(case_id)), "approved": False}
        approval_ref = f"approval-{sha256_hex({'case': case_id, 'supervisor': supervisor_user_id, 'reason': reason})[:20]}"
        projected = case.model_copy(update={"approval_ref": approval_ref})
        decision = evaluate_release_policy(projected)
        self._mutation(
            case=case,
            target=case.state,
            event_type="SUPERVISOR_APPROVED",
            actor=supervisor_user_id,
            reason=reason.strip(),
            key=f"{base_key}:approved",
            fingerprint_data={"case_id": case_id, "approved": True, "reason": reason.strip()},
            updates={"approval_ref": approval_ref, "policy_outcome": decision.outcome},
            evidence_refs=[f"approval://{approval_ref}"],
            allow_fact_event=True,
        )
        return {"case": CaseView.from_record(self.repository.get_case(case_id)), "approved": True}

    def begin_reservation(
        self,
        case_id: str,
        *,
        expected_version: int,
        expected_remote_etag: str,
        idempotency_key: str,
    ) -> dict:
        case = self.repository.get_case(case_id)
        if case.state == CustodyState.RESERVE_REQUESTED and case.handoff_id:
            rows = [row for row in self.repository.list_outboxes(case_id) if row.kind == OutboxKind.RESERVE_RELAY]
            if not rows:
                raise Conflict("reservation_outbox_missing", "The reservation intent has no outbox command.")
            outbox = rows[-1]
            return {
                "case": CaseView.from_record(case),
                "handoff": HandoffView.from_record(self.repository.get_handoff(case.handoff_id)),
                "outbox": outbox,
                "task": self._existing_task_receipt(outbox),
                "replayed": True,
            }
        if case.state not in {CustodyState.APPROVAL_REQUIRED, CustodyState.IDENTITY_ATTESTED}:
            raise Conflict("reservation_not_allowed", "A relay reservation is not allowed in this state.")
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        decision = evaluate_release_policy(case)
        if decision.outcome != PolicyOutcome.ALLOW_HANDOFF:
            raise Conflict("release_policy_blocked", decision.next_action)
        if not case.selected_item_id:
            raise Conflict("selected_candidate_missing", "No candidate item is selected.")
        candidate = self.repository.get_candidate(case.selected_item_id)
        if candidate.availability != "AVAILABLE":
            raise Conflict("candidate_unavailable", "The selected item is no longer available.")
        if candidate.remote_etag != expected_remote_etag:
            raise Conflict("stale_remote_etag", "The custodian item eTag changed; manual review is required.")
        outbox = make_outbox(OutboxKind.RESERVE_RELAY, case, created_at=self.clock())
        handoff_id = f"handoff-{uuid5(NAMESPACE_URL, f'found-roll:{case_id}:{idempotency_key}').hex[:20]}"
        handoff = HandoffRecord(
            id=handoff_id,
            case_id=case_id,
            item_id=candidate.id,
            reservation_case_version=outbox.expected_case_version,
            remote_etag=candidate.remote_etag,
            remote_version=candidate.remote_version,
        )
        self._mutation(
            case=case,
            target=CustodyState.RESERVE_REQUESTED,
            event_type="RELAY_RESERVATION_REQUESTED",
            actor="service:custody",
            reason="Committed a disclosed SIMULATED relay reservation intent and deterministic outbox command.",
            key=f"case:{case_id}:reserve:{idempotency_key}",
            fingerprint_data={
                "case_id": case_id,
                "expected_remote_etag": expected_remote_etag,
                "handoff_id": handoff_id,
            },
            updates={"handoff_id": handoff_id, "policy_outcome": decision.outcome},
            outbox=outbox,
            handoff=handoff,
            task_id=outbox.task_name,
        )
        publish_result = self._publish_outbox(outbox)
        return {
            "case": CaseView.from_record(self.repository.get_case(case_id)),
            "handoff": HandoffView.from_record(handoff),
            "outbox": outbox,
            "task": publish_result,
        }

    def _process_relay(self, outbox) -> dict:
        case = self.repository.get_case(outbox.case_id)
        handoff = self._handoff_for_case(case)
        expected_state = (
            CustodyState.RESERVE_REQUESTED
            if outbox.kind == OutboxKind.RESERVE_RELAY
            else CustodyState.RELEASE_REQUESTED
        )
        if case.state != expected_state:
            raise Conflict("relay_task_state_invalid", f"Relay task cannot run from {case.state.value}.")
        try:
            attestation = self.relay.execute(outbox, case, handoff)
            return self.commit_relay_attestation(attestation)
        except (DomainError, ValueError) as exc:
            # A remote relay may have committed before a timeout, malformed callback,
            # or local contract rejection became visible. Stop automated work and
            # preserve the ambiguous command for an operator instead of leaving the
            # case in a misleading request state.
            current = self.repository.get_case(outbox.case_id)
            if current.state == expected_state:
                self._mutation(
                    case=current,
                    target=CustodyState.RECONCILIATION_REQUIRED,
                    event_type="RELAY_RECONCILIATION_REQUIRED",
                    actor="service:workflow",
                    reason=(
                        "The disclosed SIMULATED relay result could not be committed safely. "
                        "Automated custody work stopped for reconciliation; no physical transfer is proven."
                    ),
                    key=f"outbox:{outbox.id}:reconciliation-required",
                    fingerprint_data={
                        "outbox_id": outbox.id,
                        "operation": outbox.kind.value,
                        "failure_class": type(exc).__name__,
                    },
                    task_id=outbox.task_name,
                )
                self.repository.mark_outbox(
                    outbox.id,
                    OutboxStatus.FAILED,
                    completed_at=self.clock(),
                    failure_stage=OutboxFailureStage.EXECUTE,
                    failure_code="relay_execution_failed",
                )
            if isinstance(exc, DomainError):
                raise
            raise Unavailable(
                "relay_contract_invalid",
                "The disclosed SIMULATED relay returned an invalid service contract; reconciliation is required.",
            ) from exc

    def commit_relay_attestation(self, attestation: RelayAttestation) -> dict:
        outbox = self.repository.get_outbox(attestation.outbox_id)
        if outbox.status == OutboxStatus.COMPLETE:
            case = self.repository.get_case(outbox.case_id)
            if (
                outbox.case_id != attestation.case_id
                or outbox.result_attestation_id != attestation.attestation_id
                or case.selected_item_id != attestation.item_id
            ):
                raise Conflict("relay_replay_mismatch", "The replayed callback does not match the completed command.")
            return {
                "case": CaseView.from_record(case),
                "outbox": outbox,
                "replayed": True,
            }
        case = self.repository.get_case(attestation.case_id)
        matching_event = next(
            (
                event
                for event in self.repository.list_events(case.id)
                if event.simulator_attestation_id == attestation.attestation_id
            ),
            None,
        )
        if matching_event:
            completed = self.repository.mark_outbox(
                outbox.id,
                OutboxStatus.COMPLETE,
                result_attestation_id=attestation.attestation_id,
                completed_at=self.clock(),
            )
            return {"case": CaseView.from_record(case), "outbox": completed, "replayed": True}
        if outbox.case_id != case.id or attestation.case_id != case.id:
            raise Conflict("relay_scope_mismatch", "The relay attestation does not match the outbox command.")
        if case.selected_item_id != attestation.item_id:
            raise Conflict("relay_item_mismatch", "The relay attestation refers to another item.")
        if case.version != attestation.expected_case_version or case.version != outbox.expected_case_version:
            raise Conflict("stale_case_version", "The relay attestation refers to a stale Item Passport version.")
        handoff = self._handoff_for_case(case)
        if not handoff or handoff.item_id != attestation.item_id:
            raise Conflict("handoff_mismatch", "The relay attestation does not match the handoff.")
        if attestation.operation == "RESERVE":
            if outbox.kind != OutboxKind.RESERVE_RELAY or case.state != CustodyState.RESERVE_REQUESTED:
                raise Conflict("relay_operation_mismatch", "A reservation attestation is not expected.")
            updated_handoff = handoff.model_copy(
                update={
                    "reservation_id": attestation.reservation_id,
                    "simulator_request_id": get_or_create_correlation_id(),
                    "status": HandoffStatus.HELD,
                    "remote_etag": attestation.remote_etag,
                    "remote_version": attestation.remote_version,
                    "expires_at": attestation.expires_at,
                }
            )
            target = CustodyState.RESERVED
            event_type = "RELAY_RESERVED"
            reason = (
                "Relay Post returned a SIMULATED service attestation that the reservation is held. "
                "This does not prove physical possession."
            )
        else:
            if outbox.kind != OutboxKind.RELEASE_RELAY or case.state != CustodyState.RELEASE_REQUESTED:
                raise Conflict("relay_operation_mismatch", "A release attestation is not expected.")
            if handoff.reservation_id != attestation.reservation_id:
                raise Conflict("reservation_mismatch", "The release attestation refers to another reservation.")
            updated_handoff = handoff.model_copy(
                update={
                    "status": HandoffStatus.RELEASED,
                    "simulator_request_id": get_or_create_correlation_id(),
                    "remote_etag": attestation.remote_etag,
                    "remote_version": attestation.remote_version,
                }
            )
            target = CustodyState.RELEASED
            event_type = "RELAY_RELEASED"
            reason = (
                "Relay Post returned a SIMULATED service release attestation. "
                "This records service execution, not proof of a physical transfer."
            )
        result = self._mutation(
            case=case,
            target=target,
            event_type=event_type,
            actor="simulator:relay-post",
            reason=reason,
            key=f"relay-attestation:{attestation.attestation_id}",
            fingerprint_data=attestation.model_dump(mode="json"),
            simulator_attestation_id=attestation.attestation_id,
            handoff=updated_handoff,
            task_id=outbox.task_name,
        )
        completed = self.repository.mark_outbox(
            outbox.id,
            OutboxStatus.COMPLETE,
            result_attestation_id=attestation.attestation_id,
            completed_at=self.clock(),
        )
        return {
            "case": CaseView.from_record(self.repository.get_case(case.id)),
            "handoff": HandoffView.from_record(updated_handoff),
            "outbox": completed,
            "replayed": result.duplicate,
        }

    def commit_simulator_callback(self, callback: SimulatorHandoffCallback) -> dict:
        case = self.repository.get_case(callback.case_id)
        if callback.custodian_id != self.settings.relay_custodian_id:
            raise Conflict("relay_custodian_mismatch", "The simulator callback refers to another custodian.")
        if not case.handoff_id:
            raise Conflict("relay_callback_state_invalid", "A final simulator callback is not expected in this state.")
        handoff = self.repository.get_handoff(case.handoff_id)
        if handoff.reservation_id != callback.reservation_id or handoff.item_id != callback.item_id:
            raise Conflict("relay_callback_scope_mismatch", "The simulator callback does not match the handoff.")
        if callback.case_version != handoff.reservation_case_version:
            raise Conflict(
                "relay_callback_version_mismatch",
                "The simulator callback does not match the reservation-bound case version.",
            )
        outboxes = [
            row
            for row in self.repository.list_outboxes(case.id)
            if row.kind == OutboxKind.RELEASE_RELAY
        ]
        if not outboxes:
            raise Conflict("release_outbox_missing", "The callback has no matching release command.")
        outbox = outboxes[-1]
        if case.state != CustodyState.RELEASE_REQUESTED and outbox.status != OutboxStatus.COMPLETE:
            raise Conflict("relay_callback_state_invalid", "A final simulator callback is not expected in this state.")
        return self.commit_relay_attestation(
            RelayAttestation(
                attestation_id=callback.event_id,
                operation="RELEASE",
                status="RELEASED",
                case_id=callback.case_id,
                item_id=callback.item_id,
                outbox_id=outbox.id,
                reservation_id=callback.reservation_id,
                remote_etag=handoff.remote_etag,
                remote_version=callback.reservation_version,
                expected_case_version=outbox.expected_case_version,
                occurred_at=callback.occurred_at,
                simulated=True,
            )
        )

    def issue_tokens(
        self,
        case_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
    ) -> dict:
        case = self.repository.get_case(case_id)
        if case.state != CustodyState.RESERVED or not case.handoff_id:
            raise Conflict("token_issue_not_allowed", "One-time credentials can be issued only for a held reservation.")
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        handoff = self.repository.get_handoff(case.handoff_id)
        if handoff.tokens_issued:
            raise Conflict("tokens_already_issued", "One-time credentials were already issued for this handoff.")
        now = self.clock()
        requested_expiry = min(
            handoff.expires_at or now + timedelta(minutes=10),
            now + timedelta(minutes=10),
        )
        issued = self.relay.issue_credentials(
            case,
            handoff,
            expires_at=requested_expiry,
            idempotency_key=f"case:{case_id}:tokens:{idempotency_key}:relay",
        )
        if issued.expires_at <= now or issued.expires_at > requested_expiry:
            raise Conflict("relay_token_expiry_invalid", "The simulator returned an invalid credential expiry.")
        expires_at = issued.expires_at
        claimant_token = issued.claimant_token
        custodian_token = issued.custodian_token
        claimant_hash = secret_digest(claimant_token, self.settings.secret_pepper)
        custodian_hash = secret_digest(custodian_token, self.settings.secret_pepper)
        records = [
            TokenRecord(
                token_hash=claimant_hash,
                case_id=case.id,
                handoff_id=handoff.id,
                item_id=handoff.item_id,
                purpose=TokenPurpose.CLAIMANT,
                issued_at=now,
                expires_at=expires_at,
            ),
            TokenRecord(
                token_hash=custodian_hash,
                case_id=case.id,
                handoff_id=handoff.id,
                item_id=handoff.item_id,
                purpose=TokenPurpose.CUSTODIAN,
                issued_at=now,
                expires_at=expires_at,
            ),
        ]
        updated_handoff = handoff.model_copy(
            update={
                "claimant_token_hash": claimant_hash,
                "custodian_token_hash": custodian_hash,
                "tokens_issued": True,
                "remote_etag": issued.remote_etag,
                "remote_version": issued.remote_version,
            }
        )
        self._mutation(
            case=case,
            target=case.state,
            event_type="ONE_TIME_CREDENTIALS_ISSUED",
            actor="service:token-vault",
            reason="Issued two short-lived one-time credentials; only their keyed hashes were persisted.",
            key=f"case:{case_id}:tokens:{idempotency_key}",
            fingerprint_data={"case_id": case_id, "handoff_id": handoff.id},
            handoff=updated_handoff,
            tokens=records,
            allow_fact_event=True,
        )
        return {
            "case": CaseView.from_record(self.repository.get_case(case_id)),
            "handoff": HandoffView.from_record(updated_handoff),
            "claimant_token": claimant_token,
            "custodian_token": custodian_token,
            "expires_at": expires_at,
            "disclosure": "Token presentation is a SIMULATED service attestation, not proof of physical possession.",
        }

    def attest_token(
        self,
        case_id: str,
        *,
        expected_version: int,
        handoff_id: str,
        purpose: TokenPurpose,
        token: str,
        idempotency_key: str,
    ) -> dict:
        case = self.repository.get_case(case_id)
        if case.handoff_id != handoff_id or case.state not in {CustodyState.RESERVED, CustodyState.CLAIMANT_PRESENT}:
            raise Conflict("token_attestation_not_allowed", "Token presentation is not allowed in this state.")
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        target = (
            CustodyState.CLAIMANT_PRESENT
            if purpose == TokenPurpose.CLAIMANT and case.state == CustodyState.RESERVED
            else case.state
        )
        handoff = self.repository.get_handoff(handoff_id)
        presentation = self.relay.attest_token(
            case,
            handoff,
            purpose=purpose,
            token=token,
            idempotency_key=f"case:{case_id}:token-attest:{idempotency_key}:relay",
        )
        token_hash = secret_digest(token, self.settings.secret_pepper)
        result = self.repository.consume_token(
            case_id=case_id,
            handoff_id=handoff_id,
            token_hash=token_hash,
            purpose=purpose,
            expected_version=expected_version,
            target_state=target,
            actor=f"simulator:{purpose.value.lower()}-scanner",
            idempotency_key=f"case:{case_id}:token-attest:{idempotency_key}",
            fingerprint=sha256_hex(
                {"case_id": case_id, "handoff_id": handoff_id, "purpose": purpose, "token_hash": token_hash}
            ),
            occurred_at=self.clock(),
            remote_etag=presentation.remote_etag,
            remote_version=presentation.remote_version,
        )
        handoff = self.repository.get_handoff(handoff_id)
        return {
            "case": CaseView.from_record(self.repository.get_case(case_id)),
            "handoff": HandoffView.from_record(handoff),
            "replayed": result.duplicate,
            "physical_possession_proven": False,
        }

    def begin_release(
        self,
        case_id: str,
        *,
        expected_version: int,
        staff_user_id: str,
        idempotency_key: str,
    ) -> dict:
        case = self.repository.get_case(case_id)
        if case.state == CustodyState.RELEASE_REQUESTED and case.handoff_id:
            rows = [row for row in self.repository.list_outboxes(case_id) if row.kind == OutboxKind.RELEASE_RELAY]
            if not rows:
                raise Conflict("release_outbox_missing", "The release intent has no outbox command.")
            outbox = rows[-1]
            return {
                "case": CaseView.from_record(case),
                "handoff": HandoffView.from_record(self.repository.get_handoff(case.handoff_id)),
                "outbox": outbox,
                "task": self._existing_task_receipt(outbox),
                "replayed": True,
            }
        if case.state != CustodyState.CLAIMANT_PRESENT or not case.handoff_id:
            raise Conflict("release_not_allowed", "A release cannot begin in this state.")
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        handoff = self.repository.get_handoff(case.handoff_id)
        now = self.clock()
        if handoff.status != HandoffStatus.HELD:
            raise Conflict("handoff_not_held", "The SIMULATED relay reservation is not held.")
        if not handoff.claimant_attested_at or not handoff.custodian_attested_at:
            raise Conflict("token_attestations_missing", "Both token presentations are required before release.")
        if handoff.expires_at and now >= handoff.expires_at:
            raise Conflict("handoff_expired", "The SIMULATED relay reservation expired.")
        outbox = make_outbox(OutboxKind.RELEASE_RELAY, case, created_at=now)
        updated_handoff = handoff.model_copy(update={"staff_confirmed_at": now})
        self._mutation(
            case=case,
            target=CustodyState.RELEASE_REQUESTED,
            event_type="RELAY_RELEASE_REQUESTED",
            actor=staff_user_id,
            reason=(
                "Staff confirmed the scoped release request after both one-time token attestations. "
                "This remains a SIMULATED service workflow."
            ),
            key=f"case:{case_id}:release:{idempotency_key}",
            fingerprint_data={"case_id": case_id, "handoff_id": handoff.id, "staff": staff_user_id},
            outbox=outbox,
            handoff=updated_handoff,
            task_id=outbox.task_name,
        )
        publish_result = self._publish_outbox(outbox)
        return {
            "case": CaseView.from_record(self.repository.get_case(case_id)),
            "handoff": HandoffView.from_record(updated_handoff),
            "outbox": outbox,
            "task": publish_result,
        }

    def close_case(self, case_id: str, *, expected_version: int, idempotency_key: str) -> EventManifest:
        case = self.repository.get_case(case_id)
        if case.state == CustodyState.CLOSED:
            return self.build_manifest(case_id)
        if case.state != CustodyState.RELEASED or not case.handoff_id:
            raise Conflict("close_not_allowed", "The Item Passport can close only after a service release attestation.")
        if case.version != expected_version:
            raise Conflict(
                "stale_case_version",
                f"Expected Item Passport version {expected_version}; current version is {case.version}.",
            )
        handoff = self.repository.get_handoff(case.handoff_id)
        if (
            handoff.status != HandoffStatus.RELEASED
            or not handoff.claimant_attested_at
            or not handoff.custodian_attested_at
            or not handoff.staff_confirmed_at
        ):
            raise Conflict("handoff_incomplete", "The service handoff record is incomplete.")
        self.verify_event_chain(case_id)
        self._mutation(
            case=case,
            target=CustodyState.CLOSED,
            event_type="ITEM_PASSPORT_CLOSED",
            actor="service:custody",
            reason=(
                "Closed the Item Passport after internally consistent SIMULATED service attestations. "
                "Closure does not prove a physical transfer."
            ),
            key=f"case:{case_id}:close:{idempotency_key}",
            fingerprint_data={"case_id": case_id, "handoff_id": handoff.id},
        )
        return self.build_manifest(case_id)

    def verify_event_chain(self, case_id: str) -> bool:
        events = self.repository.list_events(case_id)
        previous = "0" * 64
        for expected_sequence, event in enumerate(events, start=1):
            if event.sequence != expected_sequence or event.previous_hash != previous:
                raise Conflict("event_chain_invalid", "The application event chain is internally inconsistent.")
            unsigned = event.model_dump(mode="python", exclude={"event_hash"})
            if sha256_hex(unsigned) != event.event_hash:
                raise Conflict("event_chain_invalid", "The application event chain is internally inconsistent.")
            previous = event.event_hash
        case = self.repository.get_case(case_id)
        if case.last_event_sequence != len(events) or case.last_event_hash != previous:
            raise Conflict("event_chain_invalid", "The Item Passport event pointer is inconsistent.")
        return True

    def build_manifest(self, case_id: str) -> EventManifest:
        case = self.repository.get_case(case_id)
        if case.state != CustodyState.CLOSED:
            raise Conflict("manifest_not_ready", "The event manifest is available only for a closed Item Passport.")
        self.verify_event_chain(case_id)
        events = self.repository.list_events(case_id)
        evidence_refs = sorted({reference for event in events for reference in event.evidence_refs})
        evidence_digests = [sha256_hex({"evidence_ref": reference}) for reference in evidence_refs]
        manifest_body = {
            "case_id": case.id,
            "final_version": case.version,
            "event_hashes": [event.event_hash for event in events],
            "evidence_digests": evidence_digests,
        }
        return EventManifest(
            manifest_id=f"manifest-{sha256_hex(manifest_body)[:24]}",
            case_id=case.id,
            final_state=CustodyState.CLOSED,
            final_version=case.version,
            event_count=len(events),
            first_event_hash=events[0].event_hash,
            final_event_hash=events[-1].event_hash,
            event_ids=[event.id for event in events],
            evidence_digests=evidence_digests,
        )

    def create_intake(
        self,
        *,
        safety_result: str,
        category: str,
        risk_tier: RiskTier,
        assigned_tenant: str,
        current_holder: str,
        public_description: str,
        found_at: datetime,
        found_zone: str,
        report_route: list[str],
        actor: str,
        idempotency_key: str,
    ) -> dict:
        if safety_result != "ORDINARY_ITEM":
            return {
                "accepted": False,
                "case": None,
                "instruction": (
                    "Do not photograph, move, or upload the item. Follow the custodian's local emergency or security procedure."
                ),
                "model_called": False,
                "record_created": False,
                "guidance": specialist_intake_guidance(category, assigned_tenant),
            }
        if category_requires_specialist(category) or risk_tier in {RiskTier.DANGEROUS, RiskTier.SENSITIVE}:
            return {
                "accepted": False,
                "case": None,
                "instruction": "The category requires a local specialist workflow outside ordinary Found Roll recovery.",
                "model_called": False,
                "record_created": False,
                "guidance": specialist_intake_guidance(category, assigned_tenant),
            }
        identity_digest = secret_digest(
            sha256_hex({"idempotency_key": idempotency_key}),
            self.settings.secret_pepper,
        )
        case_id = f"case-{identity_digest[:20]}"
        command_fingerprint = sha256_hex(
            {
                "safety_result": safety_result,
                "category": category,
                "risk_tier": risk_tier,
                "assigned_tenant": assigned_tenant,
                "current_holder": current_holder,
                "public_description": public_description,
                "found_at": found_at,
                "found_zone": found_zone,
                "report_route": report_route,
                "actor": actor,
            }
        )
        occurred_at = self.clock()
        case = CaseRecord(
            id=case_id,
            state=CustodyState.RECEIVED,
            version=0,
            category=category,
            risk_tier=risk_tier,
            assigned_tenant=assigned_tenant,
            current_holder=current_holder,
            public_description=public_description,
            found_at=found_at,
            found_zone=found_zone,
            report_route=report_route,
            analysis_auto_start_armed=True,
            created_at=occurred_at,
            updated_at=occurred_at,
        )
        result = self.repository.create_case(
            case,
            [],
            actor=actor,
            reason=(
                "Created an Item Passport after the local ordinary-item safety screen. "
                "No ownership or physical possession claim is made."
            ),
            idempotency_key=f"intake:{identity_digest}",
            occurred_at=occurred_at,
            fingerprint=command_fingerprint,
        )
        return {
            "accepted": True,
            "case": CaseView.from_record(self.repository.get_case(result.receipt.case_id)),
            "event": result.event,
            "model_called": False,
            "record_created": True,
        }
