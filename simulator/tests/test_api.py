from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import logging
from pathlib import Path
import re
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.correlation import CORRELATION_HEADER
from app.main import create_app
from app.store import FixtureStore


API_KEY = "test-simulator-api-key-with-adequate-length"
TOKEN_SECRET = "test-token-secret-independent-from-callback-secret"
CALLBACK_SECRET = "test-callback-secret-independent-from-token-secret"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
CASE_ID = "FR-20260829-0042"
CASE_VERSION = 12
ITEM_ID = "NA-PCH-231"
CUSTODIAN_ID = "northport-air"
SAFE_CORRELATION_ID = re.compile(r"^(?:fr-[a-f0-9]{32}|[A-Za-z0-9][A-Za-z0-9._:-]{7,63})$")


@dataclass
class MutableClock:
    current: datetime

    def __call__(self) -> datetime:
        return self.current

    def advance(self, **kwargs: int) -> None:
        self.current += timedelta(**kwargs)


@pytest.fixture
def clock() -> MutableClock:
    return MutableClock(datetime(2026, 8, 29, 21, 0, tzinfo=timezone.utc))


@pytest.fixture
def harness(clock: MutableClock) -> tuple[TestClient, FixtureStore]:
    store = FixtureStore(now_provider=clock)
    app = create_app(
        store=store,
        api_key=API_KEY,
        token_secret=TOKEN_SECRET,
        callback_secret=CALLBACK_SECRET,
    )
    return TestClient(app), store


def iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def assert_simulated(response: Any, expected_status: int) -> dict[str, Any]:
    assert response.status_code == expected_status, response.text
    assert response.headers["X-Found-Roll-Mode"] == "SIMULATED"
    assert SAFE_CORRELATION_ID.fullmatch(response.headers[CORRELATION_HEADER])
    payload = response.json()
    assert payload["simulation"]["mode"] == "SIMULATED"
    notice = payload["simulation"]["notice"]
    assert "do not prove physical possession" in notice
    assert "delivery" in notice
    assert "transfer" in notice
    return payload


def reservation_body(clock: MutableClock, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "case_id": CASE_ID,
        "case_version": CASE_VERSION,
        "custodian_id": CUSTODIAN_ID,
        "item_id": ITEM_ID,
        "expected_item_version": 5,
        "expected_item_etag": '"na-231-v5"',
        "destination": "Relay Post secure counter",
        "expires_at": iso(clock.current + timedelta(minutes=30)),
        "actor": "found-roll:outbox",
        "reason": "Policy-authorized synthetic relay reservation.",
        "evidence_refs": ["evt-approval-001"],
        "idempotency_key": "reserve-camera-pouch-001",
    }
    body.update(overrides)
    return body


def create_reservation(client: TestClient, clock: MutableClock, **overrides: Any) -> dict[str, Any]:
    response = client.post(
        "/v1/relay/reservations",
        headers=AUTH,
        json=reservation_body(clock, **overrides),
    )
    return assert_simulated(response, 201)["data"]


def bound_body(reservation: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "case_id": CASE_ID,
        "case_version": CASE_VERSION,
        "item_id": ITEM_ID,
        "custodian_id": CUSTODIAN_ID,
        "expected_reservation_version": reservation["version"],
        "expected_reservation_etag": reservation["etag"],
        "actor": "found-roll:test",
        "reason": "Exercise the synthetic relay contract.",
        "evidence_refs": ["evt-test-001"],
        "idempotency_key": "bound-operation-001",
    }
    body.update(overrides)
    return body


def issue_credentials(
    client: TestClient,
    clock: MutableClock,
    reservation: dict[str, Any],
    **overrides: Any,
) -> dict[str, Any]:
    values: dict[str, Any] = {
        "token_expires_at": iso(clock.current + timedelta(minutes=15)),
        "idempotency_key": "credentials-camera-pouch-001",
        "actor": "found-roll:credential-issuer",
        "reason": "Issue short-lived fixture-only presentation credentials.",
    }
    values.update(overrides)
    body = bound_body(reservation, **values)
    response = client.post(
        f"/v1/relay/reservations/{reservation['reservation_id']}/credentials",
        headers=AUTH,
        json=body,
    )
    return assert_simulated(response, 201)["data"]


