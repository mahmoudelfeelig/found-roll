from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Event, Lock
import time

from google.adk.agents.invocation_context import InvocationContext, LlmCallsLimitExceededError
import pytest

from app.agent import VertexAdkCaseAnalyst
from app.custody_service import ANALYSIS_EXECUTION_LEASE
from app.domain import (
    AnalysisProposal,
    OpaqueTaskPayload,
    OutboxFailureStage,
    OutboxStatus,
    SimulatorHandoffCallback,
)
from app.errors import Conflict, DomainError, Unavailable
from app.hashing import signed_body
from app.relay import callback_canonical_json
from conftest import STAFF_HEADERS, reserve_and_issue_tokens


def test_camera_pouch_workflow_closes_with_consistent_manifest(client, case_id):
    reserved, tokens = reserve_and_issue_tokens(client, case_id)
    assert reserved["case"]["state"] == "RESERVED"
    handoff_id = tokens["handoff"]["id"]

    custodian = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": 14,
            "idempotency_key": "custodian-scan-001",
            "handoff_id": handoff_id,
            "purpose": "CUSTODIAN",
            "token": tokens["custodian_token"],
        },
    )
    assert custodian.status_code == 200, custodian.text
    assert custodian.json()["physical_possession_proven"] is False

    claimant = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": 15,
            "idempotency_key": "claimant-scan-001",
            "handoff_id": handoff_id,
            "purpose": "CLAIMANT",
            "token": tokens["claimant_token"],
        },
    )
    assert claimant.status_code == 200, claimant.text
    assert claimant.json()["case"]["state"] == "CLAIMANT_PRESENT"

    release = client.post(
        f"/api/v1/passports/{case_id}/releases",
        json={
            "expected_version": 16,
            "idempotency_key": "release-test-001",
            "staff_user_id": "staff.northport",
        },
        headers=STAFF_HEADERS,
    )
    assert release.status_code == 200, release.text
    release_task = release.json()["task"]["payload"]
    released = client.post("/tasks/outbox", json=release_task)
    assert released.status_code == 200, released.text
    assert released.json()["case"]["state"] == "RELEASED"

    before_replay_count = len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"])
    replay = client.post("/tasks/outbox", json=release_task)
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == before_replay_count

    closed = client.post(
        f"/api/v1/passports/{case_id}/close",
        json={"expected_version": 18, "idempotency_key": "close-test-001"},
    )
    assert closed.status_code == 200, closed.text
    manifest = closed.json()
    assert manifest["final_state"] == "CLOSED"
    assert manifest["internally_consistent"] is True
    assert manifest["physical_transfer_proven"] is False
    assert manifest["event_count"] == 19
    assert len(manifest["final_event_hash"]) == 64
    assert client.get(f"/api/v1/passports/{case_id}/manifest").json() == manifest
    actor_by_type = {
        event["type"]: event["actor"]
        for event in client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    }
    assert actor_by_type["IDENTITY_ATTESTED"] == "staff.northport"
    assert actor_by_type["SUPERVISOR_APPROVED"] == "supervisor.northport"
    assert actor_by_type["RELAY_RELEASE_REQUESTED"] == "staff.northport"

    before_queued_replay = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    queued_replay = client.post(
        f"/api/v1/passports/{case_id}/release-task-replays",
        json={"idempotency_key": "release-task-replay-001"},
        headers=STAFF_HEADERS,
    )
    assert queued_replay.status_code == 200, queued_replay.text
    assert queued_replay.json()["task"]["mode"] == "inline"
    replay_delivery = client.post(
        "/tasks/outbox",
        json=queued_replay.json()["task"]["payload"],
        headers={"X-CloudTasks-TaskName": queued_replay.json()["task"]["task_name"]},
    )
    assert replay_delivery.status_code == 200, replay_delivery.text
    assert replay_delivery.json()["replayed"] is True
    assert replay_delivery.json()["outbox"]["replay_count"] == 2
    assert queued_replay.json()["task"]["task_name"].startswith("fr-replay-")
    assert queued_replay.json()["task"]["task_name"] != release.json()["task"]["task_name"]
    assert replay_delivery.json()["outbox"]["last_replay_task_name"] == queued_replay.json()["task"]["task_name"]
    after_queued_replay = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    assert after_queued_replay == before_queued_replay


