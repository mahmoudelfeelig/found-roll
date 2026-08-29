from __future__ import annotations

from datetime import datetime, timedelta, timezone
import time

import pytest

from app.config import Settings
from app.correlation import CORRELATION_HEADER
from app.domain import (
    CustodyState,
    HandoffRecord,
    OutboxKind,
    OutboxRecord,
    SimulatorHandoffCallback,
    TokenPurpose,
)
from app.errors import Conflict
from app.fixtures import fixture_case
from app.hashing import signed_body
from app.relay import (
    HttpRelayGateway,
    callback_canonical_json,
    verify_callback_signature,
)


def _callback(now: datetime) -> SimulatorHandoffCallback:
    return SimulatorHandoffCallback(
        event_id="sim-event-001",
        event_type="SIMULATED_TOKEN_HANDOFF_ATTESTED",
        simulation={
            "mode": "SIMULATED",
            "notice": "This service attestation does not prove physical possession.",
        },
        reservation_id="sim-res-001",
        case_id="FR-20260829-0042",
        case_version=17,
        item_id="NA-PCH-231",
        custodian_id="northport-air",
        reservation_version=5,
        item_version=6,
        occurred_at=now,
        attestation_statement="Both scoped tokens were presented in a simulated relay workflow.",
    )


def test_timestamped_callback_signature_accepts_canonical_body_and_rejects_tampering():
    now = datetime.now(timezone.utc)
    timestamp = str(int(now.timestamp()))
    body = callback_canonical_json(_callback(now).model_dump(mode="json"))
    secret = "test-callback-secret"
    signature = "v1=" + signed_body(timestamp.encode() + b"." + body, secret)
    verify_callback_signature(
        body=body,
        timestamp=timestamp,
        signature=signature,
        secret=secret,
        now=now,
        max_age_seconds=300,
    )
    with pytest.raises(Conflict, match="signature"):
        verify_callback_signature(
            body=body + b" ",
            timestamp=timestamp,
            signature=signature,
            secret=secret,
            now=now,
            max_age_seconds=300,
        )
    with pytest.raises(Conflict, match="outside"):
        verify_callback_signature(
            body=body,
            timestamp=str(int((now - timedelta(minutes=10)).timestamp())),
            signature=signature,
            secret=secret,
            now=now,
            max_age_seconds=300,
        )