def attest(
    client: TestClient,
    reservation: dict[str, Any],
    *,
    role: str,
    token: str,
    idempotency_key: str,
    expected_status: int = 201,
    **overrides: Any,
) -> dict[str, Any]:
    body = bound_body(
        reservation,
        role=role,
        token=token,
        idempotency_key=idempotency_key,
        actor=f"relay-terminal:{role.lower()}",
        reason=f"Record synthetic {role.lower()} token presentation.",
        evidence_refs=[f"evt-token-{role.lower()}-001"],
        **overrides,
    )
    response = client.post(
        f"/v1/relay/reservations/{reservation['reservation_id']}/attestations",
        headers=AUTH,
        json=body,
    )
    return assert_simulated(response, expected_status)


def ready_reservation(
    client: TestClient,
    clock: MutableClock,
) -> tuple[dict[str, Any], dict[str, str]]:
    created = create_reservation(client, clock)
    issued = issue_credentials(client, clock, created["reservation"])
    credentials = issued["credentials"]
    custodian = attest(
        client,
        issued["reservation"],
        role="CUSTODIAN",
        token=credentials["custodian_token"],
        idempotency_key="attest-custodian-001",
    )["data"]
    claimant = attest(
        client,
        custodian["reservation"],
        role="CLAIMANT",
        token=credentials["claimant_token"],
        idempotency_key="attest-claimant-001",
    )["data"]
    return claimant["reservation"], credentials


def test_success_errors_and_validation_always_disclose_simulation(harness: tuple[TestClient, FixtureStore]) -> None:
    client, _ = harness

    health = assert_simulated(client.get("/api/v1/healthz"), 200)
    assert health["data"]["status"] == "ok"

    missing = assert_simulated(client.get("/not-a-route"), 404)
    assert missing["error"]["code"] == "ROUTE_NOT_FOUND"

    validation = assert_simulated(
        client.post("/v1/relay/reservations", headers=AUTH, json={"token": "must-not-echo"}),
        422,
    )
    assert validation["error"]["code"] == "REQUEST_VALIDATION_FAILED"
    assert "must-not-echo" not in str(validation)


def test_inventory_testclient_propagates_and_safely_logs_correlation(
    harness: tuple[TestClient, FixtureStore],
    caplog,
) -> None:
    client, _ = harness
    correlation_id = "corr-simulator-inventory-0001"
    query_marker = "private-query-marker-6621"
    auth_marker = "Bearer private-auth-marker-7712"

    request_logger = logging.getLogger("found_roll_simulator.http")
    request_logger.propagate = True
    try:
        with caplog.at_level(logging.INFO, logger="found_roll_simulator.http"):
            response = client.get(
                f"/v1/custodians/{CUSTODIAN_ID}/inventory?q=camera&debug={query_marker}",
                headers={
                    CORRELATION_HEADER: correlation_id,
                    "Authorization": auth_marker,
                },
            )
    finally:
        request_logger.propagate = False

    payload = assert_simulated(response, 200)
    assert response.headers[CORRELATION_HEADER] == correlation_id
    assert payload["data"]["custodian_id"] == CUSTODIAN_ID
    assert payload["data"]["count"] >= 1
    records = [
        record
        for record in caplog.records
        if record.name == "found_roll_simulator.http"
    ]
    assert len(records) == 1
    record = records[0]
    assert record.getMessage() == "request_complete"
    assert record.service == "found-roll-simulator"
    assert record.correlation_id == correlation_id
    assert record.http_method == "GET"
    assert record.route_template == "/v1/custodians/{custodian_id}/inventory"
    assert record.status_code == 200
    assert isinstance(record.latency_ms, float)
    rendered = " ".join(str(value) for value in record.__dict__.values())
    assert query_marker not in rendered
    assert auth_marker not in rendered
    assert CUSTODIAN_ID not in record.route_template
    safe_handler = next(
        handler
        for handler in request_logger.handlers
        if getattr(handler, "_found_roll_safe_request_handler", False)
    )
    structured = json.loads(safe_handler.format(record))
    assert set(structured) == {
        "service",
        "correlation_id",
        "http_method",
        "route_template",
        "status_code",
        "latency_ms",
    }
    assert query_marker not in safe_handler.format(record)
    assert logging.getLogger("uvicorn.access").disabled is True
    assert "--no-access-log" in (
        Path(__file__).resolve().parents[1] / "Dockerfile"
    ).read_text(encoding="utf-8")