def test_one_time_token_replay_is_rejected_without_second_event(client, case_id):
    _reserved, tokens = reserve_and_issue_tokens(client, case_id)
    handoff_id = tokens["handoff"]["id"]
    first = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": 14,
            "idempotency_key": "custodian-first-001",
            "handoff_id": handoff_id,
            "purpose": "CUSTODIAN",
            "token": tokens["custodian_token"],
        },
    )
    assert first.status_code == 200
    count_after_first = len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"])
    replay = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": 15,
            "idempotency_key": "custodian-replay-002",
            "handoff_id": handoff_id,
            "purpose": "CUSTODIAN",
            "token": tokens["custodian_token"],
        },
    )
    assert replay.status_code == 409
    assert replay.json()["error"]["code"] == "token_replayed"
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == count_after_first


def test_opaque_task_contains_identifiers_only(client, case_id):
    response = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "opaque-task-001"},
    )
    assert response.status_code == 200
    payload = response.json()["task"]["payload"]
    assert set(payload) == {"schema_version", "case_id", "outbox_id"}
    serialized = str(payload).lower()
    for forbidden in ("4118", "answer", "token", "image", "description", "signed"):
        assert forbidden not in serialized


def test_duplicate_analysis_task_creates_no_duplicate_event(client, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-replay-001"},
    ).json()
    task = started["task"]["payload"]
    first = client.post("/tasks/outbox", json=task)
    assert first.status_code == 200
    first_count = len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"])
    second = client.post("/tasks/outbox", json=task)
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == first_count


def test_concurrent_analysis_deliveries_call_the_analyst_exactly_once(client, app, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-concurrent-001"},
    )
    assert started.status_code == 200, started.text
    payload = OpaqueTaskPayload.model_validate(started.json()["task"]["payload"])
    service = app.state.custody_service
    delegate = service.analyst
    entered = Event()
    release = Event()
    calls_lock = Lock()
    analyst_calls = 0

    class BlockingAnalyst:
        mode = delegate.mode
        model_name = delegate.model_name
        prompt_version = delegate.prompt_version
        output_schema_version = delegate.output_schema_version

        @staticmethod
        def analyze(case, candidates):
            nonlocal analyst_calls
            with calls_lock:
                analyst_calls += 1
            entered.set()
            if not release.wait(timeout=5):
                raise AssertionError("the deterministic concurrency test did not release the winner")
            return delegate.analyze(case, candidates)

    def deliver():
        try:
            return "ok", service.process_outbox(payload)
        except DomainError as exc:
            return "error", exc

    service.analyst = BlockingAnalyst()
    with ThreadPoolExecutor(max_workers=2) as pool:
        winner = pool.submit(deliver)
        assert entered.wait(timeout=5), "the first delivery never reached the analyst boundary"
        duplicate = pool.submit(deliver)
        duplicate_kind, duplicate_result = duplicate.result(timeout=5)
        try:
            assert duplicate_kind == "error"
            assert isinstance(duplicate_result, Unavailable)
            assert duplicate_result.code == "analysis_execution_in_progress"
            assert analyst_calls == 1
        finally:
            release.set()
        winner_kind, winner_result = winner.result(timeout=5)

    assert winner_kind == "ok"
    assert winner_result["outbox"].status == OutboxStatus.COMPLETE
    assert analyst_calls == 1


def test_stale_analysis_claim_fails_closed_without_second_analyst_call(client, app, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-stale-claim-001"},
    )
    assert started.status_code == 200, started.text
    payload = OpaqueTaskPayload.model_validate(started.json()["task"]["payload"])
    service = app.state.custody_service
    repository = service.repository
    claimed_at = datetime(2026, 8, 30, 10, 0, tzinfo=timezone.utc)
    repository.claim_outbox_execution(
        payload.outbox_id,
        claim_token="abandoned-analysis-claim-token",
        claimed_at=claimed_at,
        lease_expires_at=claimed_at + timedelta(seconds=1),
    )
    service.clock = lambda: claimed_at + timedelta(seconds=2)
    analyst_calls = 0

    class CountingAnalyst:
        mode = "must-not-run"
        model_name = "must-not-run"
        prompt_version = "must-not-run"
        output_schema_version = "found-roll-analysis-proposal-v1"

        @staticmethod
        def analyze(_case, _candidates):
            nonlocal analyst_calls
            analyst_calls += 1
            raise AssertionError("a stale execution claim must never re-call the analyst")

    service.analyst = CountingAnalyst()
    with pytest.raises(Unavailable) as raised:
        service.process_outbox(payload)

    assert raised.value.code == "analysis_execution_ambiguous"
    assert analyst_calls == 0
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "MANUAL_REVIEW"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "EXECUTE"
    assert snapshot["events"][-1]["idempotency_key"] == (
        f"outbox:{payload.outbox_id}:manual-review"
    )
    assert "without a second model call" in snapshot["events"][-1]["reason"]


