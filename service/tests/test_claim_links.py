from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.config import Settings
from app.fixtures import DEMO_CASE_ID
from app.main import create_app
from conftest import STAFF_HEADERS, begin_and_process_analysis


CLAIMANT_CASE_FIELDS = {
    "id",
    "state",
    "version",
    "public_description",
    "found_date_label",
    "route_label",
    "synthetic_custodian_label",
    "next_question",
    "attempt_count",
    "link",
}
CLAIMANT_LINK_FIELDS = {
    "active",
    "issued_case_version",
    "issued_at",
    "expires_at",
}
RESTRICTED_CLAIMANT_FIELDS = {
    "current_holder",
    "found_zone",
    "report_route",
    "candidate_ids",
    "selected_item_id",
    "model_run_id",
    "model_name",
    "model_mode",
    "task_id",
    "events",
    "outbox",
    "handoff",
    "remote_etag",
    "etag",
}
RESTRICTED_CLAIMANT_VALUES = {
    "Northport Air secure dropbox",
    "Terminal C security return",
    "GH-PCH-104",
    "ML-PCH-219",
    "NA-PCH-231",
    '"na-231-v5"',
}


def _assert_no_restricted_claimant_fields(payload) -> None:
    if isinstance(payload, dict):
        assert RESTRICTED_CLAIMANT_FIELDS.isdisjoint(key.lower() for key in payload)
        for value in payload.values():
            _assert_no_restricted_claimant_fields(value)
    elif isinstance(payload, list):
        for value in payload:
            _assert_no_restricted_claimant_fields(value)

    serialized = repr(payload)
    assert all(value not in serialized for value in RESTRICTED_CLAIMANT_VALUES)


def _assert_claimant_projection(case: dict, *, link_active: bool) -> None:
    assert set(case) == CLAIMANT_CASE_FIELDS
    assert set(case["link"]) == CLAIMANT_LINK_FIELDS
    assert case["link"]["active"] is link_active
    assert case["synthetic_custodian_label"] == "Participating custodian (SIMULATED)"
    assert case["route_label"] == "3 reported route stops"
    assert case["found_date_label"] == "2026-08-28 UTC"
    _assert_no_restricted_claimant_fields(case)