def test_simulator_replaces_invalid_correlation_without_logging_it(harness, caplog) -> None:
    client, _ = harness
    rejected = "private-invalid-correlation-" + ("x" * 80)
    request_logger = logging.getLogger("found_roll_simulator.http")
    request_logger.propagate = True
    try:
        with caplog.at_level(logging.INFO, logger="found_roll_simulator.http"):
            response = client.get(
                "/v1/custodians/northport-air/inventory/NA-PCH-231",
                headers={CORRELATION_HEADER: rejected},
            )
    finally:
        request_logger.propagate = False

    assert_simulated(response, 200)
    assert re.fullmatch(r"fr-[a-f0-9]{32}", response.headers[CORRELATION_HEADER])
    rendered = " ".join(
        str(value)
        for record in caplog.records
        if record.name == "found_roll_simulator.http"
        for value in record.__dict__.values()
    )
    assert rejected not in rendered


def test_unexpected_failure_is_disclosed_and_does_not_echo_exception_text(clock: MutableClock) -> None:
    store = FixtureStore(now_provider=clock)

    def fail_safely() -> list[dict[str, Any]]:
        raise RuntimeError("private-fixture-answer-4827")

    store.list_custodians = fail_safely  # type: ignore[method-assign]
    client = TestClient(
        create_app(
            store=store,
            api_key=API_KEY,
            token_secret=TOKEN_SECRET,
            callback_secret=CALLBACK_SECRET,
        ),
        raise_server_exceptions=False,
    )
    payload = assert_simulated(client.get("/v1/custodians"), 500)
    assert payload["error"]["code"] == "SIMULATOR_INTERNAL_ERROR"
    assert "4827" not in str(payload)


def test_mutations_fail_closed_without_configured_or_valid_auth(clock: MutableClock) -> None:
    disabled = TestClient(
        create_app(
            store=FixtureStore(now_provider=clock),
            api_key="",
            token_secret=TOKEN_SECRET,
            callback_secret=CALLBACK_SECRET,
        )
    )
    response = disabled.post("/v1/relay/reservations", json=reservation_body(clock))
    assert assert_simulated(response, 503)["error"]["code"] == "SIMULATOR_AUTH_NOT_CONFIGURED"

    configured = TestClient(
        create_app(
            store=FixtureStore(now_provider=clock),
            api_key=API_KEY,
            token_secret=TOKEN_SECRET,
            callback_secret=CALLBACK_SECRET,
        )
    )
    no_auth = configured.post("/v1/relay/reservations", json=reservation_body(clock))
    assert assert_simulated(no_auth, 401)["error"]["code"] == "SIMULATOR_AUTH_REQUIRED"
    bad_auth = configured.post(
        "/v1/relay/reservations",
        headers={"Authorization": "Bearer wrong-key"},
        json=reservation_body(clock),
    )
    assert assert_simulated(bad_auth, 403)["error"]["code"] == "SIMULATOR_AUTH_REJECTED"