def test_replaced_stale_claim_cannot_commit_the_original_analyst_result(client, app, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-stale-race-001"},
    )
    assert started.status_code == 200, started.text
    payload = OpaqueTaskPayload.model_validate(started.json()["task"]["payload"])
    service = app.state.custody_service
    delegate = service.analyst
    entered = Event()
    release = Event()
    analyst_calls = 0
    current_time = datetime(2026, 8, 30, 13, 0, tzinfo=timezone.utc)
    service.clock = lambda: current_time

    class SlowAnalyst:
        mode = delegate.mode
        model_name = delegate.model_name
        prompt_version = delegate.prompt_version
        output_schema_version = delegate.output_schema_version

        @staticmethod
        def analyze(case, candidates):
            nonlocal analyst_calls
            analyst_calls += 1
            entered.set()
            if not release.wait(timeout=5):
                raise AssertionError("the stale-race test did not release the original worker")
            return delegate.analyze(case, candidates)

    def deliver():
        try:
            return "ok", service.process_outbox(payload)
        except DomainError as exc:
            return "error", exc

    service.analyst = SlowAnalyst()
    with ThreadPoolExecutor(max_workers=2) as pool:
        original = pool.submit(deliver)
        assert entered.wait(timeout=5), "the original delivery never reached the analyst boundary"
        current_time += ANALYSIS_EXECUTION_LEASE + timedelta(seconds=1)
        replacement = pool.submit(deliver)
        replacement_kind, replacement_result = replacement.result(timeout=5)
        try:
            assert replacement_kind == "error"
            assert isinstance(replacement_result, Unavailable)
            assert replacement_result.code == "analysis_execution_ambiguous"
        finally:
            release.set()
        original_kind, original_result = original.result(timeout=5)

    assert original_kind == "error"
    assert isinstance(original_result, Conflict)
    assert original_result.code == "outbox_execution_claim_lost"
    assert analyst_calls == 1
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "MANUAL_REVIEW"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert [event["type"] for event in snapshot["events"]].count(
        "CANDIDATE_PACKET_PROPOSED"
    ) == 0


def test_only_execution_claim_winner_can_write_analysis_terminal_state(client, app, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-claim-token-001"},
    )
    assert started.status_code == 200, started.text
    outbox_id = started.json()["outbox"]["id"]
    repository = app.state.custody_service.repository
    claimed_at = datetime(2026, 8, 30, 11, 0, tzinfo=timezone.utc)
    repository.claim_outbox_execution(
        outbox_id,
        claim_token="winning-analysis-claim-token",
        claimed_at=claimed_at,
        lease_expires_at=claimed_at + timedelta(minutes=5),
    )

    with pytest.raises(Conflict) as raised:
        repository.mark_outbox_execution(
            outbox_id,
            OutboxStatus.FAILED,
            claim_token="losing-analysis-claim-token",
            completed_at=claimed_at + timedelta(seconds=1),
            failure_stage=OutboxFailureStage.EXECUTE,
            failure_code="analyst_unavailable",
        )

    assert raised.value.code == "outbox_execution_claim_lost"
    assert repository.get_outbox(outbox_id).status == OutboxStatus.PENDING
    terminal = repository.mark_outbox_execution(
        outbox_id,
        OutboxStatus.FAILED,
        claim_token="winning-analysis-claim-token",
        completed_at=claimed_at + timedelta(seconds=2),
        failure_stage=OutboxFailureStage.EXECUTE,
        failure_code="analyst_unavailable",
    )
    assert terminal.status == OutboxStatus.FAILED


