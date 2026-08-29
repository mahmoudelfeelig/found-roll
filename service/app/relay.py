"""Authenticated boundary to the separately deployed SIMULATED relay."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import secrets
from typing import Any, Protocol

import httpx

from .config import Settings
from .correlation import CORRELATION_HEADER, get_or_create_correlation_id
from .domain import (
    CaseRecord,
    HandoffRecord,
    OutboxKind,
    OutboxRecord,
    RelayAttestation,
    SimulatorHandoffCallback,
    TokenPurpose,
    utc_now,
)
from .errors import Conflict, Unavailable
from .hashing import secure_equal, sha256_hex, signed_body


@dataclass(frozen=True, slots=True)
class IssuedCredentials:
    claimant_token: str
    custodian_token: str
    expires_at: datetime
    remote_etag: str
    remote_version: int


@dataclass(frozen=True, slots=True)
class TokenPresentation:
    attestation_id: str
    presented_at: datetime
    remote_etag: str
    remote_version: int


class RelayGateway(Protocol):
    mode: str

    def execute(
        self, outbox: OutboxRecord, case: CaseRecord, handoff: HandoffRecord | None
    ) -> RelayAttestation: ...

    def issue_credentials(
        self,
        case: CaseRecord,
        handoff: HandoffRecord,
        *,
        expires_at: datetime,
        idempotency_key: str,
    ) -> IssuedCredentials: ...

    def attest_token(
        self,
        case: CaseRecord,
        handoff: HandoffRecord,
        *,
        purpose: TokenPurpose,
        token: str,
        idempotency_key: str,
    ) -> TokenPresentation: ...


def _required(mapping: dict[str, Any], *names: str) -> Any:
    for name in names:
        value = mapping.get(name)
        if value is not None:
            return value
    raise ValueError(f"missing required simulator field: {' or '.join(names)}")


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def callback_canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def verify_callback_signature(
    *,
    body: bytes,
    timestamp: str,
    signature: str,
    secret: str,
    now: datetime,
    max_age_seconds: int,
) -> None:
    try:
        timestamp_seconds = int(timestamp)
    except ValueError:
        try:
            timestamp_seconds = int(_parse_datetime(timestamp).timestamp())
        except ValueError as exc:
            raise Conflict("relay_timestamp_invalid", "The simulator callback timestamp is invalid.") from exc
    if abs(int(now.timestamp()) - timestamp_seconds) > max_age_seconds:
        raise Conflict("relay_callback_expired", "The simulator callback timestamp is outside the allowed window.")
    expected = "v1=" + signed_body(timestamp.encode("utf-8") + b"." + body, secret)
    if not secure_equal(signature, expected):
        raise Conflict("relay_signature_invalid", "The simulator callback signature is invalid.")


class FixtureRelayGateway:
    mode = "fixture"

    def execute(
        self, outbox: OutboxRecord, case: CaseRecord, handoff: HandoffRecord | None
    ) -> RelayAttestation:
        if not case.selected_item_id:
            raise Unavailable("relay_item_missing", "The Item Passport has no selected item.")
        operation = "RESERVE" if outbox.kind == OutboxKind.RESERVE_RELAY else "RELEASE"
        reservation_id = (
            handoff.reservation_id
            if handoff and handoff.reservation_id
            else f"sim-rsv-{sha256_hex(outbox.id)[:12]}"
        )
        now = utc_now()
        return RelayAttestation(
            attestation_id=f"sim-att-{sha256_hex({'outbox': outbox.id, 'operation': operation})[:20]}",
            operation=operation,
            status="HELD" if operation == "RESERVE" else "RELEASED",
            case_id=case.id,
            item_id=case.selected_item_id,
            outbox_id=outbox.id,
            reservation_id=reservation_id,
            remote_etag=f'"relay-{sha256_hex(outbox.id)[:12]}"',
            remote_version=1,
            expected_case_version=case.version,
            occurred_at=now,
            expires_at=now + timedelta(minutes=20) if operation == "RESERVE" else None,
            simulated=True,
        )

    def issue_credentials(
        self,
        case: CaseRecord,
        handoff: HandoffRecord,
        *,
        expires_at: datetime,
        idempotency_key: str,
    ) -> IssuedCredentials:
        return IssuedCredentials(
            claimant_token=secrets.token_urlsafe(24),
            custodian_token=secrets.token_urlsafe(24),
            expires_at=expires_at,
            remote_etag=f'"fixture-credentials-{sha256_hex(idempotency_key)[:10]}"',
            remote_version=handoff.remote_version + 1,
        )

    def attest_token(
        self,
        case: CaseRecord,
        handoff: HandoffRecord,
        *,
        purpose: TokenPurpose,
        token: str,
        idempotency_key: str,
    ) -> TokenPresentation:
        digest = sha256_hex({"key": idempotency_key, "role": purpose.value})
        return TokenPresentation(
            attestation_id=f"fixture-scan-{digest[:16]}",
            presented_at=utc_now(),
            remote_etag=f'"fixture-scan-{digest[:10]}"',
            remote_version=handoff.remote_version + 1,
        )


class HttpRelayGateway:
    mode = "http"

    def __init__(self, settings: Settings) -> None:
        if not settings.relay_base_url:
            raise Unavailable("relay_url_missing", "FOUND_ROLL_RELAY_BASE_URL is required for HTTP relay mode.")
        if not settings.relay_api_key:
            raise Unavailable(
                "relay_api_key_missing",
                "FOUND_ROLL_RELAY_API_KEY is required for HTTP relay mode.",
            )
        self._base_url = settings.relay_base_url.rstrip("/")
        self._api_key = settings.relay_api_key
        self._custodian_id = settings.relay_custodian_id
        self._destination = settings.relay_destination
        self._callback_secret = settings.relay_shared_secret
        self._callback_max_age_seconds = settings.relay_callback_max_age_seconds

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.post(
                    f"{self._base_url}{path}",
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        CORRELATION_HEADER: get_or_create_correlation_id(),
                    },
                )
                response.raise_for_status()
                envelope = response.json()
        except httpx.HTTPStatusError as exc:
            try:
                error_code = exc.response.json().get("error", {}).get("code")
            except ValueError:
                error_code = None
            if exc.response.status_code == 409 and error_code == "TOKEN_REPLAY_REJECTED":
                raise Conflict(
                    "token_replayed",
                    "That one-time relay credential has already been consumed.",
                ) from exc
            raise Unavailable(
                "relay_unavailable",
                "The disclosed SIMULATED relay rejected or could not complete the service request.",
            ) from exc
        except (httpx.RequestError, ValueError) as exc:
            raise Unavailable(
                "relay_unavailable",
                "The disclosed SIMULATED relay did not return a valid service response.",
            ) from exc
        simulation = envelope.get("simulation", {})
        if simulation.get("mode") != "SIMULATED" or not simulation.get("notice"):
            raise Unavailable("relay_disclosure_missing", "The relay response omitted its SIMULATED disclosure.")
        data = envelope.get("data")
        if not isinstance(data, dict):
            raise Unavailable("relay_contract_invalid", "The relay response data contract is invalid.")
        return data

    def execute(
        self, outbox: OutboxRecord, case: CaseRecord, handoff: HandoffRecord | None
    ) -> RelayAttestation:
        if not case.selected_item_id:
            raise Unavailable("relay_item_missing", "The Item Passport has no selected item.")
        if outbox.kind == OutboxKind.RESERVE_RELAY:
            expires_at = utc_now() + timedelta(minutes=20)
            data = self._post(
                "/v1/relay/reservations",
                {
                    "case_id": case.id,
                    "case_version": handoff.reservation_case_version if handoff else case.version,
                    "custodian_id": self._custodian_id,
                    "item_id": case.selected_item_id,
                    "expected_item_etag": handoff.remote_etag if handoff else None,
                    "expected_item_version": handoff.remote_version if handoff else None,
                    "destination": self._destination,
                    "expires_at": expires_at.isoformat(),
                    "actor": "service:found-roll-custody",
                    "reason": "Create a disclosed simulated return reservation after deterministic approval gates.",
                    "evidence_refs": [case.id, case.selected_item_id],
                    "idempotency_key": outbox.id,
                },
            )
            reservation = _required(data, "reservation")
            return RelayAttestation(
                attestation_id=f"relay-reserve-{sha256_hex({'outbox': outbox.id, 'reservation': reservation})[:20]}",
                operation="RESERVE",
                status="HELD",
                case_id=case.id,
                item_id=case.selected_item_id,
                outbox_id=outbox.id,
                reservation_id=str(_required(reservation, "reservation_id", "id")),
                remote_etag=str(_required(reservation, "etag", "reservation_etag")),
                remote_version=int(_required(reservation, "version", "reservation_version")),
                expected_case_version=case.version,
                occurred_at=utc_now(),
                expires_at=_parse_datetime(_required(reservation, "expires_at")),
                simulated=True,
            )
        if not handoff or not handoff.reservation_id:
            raise Conflict("relay_reservation_missing", "The relay release has no reservation.")
        data = self._post(
            f"/v1/relay/reservations/{handoff.reservation_id}/handoff-attestation",
            {
                "case_id": case.id,
                "case_version": handoff.reservation_case_version,
                "item_id": case.selected_item_id,
                "custodian_id": self._custodian_id,
                "expected_reservation_etag": handoff.remote_etag,
                "expected_reservation_version": handoff.remote_version,
                "actor": "service:found-roll-custody",
                "reason": "Finalize the disclosed simulated handoff after both scoped token attestations.",
                "evidence_refs": [case.id, handoff.id],
                "idempotency_key": outbox.id,
            },
        )
        artifact = _required(data, "callback_artifact")
        body_value = _required(artifact, "body")
        body = (
            callback_canonical_json(body_value)
            if isinstance(body_value, dict)
            else str(body_value).encode("utf-8")
        )
        headers = _required(artifact, "headers")
        timestamp = str(
            _required(
                headers,
                "X-Found-Roll-Simulator-Timestamp",
                "x-found-roll-simulator-timestamp",
            )
        )
        signature = str(
            _required(
                headers,
                "X-Found-Roll-Simulator-Signature",
                "x-found-roll-simulator-signature",
            )
        )
        verify_callback_signature(
            body=body,
            timestamp=timestamp,
            signature=signature,
            secret=self._callback_secret,
            now=utc_now(),
            max_age_seconds=self._callback_max_age_seconds,
        )
        callback = SimulatorHandoffCallback.model_validate_json(body)
        if callback.case_version != handoff.reservation_case_version:
            raise Conflict(
                "relay_callback_version_mismatch",
                "The simulator callback does not match the reservation-bound case version.",
            )
        reservation = _required(data, "reservation")
        remote_etag = str(
            reservation.get("etag")
            or reservation.get("reservation_etag")
            or handoff.remote_etag
        )
        return RelayAttestation(
            attestation_id=callback.event_id,
            operation="RELEASE",
            status="RELEASED",
            case_id=callback.case_id,
            item_id=callback.item_id,
            outbox_id=outbox.id,
            reservation_id=callback.reservation_id,
            remote_etag=remote_etag,
            remote_version=callback.reservation_version,
            expected_case_version=outbox.expected_case_version,
            occurred_at=callback.occurred_at,
            simulated=True,
        )

    def issue_credentials(
        self,
        case: CaseRecord,
        handoff: HandoffRecord,
        *,
        expires_at: datetime,
        idempotency_key: str,
    ) -> IssuedCredentials:
        if not handoff.reservation_id:
            raise Conflict("relay_reservation_missing", "The relay credential request has no reservation.")
        data = self._post(
            f"/v1/relay/reservations/{handoff.reservation_id}/credentials",
            {
                "case_id": case.id,
                "case_version": handoff.reservation_case_version,
                "item_id": handoff.item_id,
                "custodian_id": self._custodian_id,
                "expected_reservation_etag": handoff.remote_etag,
                "expected_reservation_version": handoff.remote_version,
                "token_expires_at": expires_at.isoformat(),
                "actor": "service:found-roll-token-vault",
                "reason": "Issue two scoped credentials for the disclosed simulated reservation.",
                "evidence_refs": [case.id, handoff.id],
                "idempotency_key": idempotency_key,
            },
        )
        credentials = _required(data, "credentials")
        reservation = _required(data, "reservation")
        return IssuedCredentials(
            claimant_token=str(_required(credentials, "claimant_token")),
            custodian_token=str(_required(credentials, "custodian_token")),
            expires_at=_parse_datetime(_required(credentials, "expires_at")),
            remote_etag=str(_required(reservation, "etag", "reservation_etag")),
            remote_version=int(_required(reservation, "version", "reservation_version")),
        )

    def attest_token(
        self,
        case: CaseRecord,
        handoff: HandoffRecord,
        *,
        purpose: TokenPurpose,
        token: str,
        idempotency_key: str,
    ) -> TokenPresentation:
        if not handoff.reservation_id:
            raise Conflict("relay_reservation_missing", "The relay token attestation has no reservation.")
        data = self._post(
            f"/v1/relay/reservations/{handoff.reservation_id}/attestations",
            {
                "role": purpose.value,
                "token": token,
                "case_id": case.id,
                "case_version": handoff.reservation_case_version,
                "item_id": handoff.item_id,
                "custodian_id": self._custodian_id,
                "expected_reservation_etag": handoff.remote_etag,
                "expected_reservation_version": handoff.remote_version,
                "actor": f"simulator:{purpose.value.lower()}-scanner",
                "reason": "Record one scoped simulated token presentation; this does not prove possession.",
                "evidence_refs": [case.id, handoff.id],
                "idempotency_key": idempotency_key,
            },
        )
        reservation = _required(data, "reservation")
        attestation = _required(data, "attestation")
        return TokenPresentation(
            attestation_id=str(_required(attestation, "attestation_id", "id")),
            presented_at=_parse_datetime(_required(attestation, "presented_at")),
            remote_etag=str(_required(reservation, "etag", "reservation_etag")),
            remote_version=int(_required(reservation, "version", "reservation_version")),
        )
