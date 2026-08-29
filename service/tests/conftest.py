from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.fixtures import DEMO_CASE_ID
from app.main import create_app


STAFF_HEADERS = {"X-Found-Roll-Staff-Token": "found-roll-local-staff-token"}
SUPERVISOR_HEADERS = {"X-Found-Roll-Supervisor-Token": "found-roll-local-supervisor-token"}


@pytest.fixture
def settings() -> Settings:
    return Settings()


@pytest.fixture
def app(settings):
    return create_app(settings=settings)


@pytest.fixture
def client(app):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def case_id() -> str:
    return DEMO_CASE_ID


def begin_and_process_analysis(client: TestClient, case_id: str) -> dict:
    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "analysis-test-001"},
    )
    assert started.status_code == 200, started.text
    task = started.json()["task"]["payload"]
    completed = client.post("/tasks/outbox", json=task)
    assert completed.status_code == 200, completed.text
    return completed.json()


def issue_claim_link(
    client: TestClient,
    case_id: str,
    *,
    expected_version: int,
    idempotency_key: str,
) -> dict:
    issued = client.post(
        f"/api/v1/passports/{case_id}/claim-links",
        json={
            "expected_version": expected_version,
            "idempotency_key": idempotency_key,
        },
        headers=STAFF_HEADERS,
    )
    assert issued.status_code == 200, issued.text
    return issued.json()


def reach_approved(client: TestClient, case_id: str) -> dict:
    begin_and_process_analysis(client, case_id)
    claim_link = issue_claim_link(
        client,
        case_id,
        expected_version=5,
        idempotency_key="claim-link-test-001",
    )
    evidence = client.post(
        f"/api/v1/passports/{case_id}/claim-evidence",
        json={"expected_version": 5, "idempotency_key": "claim-test-001", "answer": "4118"},
        headers={"X-Found-Roll-Claim-Link": claim_link["token"]},
    )
    assert evidence.status_code == 200, evidence.text
    identity = client.post(
        f"/api/v1/passports/{case_id}/identity-attestations",
        json={
            "expected_version": 8,
            "idempotency_key": "identity-test-001",
            "staff_user_id": "staff.northport",
            "method": "government_id_visual_check",
        },
        headers=STAFF_HEADERS,
    )
    assert identity.status_code == 200, identity.text
    approval = client.post(
        f"/api/v1/passports/{case_id}/approvals",
        json={
            "expected_version": 10,
            "idempotency_key": "approval-test-001",
            "supervisor_user_id": "supervisor.northport",
            "approved": True,
            "reason": "Private evidence and staff attestation satisfy the valuable-item policy.",
        },
        headers=SUPERVISOR_HEADERS,
    )
    assert approval.status_code == 200, approval.text
    return approval.json()


def reserve_and_issue_tokens(client: TestClient, case_id: str) -> tuple[dict, dict]:
    reach_approved(client, case_id)
    reservation = client.post(
        f"/api/v1/passports/{case_id}/reservations",
        json={
            "expected_version": 11,
            "idempotency_key": "reserve-test-001",
            "expected_remote_etag": '"na-231-v5"',
        },
    )
    assert reservation.status_code == 200, reservation.text
    task = reservation.json()["task"]["payload"]
    reserved = client.post("/tasks/outbox", json=task)
    assert reserved.status_code == 200, reserved.text
    tokens = client.post(
        f"/api/v1/passports/{case_id}/tokens",
        json={"expected_version": 13, "idempotency_key": "tokens-test-001"},
    )
    assert tokens.status_code == 200, tokens.text
    return reserved.json(), tokens.json()