def test_analysis_call_ceiling_enters_manual_review_and_acks_terminal_redelivery(
    client, app, case_id, monkeypatch
):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-call-cap-001"},
    )
    assert started.status_code == 200, started.text
    task = started.json()["task"]["payload"]
    task_headers = {
        "X-CloudTasks-TaskName": "projects/p/locations/l/queues/q/tasks/analysis-call-cap"
    }

    def exhaust_call_budget(_context):
        raise LlmCallsLimitExceededError("Max number of llm calls limit of `8` exceeded")

    app.state.custody_service.analyst = VertexAdkCaseAnalyst(
        project="fixture-project",
        location="us-central1",
        model_name="gemini-3.5-flash",
    )
    monkeypatch.setattr(InvocationContext, "increment_llm_call_count", exhaust_call_budget)
    failed = client.post("/tasks/outbox", json=task, headers=task_headers)
    assert failed.status_code == 503, failed.text
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "MANUAL_REVIEW"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "EXECUTE"
    assert snapshot["outbox"][-1]["failure_code"] == "analyst_unavailable"
    assert snapshot["events"][-1]["type"] == "ANALYST_UNAVAILABLE"
    event_count = len(snapshot["events"])

    redelivery = client.post("/tasks/outbox", json=task, headers=task_headers)
    assert redelivery.status_code == 200, redelivery.text
    assert redelivery.json()["terminal_failure_acknowledged"] is True
    assert redelivery.json()["retryable"] is False
    assert redelivery.json()["manual_action_required"] is True
    assert redelivery.json()["case"]["state"] == "MANUAL_REVIEW"
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == event_count


def test_policy_invalid_analyst_output_enters_manual_review_and_acks_redelivery(client, app, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-policy-invalid-001"},
    )
    assert started.status_code == 200, started.text
    task = started.json()["task"]["payload"]

    class PolicyInvalidAnalyst:
        mode = "test-policy-invalid"
        model_name = "test-policy-invalid"
        prompt_version = "test-policy-invalid"
        output_schema_version = "found-roll-analysis-proposal-v1"

        @staticmethod
        def analyze(_case, _candidates):
            return "policy-invalid-run", AnalysisProposal(
                ranked_candidate_ids=["candidate-outside-authorized-set"],
                selected_candidate_id="candidate-outside-authorized-set",
                visible_signals=["untrusted signal"],
                evidence_sufficient_for_claim=False,
                restricted_attribute_id="untrusted_attribute",
                next_question="What private distinguishing detail is recorded by staff?",
                tool_trajectory=["submit_observations"],
            )

    app.state.custody_service.analyst = PolicyInvalidAnalyst()
    failed = client.post("/tasks/outbox", json=task)
    assert failed.status_code == 409, failed.text
    assert failed.json()["error"]["code"] == "agent_scope_violation"
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "MANUAL_REVIEW"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "EXECUTE"
    assert snapshot["outbox"][-1]["failure_code"] == "analyst_policy_conflict"
    assert snapshot["events"][-1]["type"] == "ANALYST_REVIEW_REQUIRED"
    event_count = len(snapshot["events"])

    redelivery = client.post("/tasks/outbox", json=task)
    assert redelivery.status_code == 200, redelivery.text
    assert redelivery.json()["terminal_failure_acknowledged"] is True
    assert redelivery.json()["manual_action_required"] is True
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == event_count


def test_pre_model_candidate_conflict_uses_truthful_manual_review_narrative(client, app, case_id):
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-no-candidate-001"},
    )
    assert started.status_code == 200, started.text

    class NoEligibleCandidateAnalyst:
        mode = "deterministic-pre-model"
        model_name = "not-called"
        prompt_version = "deterministic-pre-model"
        output_schema_version = "found-roll-analysis-proposal-v1"

        @staticmethod
        def analyze(_case, _candidates):
            raise Conflict(
                "no_eligible_candidates",
                "No candidate survived the deterministic hard filters.",
            )

    app.state.custody_service.analyst = NoEligibleCandidateAnalyst()
    failed = client.post("/tasks/outbox", json=started.json()["task"]["payload"])
    assert failed.status_code == 409, failed.text
    event = client.get(f"/api/v1/passports/{case_id}/events").json()["items"][-1]
    assert event["type"] == "ANALYST_REVIEW_REQUIRED"
    assert "could not produce an acceptable custody proposal" in event["reason"]
    assert "returned a proposal" not in event["reason"]