def _issue_link(client: TestClient, *, version: int = 5, key: str = "claim-link-test-001") -> dict:
    response = client.post(
        f"/api/v1/passports/{DEMO_CASE_ID}/claim-links",
        json={"expected_version": version, "idempotency_key": key},
        headers=STAFF_HEADERS,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _submit(client: TestClient, *, token: str | None, version: int, answer: str, key: str):
    headers = {"X-Found-Roll-Claim-Link": token} if token else {}
    return client.post(
        f"/api/v1/passports/{DEMO_CASE_ID}/claim-evidence",
        json={"expected_version": version, "idempotency_key": key, "answer": answer},
        headers=headers,
    )


def test_claim_evidence_requires_a_scoped_link_and_consumes_it_once(client, case_id):
    begin_and_process_analysis(client, case_id)

    missing = _submit(
        client,
        token=None,
        version=5,
        answer="4118",
        key="claim-without-link-001",
    )
    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == "claim_link_required"

    missing_inspection = client.get(f"/api/v1/passports/{case_id}/claim-link")
    assert missing_inspection.status_code == 403
    assert missing_inspection.headers["cache-control"] == "no-store, private"
    assert missing_inspection.json()["error"]["code"] == "claim_link_required"

    issued = _issue_link(client)
    assert issued["case_id"] == case_id
    assert issued["issued_case_version"] == 5
    assert len(issued["token"]) >= 40
    assert issued["active"] is True

    inspected = client.get(
        f"/api/v1/passports/{case_id}/claim-link",
        headers={"X-Found-Roll-Claim-Link": issued["token"]},
    )
    assert inspected.status_code == 200
    assert inspected.headers["cache-control"] == "no-store, private"
    assert inspected.json()["active"] is True
    assert "token" not in inspected.json()
    _assert_no_restricted_claimant_fields(inspected.json())
    _assert_claimant_projection(inspected.json()["case"], link_active=True)

    accepted = _submit(
        client,
        token=issued["token"],
        version=5,
        answer="4118",
        key="claim-with-link-001",
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["accepted"] is True
    assert "replacement_claim_link" not in accepted.json()
    _assert_no_restricted_claimant_fields(accepted.json())
    _assert_claimant_projection(accepted.json()["case"], link_active=False)
    assert accepted.json()["case"]["attempt_count"] == 0
    assert accepted.json()["case"]["next_question"] is None

    replay = _submit(
        client,
        token=issued["token"],
        version=8,
        answer="4118",
        key="claim-link-replay-001",
    )
    assert replay.status_code == 409
    assert replay.json()["error"]["code"] == "claim_link_replayed"


def test_wrong_answer_rotates_the_one_time_link_without_leaking_secrets(client, case_id):
    begin_and_process_analysis(client, case_id)
    issued = _issue_link(client, key="claim-link-rotate-001")

    rejected = _submit(
        client,
        token=issued["token"],
        version=5,
        answer="0000",
        key="claim-link-wrong-001",
    )
    assert rejected.status_code == 200, rejected.text
    body = rejected.json()
    assert body["accepted"] is False
    _assert_no_restricted_claimant_fields(body)
    _assert_claimant_projection(body["case"], link_active=False)
    assert body["case"]["attempt_count"] == 1
    replacement = body["replacement_claim_link"]
    assert replacement["token"] != issued["token"]
    assert replacement["issued_case_version"] == body["case"]["version"] == 6

    old_replay = _submit(
        client,
        token=issued["token"],
        version=6,
        answer="4118",
        key="claim-link-old-replay-001",
    )
    assert old_replay.status_code == 409
    assert old_replay.json()["error"]["code"] == "claim_link_invalid"

    accepted = _submit(
        client,
        token=replacement["token"],
        version=6,
        answer="4118",
        key="claim-link-rotated-accept-001",
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["accepted"] is True

    published = "\n".join(
        [
            client.get(f"/api/v1/passports/{case_id}").text,
            client.get(f"/api/v1/passports/{case_id}/events").text,
        ]
    )
    assert issued["token"] not in published
    assert replacement["token"] not in published
    assert "claim_link_hash" not in published


def test_expired_and_wrong_case_claim_links_fail_closed():
    settings = Settings(claim_link_ttl_seconds=60)
    app = create_app(settings=settings)
    now = datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc)
    app.state.custody_service.clock = lambda: now

    with TestClient(app) as client:
        begin_and_process_analysis(client, DEMO_CASE_ID)
        issued = _issue_link(client, key="claim-link-expiry-001")

        wrong_case = client.get(
            "/api/v1/passports/FR-WRONG-CASE/claim-link",
            headers={"X-Found-Roll-Claim-Link": issued["token"]},
        )
        assert wrong_case.status_code == 409
        assert wrong_case.json()["error"]["code"] == "claim_link_invalid"

        app.state.custody_service.clock = lambda: now + timedelta(seconds=61)
        expired = _submit(
            client,
            token=issued["token"],
            version=5,
            answer="4118",
            key="claim-link-expired-submit-001",
        )

    assert expired.status_code == 409
    assert expired.json()["error"]["code"] == "claim_link_expired"


def test_claim_link_issue_retry_keeps_original_expiry_and_never_revives_old_link():
    settings = Settings(claim_link_ttl_seconds=60)
    app = create_app(settings=settings)
    now = datetime(2026, 8, 29, 11, 0, tzinfo=timezone.utc)
    app.state.custody_service.clock = lambda: now

    with TestClient(app) as client:
        begin_and_process_analysis(client, DEMO_CASE_ID)
        issued = _issue_link(client, key="claim-link-idempotent-001")

        app.state.custody_service.clock = lambda: now + timedelta(seconds=61)
        expired_retry = _issue_link(client, key="claim-link-idempotent-001")
        assert expired_retry["token"] == issued["token"]
        assert expired_retry["issued_at"] == issued["issued_at"]
        assert expired_retry["expires_at"] == issued["expires_at"]
        assert expired_retry["active"] is False

        fresh = _issue_link(client, key="claim-link-idempotent-002")
        assert fresh["token"] != issued["token"]
        assert fresh["issued_at"] != issued["issued_at"]
        assert fresh["active"] is True

        superseded_retry = _issue_link(client, key="claim-link-idempotent-001")
        assert superseded_retry == expired_retry

        persisted = "\n".join(
            repr(value)
            for value in (
                app.state.custody_service.repository._claim_links,
                app.state.custody_service.repository._claim_link_issuances,
            )
        )
        assert issued["token"] not in persisted
        assert fresh["token"] not in persisted


def test_claim_evidence_response_retry_replays_commit_and_conflicts_on_changed_input(client, case_id):
    begin_and_process_analysis(client, case_id)
    issued = _issue_link(client, key="claim-link-response-retry-001")

    first = _submit(
        client,
        token=issued["token"],
        version=5,
        answer="0000",
        key="claim-response-retry-001",
    )
    assert first.status_code == 200, first.text
    assert first.json()["accepted"] is False
    assert first.json()["replayed"] is False

    retry = _submit(
        client,
        token=issued["token"],
        version=5,
        answer="0000",
        key="claim-response-retry-001",
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["accepted"] is False
    assert retry.json()["replayed"] is True
    assert retry.json()["case"] == first.json()["case"]
    assert retry.json()["replacement_claim_link"] == first.json()["replacement_claim_link"]

    changed_answer = _submit(
        client,
        token=issued["token"],
        version=5,
        answer="4118",
        key="claim-response-retry-001",
    )
    assert changed_answer.status_code == 409
    assert changed_answer.json()["error"]["code"] == "idempotency_conflict"

    replacement = first.json()["replacement_claim_link"]
    changed_token = _submit(
        client,
        token=replacement["token"],
        version=5,
        answer="0000",
        key="claim-response-retry-001",
    )
    assert changed_token.status_code == 409
    assert changed_token.json()["error"]["code"] == "idempotency_conflict"