def test_three_namespaces_are_isolated_filterable_and_leak_no_restricted_answer(
    harness: tuple[TestClient, FixtureStore],
) -> None:
    client, _ = harness
    custodians = assert_simulated(client.get("/v1/custodians"), 200)["data"]
    assert {row["custodian_id"] for row in custodians["custodians"]} == {
        "northport-air",
        "metro-loop",
        "grand-hall",
    }

    expected = {
        "northport-air": "NA-PCH-231",
        "metro-loop": "ML-PCH-219",
        "grand-hall": "GH-PCH-104",
    }
    for custodian_id, item_id in expected.items():
        result = assert_simulated(
            client.get(
                f"/v1/custodians/{custodian_id}/inventory",
                params={"category": "camera_pouch", "route": "conference-airport"},
            ),
            200,
        )["data"]
        assert result["count"] == 1
        assert result["items"][0]["item_id"] == item_id
        assert "4827" not in str(result)

    query = assert_simulated(
        client.get("/v1/custodians/northport-air/inventory", params={"q": "repaired corner"}),
        200,
    )["data"]
    assert [row["item_id"] for row in query["items"]] == [ITEM_ID]

    isolated = client.get(f"/v1/custodians/metro-loop/inventory/{ITEM_ID}")
    assert assert_simulated(isolated, 404)["error"]["code"] == "ITEM_NOT_FOUND"