def test_analysis_failure_recovers_after_manual_review_outbox_write_crash(
    client, app, case_id, monkeypatch
):
    production_minimum_retry_backoff = timedelta(seconds=10)
    assert ANALYSIS_EXECUTION_LEASE < production_minimum_retry_backoff
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-terminal-write-crash-001"},
    )
    assert started.status_code == 200, started.text
    task = started.json()["task"]["payload"]
    analyst_calls = 0

    class UnavailableAnalyst:
        mode = "test-unavailable"
        model_name = "test-unavailable"
        prompt_version = "test-unavailable"
        output_schema_version = "found-roll-analysis-proposal-v1"

        @staticmethod
        def analyze(_case, _candidates):
            nonlocal analyst_calls
            analyst_calls += 1
            raise Unavailable("test_analyst_unavailable", "Synthetic analyst outage.")

    service = app.state.custody_service
    service.analyst = UnavailableAnalyst()
    fixed_now = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
    service.clock = lambda: fixed_now
    original_mark_outbox_execution = service.repository.mark_outbox_execution
    terminal_write_failed = False

    def fail_first_terminal_write(outbox_id, status, **kwargs):
        nonlocal terminal_write_failed
        if status == OutboxStatus.FAILED and not terminal_write_failed:
            terminal_write_failed = True
            raise RuntimeError("synthetic outbox terminal-write crash")
        return original_mark_outbox_execution(outbox_id, status, **kwargs)

    monkeypatch.setattr(service.repository, "mark_outbox_execution", fail_first_terminal_write)
    interrupted = client.post("/tasks/outbox", json=task)
    assert interrupted.status_code == 500, interrupted.text

    partial = client.get(f"/api/v1/passports/{case_id}").json()
    assert partial["case"]["state"] == "MANUAL_REVIEW"
    assert partial["outbox"][-1]["status"] == "DISPATCHED"
    assert partial["events"][-1]["type"] == "ANALYST_UNAVAILABLE"
    event_count = len(partial["events"])

    # The first configured Cloud Tasks retry occurs after ten seconds. It must
    # already be able to recover the partial terminal write; waiting for an
    # exhausted long lease would strand this DISPATCHED command.
    fixed_now += production_minimum_retry_backoff
    monkeypatch.setattr(
        service.repository,
        "mark_outbox_execution",
        original_mark_outbox_execution,
    )
    recovered = client.post("/tasks/outbox", json=task)
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["terminal_failure_acknowledged"] is True
    assert recovered.json()["outbox"]["status"] == "FAILED"
    assert recovered.json()["outbox"]["failure_code"] == "analyst_unavailable"
    assert analyst_calls == 1
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == event_count


