from datetime import datetime, timezone
import time

from app.domain import SimulatorHandoffCallback
from app.errors import Unavailable
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


def test_ambiguous_release_failure_enters_reconciliation_and_cannot_retry_automatically(
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
    failed = client.post("/tasks/outbox", json=task)
    assert failed.status_code == 503, failed.text
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "RECONCILIATION_REQUIRED"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "EXECUTE"
    assert snapshot["events"][-1]["type"] == "RELAY_RECONCILIATION_REQUIRED"
    event_count = len(snapshot["events"])

    retried = client.post("/tasks/outbox", json=task)
    assert retried.status_code == 409
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