def test_http_gateway_uses_stable_routes_bearer_auth_versions_and_signed_artifact(monkeypatch):
    captured: list[tuple[str, dict, dict]] = []
    secret = "test-callback-secret"
    monkeypatch.setattr(
        "app.relay.get_or_create_correlation_id",
        lambda: "corr-relay-request-0001",
    )

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json, headers):
            captured.append((url, json, headers))
            simulation = {
                "mode": "SIMULATED",
                "notice": "This service response does not prove physical possession.",
            }
            if url.endswith("/v1/relay/reservations"):
                return FakeResponse(
                    {
                        "simulation": simulation,
                        "data": {
                            "reservation": {
                                "id": "sim-res-001",
                                "etag": '"sim-res-v1"',
                                "version": 1,
                                "expires_at": "2026-08-29T12:20:00Z",
                            },
                            "item": {"id": "NA-PCH-231", "etag": '"na-231-v6"', "version": 6},
                            "idempotent_replay": False,
                        },
                    }
                )
            if url.endswith("/credentials"):
                return FakeResponse(
                    {
                        "simulation": simulation,
                        "data": {
                            "reservation": {"id": "sim-res-001", "etag": '"sim-res-v2"', "version": 2},
                            "credentials": {
                                "claimant_token": "claimant-token-value-123456",
                                "custodian_token": "custodian-token-value-12345",
                                "expires_at": "2026-08-29T12:10:00Z",
                            },
                            "idempotent_replay": False,
                        },
                    }
                )
            if url.endswith("/attestations"):
                return FakeResponse(
                    {
                        "simulation": simulation,
                        "data": {
                            "reservation": {"id": "sim-res-001", "etag": '"sim-res-v3"', "version": 3},
                            "attestation": {
                                "attestation_id": "scan-001",
                                "presented_at": "2026-08-29T12:05:00Z",
                                "role": "CLAIMANT",
                                "statement": "Simulated token presentation only.",
                            },
                            "idempotent_replay": False,
                        },
                    }
                )
            callback = _callback(datetime.now(timezone.utc)).model_copy(update={"case_version": 12})
            body_dict = callback.model_dump(mode="json")
            body = callback_canonical_json(body_dict)
            timestamp = str(int(time.time()))
            signature = "v1=" + signed_body(timestamp.encode() + b"." + body, secret)
            return FakeResponse(
                {
                    "simulation": simulation,
                    "data": {
                        "reservation": {"id": "sim-res-001", "etag": '"sim-res-v5"', "version": 5},
                        "item": {"id": "NA-PCH-231", "etag": '"na-231-v7"', "version": 7},
                        "callback_artifact": {
                            "body": body_dict,
                            "headers": {
                                "X-Found-Roll-Simulator-Timestamp": timestamp,
                                "X-Found-Roll-Simulator-Signature": signature,
                            },
                        },
                        "idempotent_replay": False,
                    },
                }
            )

    monkeypatch.setattr("app.relay.httpx.Client", FakeClient)
    settings = Settings(
        relay_mode="http",
        relay_base_url="https://relay.example",
        relay_api_key="test-api-key",
        relay_shared_secret=secret,
    )
    gateway = HttpRelayGateway(settings)
    case = fixture_case().model_copy(
        update={"state": CustodyState.RESERVE_REQUESTED, "version": 12, "selected_item_id": "NA-PCH-231"}
    )
    handoff = HandoffRecord(
        id="handoff-test-001",
        case_id=case.id,
        item_id="NA-PCH-231",
        reservation_case_version=12,
        remote_etag='"na-231-v5"',
        remote_version=5,
    )
    reserve_outbox = OutboxRecord(
        id="outbox-reserve-001",
        task_name="task-reserve-001",
        kind=OutboxKind.RESERVE_RELAY,
        case_id=case.id,
        expected_case_version=12,
    )
    reserved = gateway.execute(reserve_outbox, case, handoff)
    assert reserved.reservation_id == "sim-res-001"
    assert captured[-1][0] == "https://relay.example/v1/relay/reservations"
    assert captured[-1][1]["expected_item_version"] == 5
    assert captured[-1][1]["case_version"] == 12
    assert captured[-1][1]["expected_item_etag"] == '"na-231-v5"'
    assert captured[-1][1]["evidence_refs"] == [case.id, "NA-PCH-231"]
    assert captured[-1][2]["Authorization"] == "Bearer test-api-key"
    correlation_id = captured[-1][2][CORRELATION_HEADER]
    assert correlation_id == "corr-relay-request-0001"

    held = handoff.model_copy(
        update={"reservation_id": "sim-res-001", "remote_etag": '"sim-res-v1"', "remote_version": 1}
    )
    later_case = case.model_copy(update={"version": 14})
    issued = gateway.issue_credentials(
        later_case,
        held,
        expires_at=datetime(2026, 8, 29, 12, 10, tzinfo=timezone.utc),
        idempotency_key="credentials-001",
    )
    assert issued.remote_version == 2
    assert captured[-1][0].endswith("/v1/relay/reservations/sim-res-001/credentials")
    assert captured[-1][1]["expected_reservation_version"] == 1
    assert captured[-1][1]["case_version"] == 12
    assert captured[-1][1]["expected_reservation_etag"] == '"sim-res-v1"'
    assert captured[-1][1]["evidence_refs"] == [case.id, handoff.id]

    scanned = gateway.attest_token(
        later_case.model_copy(update={"version": 15}),
        held.model_copy(update={"remote_etag": issued.remote_etag, "remote_version": 2}),
        purpose=TokenPurpose.CLAIMANT,
        token=issued.claimant_token,
        idempotency_key="scan-001",
    )
    assert scanned.remote_version == 3
    assert captured[-1][0].endswith("/attestations")
    assert captured[-1][1]["role"] == "CLAIMANT"
    assert captured[-1][1]["case_version"] == 12
    assert captured[-1][1]["evidence_refs"] == [case.id, handoff.id]

    release_case = case.model_copy(update={"state": CustodyState.RELEASE_REQUESTED, "version": 17})
    release_handoff = held.model_copy(update={"remote_etag": '"sim-res-v4"', "remote_version": 4})
    release_outbox = OutboxRecord(
        id="outbox-release-001",
        task_name="task-release-001",
        kind=OutboxKind.RELEASE_RELAY,
        case_id=case.id,
        expected_case_version=17,
    )
    released = gateway.execute(release_outbox, release_case, release_handoff)
    assert released.operation == "RELEASE"
    assert released.attestation_id == "sim-event-001"
    assert captured[-1][0].endswith("/handoff-attestation")
    assert captured[-1][1]["expected_reservation_version"] == 4
    assert captured[-1][1]["evidence_refs"] == [case.id, handoff.id]
    assert {headers[CORRELATION_HEADER] for _, _, headers in captured} == {
        correlation_id
    }