def test_signed_simulator_callback_commits_once_and_replay_is_idempotent(client, case_id):
    _reserved, tokens = reserve_and_issue_tokens(client, case_id)
    handoff_id = tokens["handoff"]["id"]
    custodian = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": 14,
            "idempotency_key": "callback-custodian-001",
            "handoff_id": handoff_id,
            "purpose": "CUSTODIAN",
            "token": tokens["custodian_token"],
        },
    )
    assert custodian.status_code == 200
    claimant = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": 15,
            "idempotency_key": "callback-claimant-001",
            "handoff_id": handoff_id,
            "purpose": "CLAIMANT",
            "token": tokens["claimant_token"],
        },
    )
    assert claimant.status_code == 200
    release = client.post(
        f"/api/v1/passports/{case_id}/releases",
        json={
            "expected_version": 16,
            "idempotency_key": "callback-release-001",
            "staff_user_id": "staff.northport",
        },
        headers=STAFF_HEADERS,
    )
    assert release.status_code == 200
    handoff = release.json()["handoff"]
    callback = SimulatorHandoffCallback(
        event_id="sim-callback-event-001",
        event_type="SIMULATED_TOKEN_HANDOFF_ATTESTED",
        simulation={
            "mode": "SIMULATED",
            "notice": "This service attestation does not prove physical possession.",
        },
        reservation_id=handoff["reservation_id"],
        case_id=case_id,
        case_version=handoff["reservation_case_version"],
        item_id=handoff["item_id"],
        custodian_id="northport-air",
        reservation_version=handoff["remote_version"] + 1,
        item_version=7,
        occurred_at=datetime.now(timezone.utc),
        attestation_statement="Both scoped tokens were presented in the disclosed simulated relay.",
    )
    body = callback_canonical_json(callback.model_dump(mode="json"))
    timestamp = str(int(time.time()))
    signature = "v1=" + signed_body(
        timestamp.encode("utf-8") + b"." + body,
        "found-roll-local-relay-secret",
    )
    headers = {
        "Content-Type": "application/json",
        "X-Found-Roll-Simulator-Timestamp": timestamp,
        "X-Found-Roll-Simulator-Signature": signature,
    }
    first = client.post("/api/v1/relay/callbacks", content=body, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["case"]["state"] == "RELEASED"
    count = len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"])
    replay = client.post("/api/v1/relay/callbacks", content=body, headers=headers)
    assert replay.status_code == 200, replay.text
    assert replay.json()["replayed"] is True
    assert len(client.get(f"/api/v1/passports/{case_id}/events").json()["items"]) == count


def test_ambiguous_release_failure_acknowledges_terminal_task_without_reexecution(
    client, app, case_id
):
    _reserved, tokens = reserve_and_issue_tokens(client, case_id)
    handoff_id = tokens["handoff"]["id"]
    case = tokens["case"]
    for purpose, token in (
        ("CUSTODIAN", tokens["custodian_token"]),
        ("CLAIMANT", tokens["claimant_token"]),
    ):
        response = client.post(
            f"/api/v1/passports/{case_id}/token-attestations",
            json={
                "expected_version": case["version"],
                "idempotency_key": f"reconcile-{purpose.lower()}-001",
                "handoff_id": handoff_id,
                "purpose": purpose,
                "token": token,
            },
        )
        assert response.status_code == 200, response.text
        case = response.json()["case"]

    release = client.post(
        f"/api/v1/passports/{case_id}/releases",
        json={
            "expected_version": case["version"],
            "idempotency_key": "reconcile-release-001",
            "staff_user_id": "staff.northport",
        },
        headers=STAFF_HEADERS,
    )
    assert release.status_code == 200, release.text
    task = release.json()["task"]["payload"]

    class AmbiguousRelay:
        mode = "fixture"

        def __init__(self):
            self.calls = 0

        def execute(self, *_args, **_kwargs):
            self.calls += 1
            raise Unavailable("relay_unavailable", "The simulator response was ambiguous.")

    relay = AmbiguousRelay()
    app.state.custody_service.relay = relay
    task_headers = {
        "X-CloudTasks-TaskName": "projects/p/locations/l/queues/q/tasks/release"
    }
    failed = client.post("/tasks/outbox", json=task, headers=task_headers)
    assert failed.status_code == 503, failed.text
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "RECONCILIATION_REQUIRED"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "EXECUTE"
    assert snapshot["events"][-1]["type"] == "RELAY_RECONCILIATION_REQUIRED"
    event_count = len(snapshot["events"])

    retried = client.post("/tasks/outbox", json=task, headers=task_headers)
    assert retried.status_code == 200
    assert retried.json()["terminal_failure_acknowledged"] is True
    assert retried.json()["retryable"] is False
    assert retried.json()["manual_action_required"] is True
    assert retried.json()["outbox"]["status"] == "FAILED"
    assert retried.json()["outbox"]["failure_stage"] == "EXECUTE"
    assert retried.json()["case"]["state"] == "RECONCILIATION_REQUIRED"
    assert relay.calls == 1
    after_retry = client.get(f"/api/v1/passports/{case_id}").json()
    assert len(after_retry["events"]) == event_count

    operator_recovery = client.post(
        "/api/v1/admin/demo/outbox/reconcile",
        json={"max_items": 10},
        headers={
            "X-Found-Roll-Admin-Token": app.state.custody_service.settings.admin_token
        },
    )
    assert operator_recovery.status_code == 200
    assert operator_recovery.json()["eligible"] == 0
    assert relay.calls == 1