def test_conditional_reserve_version_etag_and_idempotency(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness

    stale_version = client.post(
        "/v1/relay/reservations",
        headers=AUTH,
        json=reservation_body(clock, expected_item_version=4, idempotency_key="reserve-stale-version"),
    )
    assert assert_simulated(stale_version, 409)["error"]["code"] == "STALE_VERSION"

    stale_etag = client.post(
        "/v1/relay/reservations",
        headers=AUTH,
        json=reservation_body(clock, expected_item_etag='"wrong-etag"', idempotency_key="reserve-stale-etag"),
    )
    assert assert_simulated(stale_etag, 412)["error"]["code"] == "STALE_ETAG"

    body = reservation_body(clock)
    first_response = client.post("/v1/relay/reservations", headers=AUTH, json=body)
    first = assert_simulated(first_response, 201)["data"]
    assert first["reservation"]["status"] == "HELD"
    assert first["item"]["status"] == "HELD"
    assert first["item"]["version"] == 6
    assert first["idempotent_replay"] is False

    replay = assert_simulated(
        client.post("/v1/relay/reservations", headers=AUTH, json=body),
        201,
    )["data"]
    assert replay["idempotent_replay"] is True
    assert replay["reservation"]["reservation_id"] == first["reservation"]["reservation_id"]

    changed = {**body, "destination": "Different simulated counter"}
    conflict = client.post("/v1/relay/reservations", headers=AUTH, json=changed)
    assert assert_simulated(conflict, 409)["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"

    item = first["item"]
    competing = client.post(
        "/v1/relay/reservations",
        headers=AUTH,
        json=reservation_body(
            clock,
            case_id="case-competing-001",
            idempotency_key="reserve-competing-001",
            expected_item_version=item["version"],
            expected_item_etag=item["etag"],
        ),
    )
    assert assert_simulated(competing, 409)["error"]["code"] == "ITEM_NOT_AVAILABLE"


def test_credential_issue_is_idempotent_and_raw_tokens_are_not_stored(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, store = harness
    created = create_reservation(client, clock)
    reservation = created["reservation"]
    request = bound_body(
        reservation,
        token_expires_at=iso(clock.current + timedelta(minutes=15)),
        idempotency_key="credentials-camera-pouch-001",
        actor="found-roll:credential-issuer",
        reason="Issue short-lived fixture-only presentation credentials.",
    )
    path = f"/v1/relay/reservations/{reservation['reservation_id']}/credentials"

    first = assert_simulated(client.post(path, headers=AUTH, json=request), 201)["data"]
    replay = assert_simulated(client.post(path, headers=AUTH, json=request), 201)["data"]
    assert first["credentials"] == replay["credentials"]
    assert replay["idempotent_replay"] is True
    assert first["reservation"]["status"] == "TOKENS_ISSUED"

    for token in (first["credentials"]["claimant_token"], first["credentials"]["custodian_token"]):
        assert token not in str(store.reservations)
        assert token not in str(store.idempotency_records)

    changed = {**request, "reason": "Different request under the same key."}
    assert assert_simulated(client.post(path, headers=AUTH, json=changed), 409)["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_service_prefixed_idempotency_keys_are_accepted_and_remain_bounded(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness
    created = create_reservation(client, clock)
    reservation = created["reservation"]
    path = f"/v1/relay/reservations/{reservation['reservation_id']}/credentials"

    # Found Roll accepts a 160-character action key, then scopes it before
    # forwarding it to this boundary. The resulting canonical key is longer
    # than the simulator's former 128-character ceiling.
    service_key = f"case:{CASE_ID}:tokens:{'a' * 160}:relay"
    assert 128 < len(service_key) <= 256
    accepted = client.post(
        path,
        headers=AUTH,
        json=bound_body(
            reservation,
            token_expires_at=iso(clock.current + timedelta(minutes=15)),
            idempotency_key=service_key,
        ),
    )
    assert assert_simulated(accepted, 201)["data"]["reservation"]["status"] == "TOKENS_ISSUED"

    too_long = client.post(
        path,
        headers=AUTH,
        json=bound_body(
            reservation,
            token_expires_at=iso(clock.current + timedelta(minutes=15)),
            idempotency_key="a" * 257,
        ),
    )
    assert assert_simulated(too_long, 422)["error"]["code"] == "REQUEST_VALIDATION_FAILED"


def test_binding_version_role_and_token_replay_are_rejected(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness
    created = create_reservation(client, clock)
    issued = issue_credentials(client, clock, created["reservation"])
    reservation = issued["reservation"]
    credentials = issued["credentials"]

    mismatch = attest(
        client,
        reservation,
        role="CUSTODIAN",
        token=credentials["custodian_token"],
        idempotency_key="attest-binding-mismatch",
        case_version=CASE_VERSION + 1,
        expected_status=409,
    )
    assert mismatch["error"]["code"] == "RESERVATION_BINDING_MISMATCH"

    wrong_role = attest(
        client,
        reservation,
        role="CUSTODIAN",
        token=credentials["claimant_token"],
        idempotency_key="attest-role-mismatch",
        expected_status=403,
    )
    assert wrong_role["error"]["code"] == "TOKEN_MISMATCH"

    accepted = attest(
        client,
        reservation,
        role="CUSTODIAN",
        token=credentials["custodian_token"],
        idempotency_key="attest-custodian-accepted",
    )["data"]
    assert accepted["reservation"]["status"] == "PARTIALLY_ATTESTED"

    replay = attest(
        client,
        accepted["reservation"],
        role="CUSTODIAN",
        token=credentials["custodian_token"],
        idempotency_key="attest-custodian-replay",
        expected_status=409,
    )
    assert replay["error"]["code"] == "TOKEN_REPLAY_REJECTED"

    stale = attest(
        client,
        accepted["reservation"],
        role="CLAIMANT",
        token=credentials["claimant_token"],
        idempotency_key="attest-claimant-stale",
        expected_reservation_version=reservation["version"],
        expected_reservation_etag=reservation["etag"],
        expected_status=409,
    )
    assert stale["error"]["code"] == "STALE_VERSION"


def test_handoff_requires_both_roles_signs_callback_and_rejects_replay(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness
    created = create_reservation(client, clock)
    issued = issue_credentials(client, clock, created["reservation"])
    credentials = issued["credentials"]
    custodian = attest(
        client,
        issued["reservation"],
        role="CUSTODIAN",
        token=credentials["custodian_token"],
        idempotency_key="handoff-custodian-001",
    )["data"]

    premature_body = bound_body(
        custodian["reservation"],
        idempotency_key="handoff-premature-001",
        actor="found-roll:release-dispatcher",
        reason="Attempt finalization before both presentations.",
    )
    path = f"/v1/relay/reservations/{custodian['reservation']['reservation_id']}/handoff-attestation"
    premature = client.post(path, headers=AUTH, json=premature_body)
    assert assert_simulated(premature, 409)["error"]["code"] == "HANDOFF_NOT_READY"

    claimant = attest(
        client,
        custodian["reservation"],
        role="CLAIMANT",
        token=credentials["claimant_token"],
        idempotency_key="handoff-claimant-001",
    )["data"]
    assert claimant["reservation"]["status"] == "CALLBACK_READY"

    final_body = bound_body(
        claimant["reservation"],
        idempotency_key="handoff-final-001",
        actor="found-roll:release-dispatcher",
        reason="Finalize signed simulator callback after both presentations.",
        evidence_refs=["evt-staff-confirmed-001"],
    )
    finalized = assert_simulated(client.post(path, headers=AUTH, json=final_body), 201)["data"]
    assert finalized["reservation"]["status"] == "HANDOFF_ATTESTED"
    assert finalized["item"]["status"] == "RELEASED"
    artifact = finalized["callback_artifact"]
    assert artifact["body"]["schema_version"] == "1"
    assert set(artifact["body"]["simulation"]) == {"mode", "notice"}
    assert artifact["body"]["simulation"]["mode"] == "SIMULATED"
    assert "does not prove physical possession" in artifact["body"]["attestation_statement"]
    assert FixtureStore.verify_callback_artifact(
        artifact["body"],
        timestamp=artifact["headers"]["X-Found-Roll-Simulator-Timestamp"],
        signature=artifact["headers"]["X-Found-Roll-Simulator-Signature"],
        callback_secret=CALLBACK_SECRET,
    )
    tampered = {**artifact["body"], "item_id": "OTHER-ITEM"}
    assert not FixtureStore.verify_callback_artifact(
        tampered,
        timestamp=artifact["headers"]["X-Found-Roll-Simulator-Timestamp"],
        signature=artifact["headers"]["X-Found-Roll-Simulator-Signature"],
        callback_secret=CALLBACK_SECRET,
    )

    idempotent = assert_simulated(client.post(path, headers=AUTH, json=final_body), 201)["data"]
    assert idempotent["idempotent_replay"] is True
    assert idempotent["callback_artifact"] == artifact

    post_final = finalized["reservation"]
    replay_body = bound_body(
        post_final,
        idempotency_key="handoff-final-replay-new-key",
        actor="found-roll:release-dispatcher",
        reason="Attempt to finalize the same simulator handoff twice.",
    )
    rejected = client.post(path, headers=AUTH, json=replay_body)
    assert assert_simulated(rejected, 409)["error"]["code"] == "HANDOFF_REPLAY_REJECTED"


def test_reservation_expiry_rolls_item_back_and_blocks_mutation(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness
    created = create_reservation(client, clock, expires_at=iso(clock.current + timedelta(minutes=5)))
    reservation = created["reservation"]
    clock.advance(minutes=6)

    status = assert_simulated(
        client.get(f"/v1/relay/reservations/{reservation['reservation_id']}"),
        200,
    )["data"]
    assert status["reservation"]["status"] == "EXPIRED"
    assert status["item"]["status"] == "AVAILABLE"
    assert status["item"]["reservation_id"] is None

    request = bound_body(
        reservation,
        token_expires_at=iso(clock.current + timedelta(minutes=1)),
        idempotency_key="credentials-after-expiry",
    )
    response = client.post(
        f"/v1/relay/reservations/{reservation['reservation_id']}/credentials",
        headers=AUTH,
        json=request,
    )
    assert assert_simulated(response, 410)["error"]["code"] == "RESERVATION_EXPIRED"


def test_expired_credentials_reject_token_presentation(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness
    created = create_reservation(client, clock)
    issued = issue_credentials(
        client,
        clock,
        created["reservation"],
        token_expires_at=iso(clock.current + timedelta(minutes=5)),
    )
    clock.advance(minutes=6)
    response = attest(
        client,
        issued["reservation"],
        role="CUSTODIAN",
        token=issued["credentials"]["custodian_token"],
        idempotency_key="attest-expired-token",
        expected_status=410,
    )
    assert response["error"]["code"] == "CREDENTIAL_EXPIRED"


def test_reset_restores_stable_fixture_and_clears_reservations(
    harness: tuple[TestClient, FixtureStore], clock: MutableClock
) -> None:
    client, _ = harness
    created = create_reservation(client, clock)
    reservation_id = created["reservation"]["reservation_id"]

    reset = assert_simulated(
        client.post(
            "/v1/admin/reset",
            headers=AUTH,
            json={
                "confirmation": "RESET_SIMULATED_FIXTURE",
                "actor": "demo-reset",
                "reason": "Restore the synthetic camera-pouch scenario.",
            },
        ),
        200,
    )["data"]
    assert reset["fixture_version"] == "camera-pouch-v1"
    assert reset["reservation_count"] == 0
    assert reset["inventory_item_count"] == 9

    item = assert_simulated(
        client.get(f"/v1/custodians/{CUSTODIAN_ID}/inventory/{ITEM_ID}"),
        200,
    )["data"]["item"]
    assert item["status"] == "AVAILABLE"
    assert item["version"] == 5
    assert item["etag"] == '"na-231-v5"'

    missing = client.get(f"/v1/relay/reservations/{reservation_id}")
    assert assert_simulated(missing, 404)["error"]["code"] == "RESERVATION_NOT_FOUND"


def test_missing_token_or_callback_secret_fails_closed(clock: MutableClock) -> None:
    token_disabled = TestClient(
        create_app(
            store=FixtureStore(now_provider=clock),
            api_key=API_KEY,
            token_secret="",
            callback_secret=CALLBACK_SECRET,
        )
    )
    created = create_reservation(token_disabled, clock)
    request = bound_body(
        created["reservation"],
        token_expires_at=iso(clock.current + timedelta(minutes=10)),
        idempotency_key="credentials-secret-disabled",
    )
    response = token_disabled.post(
        f"/v1/relay/reservations/{created['reservation']['reservation_id']}/credentials",
        headers=AUTH,
        json=request,
    )
    assert assert_simulated(response, 503)["error"]["code"] == "TOKEN_SECRET_NOT_CONFIGURED"

    callback_disabled = TestClient(
        create_app(
            store=FixtureStore(now_provider=clock),
            api_key=API_KEY,
            token_secret=TOKEN_SECRET,
            callback_secret="",
        )
    )
    ready, _ = ready_reservation(callback_disabled, clock)
    body = bound_body(
        ready,
        idempotency_key="handoff-callback-secret-disabled",
        actor="found-roll:release-dispatcher",
        reason="Attempt callback signing without configured secret.",
    )
    response = callback_disabled.post(
        f"/v1/relay/reservations/{ready['reservation_id']}/handoff-attestation",
        headers=AUTH,
        json=body,
    )
    assert assert_simulated(response, 503)["error"]["code"] == "CALLBACK_SECRET_NOT_CONFIGURED"


@pytest.mark.parametrize(
    ("api_key", "token_secret", "callback_secret", "match"),
    [
        (
            "replace-with-the-simulator-api-key",
            TOKEN_SECRET,
            CALLBACK_SECRET,
            "placeholder",
        ),
        (API_KEY, "short", CALLBACK_SECRET, "at least 24"),
        (API_KEY, TOKEN_SECRET, TOKEN_SECRET, "must be distinct"),
    ],
)
def test_production_configuration_rejects_placeholder_weak_or_reused_secrets(
    api_key: str,
    token_secret: str,
    callback_secret: str,
    match: str,
) -> None:
    with pytest.raises(ValueError, match=match):
        create_app(
            environment="production",
            api_key=api_key,
            token_secret=token_secret,
            callback_secret=callback_secret,
        )


def test_valid_distinct_production_configuration_starts() -> None:
    app = create_app(
        environment="production",
        api_key=API_KEY,
        token_secret=TOKEN_SECRET,
        callback_secret=CALLBACK_SECRET,
    )
    with TestClient(app) as client:
        health = assert_simulated(client.get("/healthz"), 200)
    assert health["data"]["environment"] == "production"
