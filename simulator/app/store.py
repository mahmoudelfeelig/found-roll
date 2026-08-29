"""Atomic in-memory fixture store for the separately deployed simulator.

The store intentionally models a fictional system. It records API state only and
never represents or proves real-world possession, delivery, or transfer.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import threading
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Callable

from .disclosure import callback_disclosure
from .models import (
    CredentialIssueRequest,
    HandoffAttestationRequest,
    ReservationCreateRequest,
    TokenAttestationRequest,
)


NowProvider = Callable[[], datetime]


class DomainError(Exception):
    """A safe, typed failure at the simulator contract."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime) -> str:
    normalized = value.astimezone(timezone.utc)
    return normalized.isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(timezone.utc)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _etag(kind: str, identifier: str, version: int) -> str:
    return f'W/"sim-{kind}-{_safe_id(identifier)}-v{version}"'


class FixtureStore:
    """Thread-safe deterministic fixture with idempotent mutation semantics."""

    fixture_version = "camera-pouch-v1"

    def __init__(self, now_provider: NowProvider | None = None) -> None:
        self._now_provider = now_provider or utc_now
        self._lock = threading.RLock()
        self.custodians: dict[str, dict[str, Any]] = {}
        self.items: dict[str, dict[str, Any]] = {}
        self.reservations: dict[str, dict[str, Any]] = {}
        self.idempotency_records: dict[str, dict[str, Any]] = {}
        self.reset()

    def now(self) -> datetime:
        value = self._now_provider()
        if value.tzinfo is None:
            raise RuntimeError("The simulator clock must return a timezone-aware datetime")
        return value.astimezone(timezone.utc)

    def reset(self) -> dict[str, Any]:
        """Restore the exact synthetic fixture and clear all mutation history."""

        with self._lock:
            self.custodians = {
                "northport-air": {
                    "custodian_id": "northport-air",
                    "name": "Northport Air",
                    "operator_type": "fictional airport",
                    "namespace": "NPA",
                },
                "metro-loop": {
                    "custodian_id": "metro-loop",
                    "name": "Metro Loop",
                    "operator_type": "fictional transit operator",
                    "namespace": "MTL",
                },
                "grand-hall": {
                    "custodian_id": "grand-hall",
                    "name": "Grand Hall",
                    "operator_type": "fictional conference venue",
                    "namespace": "GHH",
                },
            }

            seed_items = [
                {
                    "item_id": "NA-PCH-231",
                    "custodian_id": "northport-air",
                    "remote_key": "na-terminal-c-20260828-231",
                    "category": "camera_pouch",
                    "coarse_description": "Compact black padded camera pouch with a grey pull and repaired corner seam.",
                    "found_at": "2026-08-28T21:07:00Z",
                    "found_zone": "Terminal C security return",
                    "route_tags": ["conference-airport", "metro-blue", "terminal-c"],
                    "storage_slot": "SIM-NPA-B17",
                    "risk_tier": "VALUABLE",
                    "initial_version": 5,
                    "initial_etag": '"na-231-v5"',
                },
                {
                    "item_id": "NPA-UMB-011",
                    "custodian_id": "northport-air",
                    "remote_key": "npa-intake-20260829-011",
                    "category": "umbrella",
                    "coarse_description": "Compact navy umbrella with a curved handle.",
                    "found_at": "2026-08-29T13:02:00Z",
                    "found_zone": "Terminal 2 security benches",
                    "route_tags": ["terminal-2"],
                    "storage_slot": "SIM-NPA-A03",
                    "risk_tier": "ORDINARY",
                },
                {
                    "item_id": "NPA-AUD-019",
                    "custodian_id": "northport-air",
                    "remote_key": "npa-intake-20260829-019",
                    "category": "headphones",
                    "coarse_description": "Black over-ear headphones in a fabric sleeve.",
                    "found_at": "2026-08-29T12:44:00Z",
                    "found_zone": "Gate N18 seating",
                    "route_tags": ["terminal-2", "gate-n18"],
                    "storage_slot": "SIM-NPA-C09",
                    "risk_tier": "VALUABLE",
                },
                {
                    "item_id": "ML-PCH-219",
                    "custodian_id": "metro-loop",
                    "remote_key": "ml-blue-20260828-219",
                    "category": "camera_pouch",
                    "coarse_description": "Small black camera pouch with a grey zipper pull.",
                    "found_at": "2026-08-28T20:15:00Z",
                    "found_zone": "Blue Line car 714",
                    "route_tags": ["conference-airport", "metro-blue", "car-714"],
                    "storage_slot": "SIM-MTL-LF22",
                    "risk_tier": "VALUABLE",
                    "initial_version": 2,
                    "initial_etag": '"ml-219-v2"',
                },
                {
                    "item_id": "MTL-TOT-064",
                    "custodian_id": "metro-loop",
                    "remote_key": "mtl-red-20260829-064",
                    "category": "tote",
                    "coarse_description": "Empty tan canvas tote with blue handles.",
                    "found_at": "2026-08-29T10:17:00Z",
                    "found_zone": "Red Line platform 3",
                    "route_tags": ["metro-red", "platform-3"],
                    "storage_slot": "SIM-MTL-LF08",
                    "risk_tier": "ORDINARY",
                },
                {
                    "item_id": "MTL-BOK-031",
                    "custodian_id": "metro-loop",
                    "remote_key": "mtl-green-20260829-031",
                    "category": "book",
                    "coarse_description": "Paperback travel guide with a green cover.",
                    "found_at": "2026-08-29T09:08:00Z",
                    "found_zone": "Green Line interchange",
                    "route_tags": ["metro-green", "interchange"],
                    "storage_slot": "SIM-MTL-LF04",
                    "risk_tier": "ORDINARY",
                },
                {
                    "item_id": "GH-PCH-104",
                    "custodian_id": "grand-hall",
                    "remote_key": "gh-coat-check-20260828-104",
                    "category": "camera_pouch",
                    "coarse_description": "Compact black padded camera pouch with a top zip.",
                    "found_at": "2026-08-28T18:42:00Z",
                    "found_zone": "Coat Check B",
                    "route_tags": ["conference-airport", "grand-hall", "coat-check-b"],
                    "storage_slot": "SIM-GHH-D12",
                    "risk_tier": "VALUABLE",
                    "initial_version": 3,
                    "initial_etag": '"gh-104-v3"',
                },
                {
                    "item_id": "GHH-CHG-024",
                    "custodian_id": "grand-hall",
                    "remote_key": "ghh-halla-20260829-024",
                    "category": "charger",
                    "coarse_description": "White laptop charger with a coiled cable.",
                    "found_at": "2026-08-29T11:36:00Z",
                    "found_zone": "Hall A press table",
                    "route_tags": ["grand-hall", "hall-a"],
                    "storage_slot": "SIM-GHH-E02",
                    "risk_tier": "VALUABLE",
                },
                {
                    "item_id": "GHH-GLS-015",
                    "custodian_id": "grand-hall",
                    "remote_key": "ghh-cafe-20260829-015",
                    "category": "glasses",
                    "coarse_description": "Reading glasses in a blue hard case.",
                    "found_at": "2026-08-29T10:51:00Z",
                    "found_zone": "Atrium cafe",
                    "route_tags": ["grand-hall", "atrium"],
                    "storage_slot": "SIM-GHH-C06",
                    "risk_tier": "ORDINARY",
                },
            ]

            self.items = {}
            for item in seed_items:
                initial_version = item.pop("initial_version", 1)
                initial_etag = item.pop("initial_etag", None)
                seeded = {
                    **item,
                    "status": "AVAILABLE",
                    "version": initial_version,
                    "record_scope": "SIMULATOR_FIXTURE_ONLY",
                    "reservation_id": None,
                }
                seeded["etag"] = initial_etag or _etag("item", seeded["item_id"], seeded["version"])
                self.items[seeded["item_id"]] = seeded

            self.reservations = {}
            self.idempotency_records = {}
            return self.fixture_summary()

    def fixture_summary(self) -> dict[str, Any]:
        return {
            "fixture_version": self.fixture_version,
            "custodian_count": len(self.custodians),
            "inventory_item_count": len(self.items),
            "reservation_count": len(self.reservations),
        }

    def list_custodians(self) -> list[dict[str, Any]]:
        with self._lock:
            return [deepcopy(self.custodians[key]) for key in sorted(self.custodians)]

    def list_inventory(
        self,
        custodian_id: str,
        *,
        category: str | None = None,
        status: str | None = None,
        route: str | None = None,
        found_after: datetime | None = None,
        found_before: datetime | None = None,
        query: str | None = None,
    ) -> list[dict[str, Any]]:
        with self._lock:
            self._require_custodian(custodian_id)
            self._expire_locked()
            results: list[dict[str, Any]] = []
            for item in self.items.values():
                if item["custodian_id"] != custodian_id:
                    continue
                if category and item["category"].casefold() != category.casefold():
                    continue
                if status and item["status"] != status.upper():
                    continue
                if route and route.casefold() not in {tag.casefold() for tag in item["route_tags"]}:
                    continue
                found_at = parse_datetime(item["found_at"])
                if found_after and found_at < self._aware(found_after):
                    continue
                if found_before and found_at > self._aware(found_before):
                    continue
                if query:
                    haystack = " ".join(
                        [
                            item["item_id"],
                            item["category"],
                            item["coarse_description"],
                            item["found_zone"],
                            *item["route_tags"],
                        ]
                    ).casefold()
                    if query.casefold() not in haystack:
                        continue
                results.append(self._public_item(item))
            return sorted(results, key=lambda item: (item["found_at"], item["item_id"]), reverse=True)

    def get_inventory_item(self, custodian_id: str, item_id: str) -> dict[str, Any]:
        with self._lock:
            self._require_custodian(custodian_id)
            self._expire_locked()
            item = self._require_item(item_id)
            if item["custodian_id"] != custodian_id:
                raise DomainError(404, "ITEM_NOT_FOUND", "No simulated item exists in that custodian namespace.")
            return self._public_item(item)

    def create_reservation(self, request: ReservationCreateRequest) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        scope = f"reserve:{request.idempotency_key}"
        with self._lock:
            replay = self._idempotent_replay(scope, payload)
            if replay is not None:
                return replay

            self._expire_locked()
            self._require_custodian(request.custodian_id)
            item = self._require_item(request.item_id)
            if item["custodian_id"] != request.custodian_id:
                raise DomainError(409, "CUSTODIAN_MISMATCH", "The item is outside the requested simulated custodian namespace.")
            self._check_version_and_etag(
                item,
                expected_version=request.expected_item_version,
                expected_etag=request.expected_item_etag,
                resource="item",
            )
            if item["status"] != "AVAILABLE":
                raise DomainError(
                    409,
                    "ITEM_NOT_AVAILABLE",
                    "The simulated item is not available for a new reservation.",
                    details={"status": item["status"]},
                )

            now = self.now()
            expires_at = self._aware(request.expires_at)
            if expires_at <= now:
                raise DomainError(410, "RESERVATION_EXPIRED", "The requested simulated reservation window has already expired.")
            if (expires_at - now).total_seconds() > 86_400:
                raise DomainError(422, "RESERVATION_WINDOW_TOO_LONG", "A simulated reservation may last at most 24 hours.")

            digest = hashlib.sha256(
                f"{request.case_id}|{request.item_id}|{request.idempotency_key}".encode("utf-8")
            ).hexdigest()[:14]
            reservation_id = f"SIM-RSV-{digest.upper()}"
            created_at = isoformat(now)

            item["version"] += 1
            item["status"] = "HELD"
            item["reservation_id"] = reservation_id
            item["etag"] = _etag("item", item["item_id"], item["version"])

            reservation = {
                "reservation_id": reservation_id,
                "case_id": request.case_id,
                "case_version": request.case_version,
                "custodian_id": request.custodian_id,
                "item_id": request.item_id,
                "destination": request.destination,
                "status": "HELD",
                "version": 1,
                "etag": _etag("reservation", reservation_id, 1),
                "expires_at": isoformat(expires_at),
                "token_expires_at": None,
                "token_hashes": {},
                "token_consumed": {"CUSTODIAN": False, "CLAIMANT": False},
                "attestations": {},
                "created_at": created_at,
                "updated_at": created_at,
                "history": [
                    self._history_event(
                        event_type="SIMULATED_RESERVATION_CREATED",
                        actor=request.actor,
                        reason=request.reason,
                        evidence_refs=request.evidence_refs,
                        idempotency_key=request.idempotency_key,
                        occurred_at=now,
                    )
                ],
            }
            self.reservations[reservation_id] = reservation
            response = {
                "reservation": self._public_reservation(reservation),
                "item": self._public_item(item),
                "idempotent_replay": False,
            }
            self._save_idempotent(scope, payload, response)
            return deepcopy(response)

    def get_reservation(self, reservation_id: str) -> dict[str, Any]:
        with self._lock:
            self._expire_locked()
            reservation = self._require_reservation(reservation_id)
            item = self._require_item(reservation["item_id"])
            return {
                "reservation": self._public_reservation(reservation),
                "item": self._public_item(item),
            }

    def issue_credentials(
        self,
        reservation_id: str,
        request: CredentialIssueRequest,
        *,
        token_secret: str,
    ) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        scope = f"credentials:{request.idempotency_key}"
        with self._lock:
            record = self._idempotency_record(scope, payload)
            if record is not None:
                response = deepcopy(record["response"])
                recipe = record["credential_recipe"]
                response["credentials"] = self._derive_credentials(
                    token_secret=token_secret,
                    reservation_id=recipe["reservation_id"],
                    generation=recipe["generation"],
                    expires_at=recipe["expires_at"],
                )
                response["idempotent_replay"] = True
                return response

            self._expire_locked()
            reservation = self._require_reservation(reservation_id)
            self._validate_reservation_binding(reservation, request)
            if reservation["status"] == "EXPIRED":
                raise DomainError(410, "RESERVATION_EXPIRED", "The simulated reservation has expired.")
            self._check_version_and_etag(
                reservation,
                expected_version=request.expected_reservation_version,
                expected_etag=request.expected_reservation_etag,
                resource="reservation",
            )
            if reservation["status"] != "HELD":
                code = "CREDENTIALS_ALREADY_ISSUED" if reservation["token_hashes"] else "INVALID_RESERVATION_STATE"
                raise DomainError(409, code, "Credentials cannot be issued from the current simulated reservation state.")

            now = self.now()
            token_expires_at = self._aware(request.token_expires_at)
            reservation_expires_at = parse_datetime(reservation["expires_at"])
            if token_expires_at <= now:
                raise DomainError(410, "CREDENTIAL_EXPIRED", "The requested simulated credential window has already expired.")
            if token_expires_at > reservation_expires_at:
                raise DomainError(422, "CREDENTIAL_OUTLIVES_RESERVATION", "Credentials may not outlive the simulated reservation.")

            generation = reservation["version"] + 1
            credentials = self._derive_credentials(
                token_secret=token_secret,
                reservation_id=reservation_id,
                generation=generation,
                expires_at=isoformat(token_expires_at),
            )
            reservation["token_hashes"] = {
                "CUSTODIAN": _hash_token(credentials["custodian_token"]),
                "CLAIMANT": _hash_token(credentials["claimant_token"]),
            }
            reservation["token_expires_at"] = credentials["expires_at"]
            self._advance_reservation(
                reservation,
                status="TOKENS_ISSUED",
                event_type="SIMULATED_CREDENTIALS_ISSUED",
                actor=request.actor,
                reason=request.reason,
                evidence_refs=request.evidence_refs,
                idempotency_key=request.idempotency_key,
                occurred_at=now,
            )

            safe_response = {
                "reservation": self._public_reservation(reservation),
                "idempotent_replay": False,
            }
            record = {
                "fingerprint": _fingerprint(payload),
                "response": deepcopy(safe_response),
                "credential_recipe": {
                    "reservation_id": reservation_id,
                    "generation": generation,
                    "expires_at": credentials["expires_at"],
                },
            }
            self.idempotency_records[scope] = record
            return {**deepcopy(safe_response), "credentials": credentials}

    def record_attestation(
        self,
        reservation_id: str,
        request: TokenAttestationRequest,
    ) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        fingerprint_payload = {**payload, "token": _hash_token(request.token)}
        scope = f"attestation:{request.idempotency_key}"
        with self._lock:
            replay = self._idempotent_replay(scope, fingerprint_payload)
            if replay is not None:
                return replay

            self._expire_locked()
            reservation = self._require_reservation(reservation_id)
            self._validate_reservation_binding(reservation, request)
            if reservation["status"] == "EXPIRED":
                raise DomainError(410, "RESERVATION_EXPIRED", "The simulated reservation has expired.")
            self._check_version_and_etag(
                reservation,
                expected_version=request.expected_reservation_version,
                expected_etag=request.expected_reservation_etag,
                resource="reservation",
            )

            if request.role in reservation["attestations"]:
                raise DomainError(409, "TOKEN_REPLAY_REJECTED", "That simulated role token has already been attested.")
            if reservation["status"] not in {"TOKENS_ISSUED", "PARTIALLY_ATTESTED"}:
                raise DomainError(409, "INVALID_RESERVATION_STATE", "Token presentation is not accepted in the current simulated state.")
            if not reservation["token_expires_at"] or self.now() >= parse_datetime(reservation["token_expires_at"]):
                raise DomainError(410, "CREDENTIAL_EXPIRED", "The simulated one-time credential has expired.")

            expected_hash = reservation["token_hashes"].get(request.role)
            if not expected_hash or not hmac.compare_digest(expected_hash, _hash_token(request.token)):
                raise DomainError(403, "TOKEN_MISMATCH", "The credential does not match the requested simulated role.")

            now = self.now()
            attestation_id = "SIM-ATT-" + hashlib.sha256(
                f"{reservation_id}|{request.role}|{request.idempotency_key}".encode("utf-8")
            ).hexdigest()[:14].upper()
            attestation = {
                "attestation_id": attestation_id,
                "role": request.role,
                "presented_at": isoformat(now),
                "statement": (
                    "One-time token presentation recorded by the simulator; this is not proof "
                    "of physical possession, delivery, or transfer."
                ),
            }
            reservation["attestations"][request.role] = attestation
            reservation["token_consumed"][request.role] = True
            next_status = "CALLBACK_READY" if len(reservation["attestations"]) == 2 else "PARTIALLY_ATTESTED"
            self._advance_reservation(
                reservation,
                status=next_status,
                event_type=f"SIMULATED_{request.role}_TOKEN_ATTESTED",
                actor=request.actor,
                reason=request.reason,
                evidence_refs=request.evidence_refs,
                idempotency_key=request.idempotency_key,
                occurred_at=now,
            )
            response = {
                "reservation": self._public_reservation(reservation),
                "attestation": deepcopy(attestation),
                "idempotent_replay": False,
            }
            self._save_idempotent(scope, fingerprint_payload, response)
            return deepcopy(response)

    def finalize_handoff_attestation(
        self,
        reservation_id: str,
        request: HandoffAttestationRequest,
        *,
        callback_secret: str,
    ) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        scope = f"handoff:{request.idempotency_key}"
        with self._lock:
            replay = self._idempotent_replay(scope, payload)
            if replay is not None:
                return replay

            self._expire_locked()
            reservation = self._require_reservation(reservation_id)
            self._validate_reservation_binding(reservation, request)
            if reservation["status"] == "EXPIRED":
                raise DomainError(410, "RESERVATION_EXPIRED", "The simulated reservation has expired.")
            self._check_version_and_etag(
                reservation,
                expected_version=request.expected_reservation_version,
                expected_etag=request.expected_reservation_etag,
                resource="reservation",
            )
            if reservation["status"] == "HANDOFF_ATTESTED":
                raise DomainError(409, "HANDOFF_REPLAY_REJECTED", "The simulated handoff attestation was already finalized.")
            if reservation["status"] != "CALLBACK_READY":
                raise DomainError(409, "HANDOFF_NOT_READY", "Both distinct simulated token attestations are required first.")
            if self.now() >= parse_datetime(reservation["expires_at"]):
                raise DomainError(410, "RESERVATION_EXPIRED", "The simulated reservation has expired.")
            if not reservation["token_expires_at"] or self.now() >= parse_datetime(reservation["token_expires_at"]):
                raise DomainError(410, "CREDENTIAL_EXPIRED", "The simulated credential window expired before finalization.")

            item = self._require_item(reservation["item_id"])
            if item["status"] != "HELD" or item["reservation_id"] != reservation_id:
                raise DomainError(409, "ITEM_STATE_MISMATCH", "The simulated item is no longer held for this reservation.")

            now = self.now()
            self._advance_reservation(
                reservation,
                status="HANDOFF_ATTESTED",
                event_type="SIMULATED_HANDOFF_ATTESTATION_FINALIZED",
                actor=request.actor,
                reason=request.reason,
                evidence_refs=request.evidence_refs,
                idempotency_key=request.idempotency_key,
                occurred_at=now,
            )
            item["version"] += 1
            item["status"] = "RELEASED"
            item["etag"] = _etag("item", item["item_id"], item["version"])

            event_id = "SIM-EVT-" + hashlib.sha256(
                f"{reservation_id}|{request.idempotency_key}".encode("utf-8")
            ).hexdigest()[:16].upper()
            callback_body = {
                "schema_version": "1",
                "event_id": event_id,
                "event_type": "SIMULATED_TOKEN_HANDOFF_ATTESTED",
                "simulation": callback_disclosure(),
                "reservation_id": reservation_id,
                "case_id": reservation["case_id"],
                "case_version": reservation["case_version"],
                "item_id": reservation["item_id"],
                "custodian_id": reservation["custodian_id"],
                "reservation_version": reservation["version"],
                "item_version": item["version"],
                "occurred_at": isoformat(now),
                "attestation_statement": (
                    "Both one-time token presentations were accepted by the simulator. "
                    "This event does not prove physical possession, delivery, or transfer."
                ),
            }
            timestamp = str(int(now.timestamp()))
            message = f"{timestamp}.{canonical_json(callback_body)}".encode("utf-8")
            signature = hmac.new(callback_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
            response = {
                "reservation": self._public_reservation(reservation),
                "item": self._public_item(item),
                "callback_artifact": {
                    "body": callback_body,
                    "headers": {
                        "X-Found-Roll-Simulator-Timestamp": timestamp,
                        "X-Found-Roll-Simulator-Signature": f"v1={signature}",
                    },
                    "delivery_notice": (
                        "Signed simulator callback artifact only; no physical transfer or "
                        "external delivery is asserted."
                    ),
                },
                "idempotent_replay": False,
            }
            self._save_idempotent(scope, payload, response)
            return deepcopy(response)

    @staticmethod
    def verify_callback_artifact(
        body: dict[str, Any],
        *,
        timestamp: str,
        signature: str,
        callback_secret: str,
    ) -> bool:
        """Consumer-side helper used by contract tests and sample integrations."""

        if not signature.startswith("v1="):
            return False
        message = f"{timestamp}.{canonical_json(body)}".encode("utf-8")
        expected = hmac.new(callback_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature[3:], expected)

    def _derive_credentials(
        self,
        *,
        token_secret: str,
        reservation_id: str,
        generation: int,
        expires_at: str,
    ) -> dict[str, str]:
        values: dict[str, str] = {"expires_at": expires_at}
        for role, field in (("CLAIMANT", "claimant_token"), ("CUSTODIAN", "custodian_token")):
            message = f"{reservation_id}|{role}|{generation}|{expires_at}".encode("utf-8")
            digest = hmac.new(token_secret.encode("utf-8"), message, hashlib.sha256).digest()
            encoded = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
            values[field] = f"sim_{role.lower()}_{encoded}"
        return values

    def _expire_locked(self) -> None:
        now = self.now()
        for reservation in self.reservations.values():
            if reservation["status"] in {"EXPIRED", "HANDOFF_ATTESTED"}:
                continue
            if now < parse_datetime(reservation["expires_at"]):
                continue
            reservation["status"] = "EXPIRED"
            reservation["version"] += 1
            reservation["etag"] = _etag("reservation", reservation["reservation_id"], reservation["version"])
            reservation["updated_at"] = isoformat(now)
            reservation["history"].append(
                self._history_event(
                    event_type="SIMULATED_RESERVATION_EXPIRED",
                    actor="simulator-clock",
                    reason="Configured simulated reservation window elapsed.",
                    evidence_refs=[reservation["reservation_id"]],
                    idempotency_key=f"expiry:{reservation['reservation_id']}",
                    occurred_at=now,
                )
            )
            item = self.items[reservation["item_id"]]
            if item["status"] == "HELD" and item["reservation_id"] == reservation["reservation_id"]:
                item["status"] = "AVAILABLE"
                item["reservation_id"] = None
                item["version"] += 1
                item["etag"] = _etag("item", item["item_id"], item["version"])

    def _advance_reservation(
        self,
        reservation: dict[str, Any],
        *,
        status: str,
        event_type: str,
        actor: str,
        reason: str,
        evidence_refs: list[str],
        idempotency_key: str,
        occurred_at: datetime,
    ) -> None:
        reservation["status"] = status
        reservation["version"] += 1
        reservation["etag"] = _etag("reservation", reservation["reservation_id"], reservation["version"])
        reservation["updated_at"] = isoformat(occurred_at)
        reservation["history"].append(
            self._history_event(
                event_type=event_type,
                actor=actor,
                reason=reason,
                evidence_refs=evidence_refs,
                idempotency_key=idempotency_key,
                occurred_at=occurred_at,
            )
        )

    @staticmethod
    def _history_event(
        *,
        event_type: str,
        actor: str,
        reason: str,
        evidence_refs: list[str],
        idempotency_key: str,
        occurred_at: datetime,
    ) -> dict[str, Any]:
        return {
            "event_type": event_type,
            "actor": actor,
            "reason": reason,
            "evidence_refs": list(evidence_refs),
            "idempotency_key": idempotency_key,
            "occurred_at": isoformat(occurred_at),
        }

    def _public_item(self, item: dict[str, Any]) -> dict[str, Any]:
        return deepcopy(item)

    def _public_reservation(self, reservation: dict[str, Any]) -> dict[str, Any]:
        public = {
            key: deepcopy(value)
            for key, value in reservation.items()
            if key not in {"token_hashes", "token_consumed"}
        }
        public["token_status"] = {
            role: (
                "ATTESTED"
                if role in reservation["attestations"]
                else "ISSUED"
                if reservation["token_hashes"].get(role)
                else "NOT_ISSUED"
            )
            for role in ("CUSTODIAN", "CLAIMANT")
        }
        return public

    def _require_custodian(self, custodian_id: str) -> dict[str, Any]:
        custodian = self.custodians.get(custodian_id)
        if custodian is None:
            raise DomainError(404, "CUSTODIAN_NOT_FOUND", "No fictional custodian exists for that namespace.")
        return custodian

    def _require_item(self, item_id: str) -> dict[str, Any]:
        item = self.items.get(item_id)
        if item is None:
            raise DomainError(404, "ITEM_NOT_FOUND", "No simulated inventory item exists for that identifier.")
        return item

    def _require_reservation(self, reservation_id: str) -> dict[str, Any]:
        reservation = self.reservations.get(reservation_id)
        if reservation is None:
            raise DomainError(404, "RESERVATION_NOT_FOUND", "No simulated reservation exists for that identifier.")
        return reservation

    @staticmethod
    def _check_version_and_etag(
        resource_record: dict[str, Any],
        *,
        expected_version: int,
        expected_etag: str,
        resource: str,
    ) -> None:
        if resource_record["version"] != expected_version:
            raise DomainError(
                409,
                "STALE_VERSION",
                f"The expected simulated {resource} version is stale.",
                details={"current_version": resource_record["version"]},
            )
        if not hmac.compare_digest(resource_record["etag"], expected_etag):
            raise DomainError(
                412,
                "STALE_ETAG",
                f"The expected simulated {resource} eTag does not match.",
                details={"current_etag": resource_record["etag"]},
            )

    @staticmethod
    def _validate_reservation_binding(reservation: dict[str, Any], request: Any) -> None:
        mismatches: list[str] = []
        for field in ("case_id", "case_version", "item_id", "custodian_id"):
            if reservation[field] != getattr(request, field):
                mismatches.append(field)
        if mismatches:
            raise DomainError(
                409,
                "RESERVATION_BINDING_MISMATCH",
                "The request does not match the simulated reservation binding.",
                details={"mismatched_fields": mismatches},
            )

    def _idempotency_record(self, scope: str, payload: Any) -> dict[str, Any] | None:
        record = self.idempotency_records.get(scope)
        if record is None:
            return None
        if not hmac.compare_digest(record["fingerprint"], _fingerprint(payload)):
            raise DomainError(
                409,
                "IDEMPOTENCY_KEY_REUSED",
                "The idempotency key was already used with a different simulated request.",
            )
        return record

    def _idempotent_replay(self, scope: str, payload: Any) -> dict[str, Any] | None:
        record = self._idempotency_record(scope, payload)
        if record is None:
            return None
        response = deepcopy(record["response"])
        response["idempotent_replay"] = True
        return response

    def _save_idempotent(self, scope: str, payload: Any, response: dict[str, Any]) -> None:
        self.idempotency_records[scope] = {
            "fingerprint": _fingerprint(payload),
            "response": deepcopy(response),
        }

    @staticmethod
    def _aware(value: datetime) -> datetime:
        if value.tzinfo is None:
            raise DomainError(422, "TIMEZONE_REQUIRED", "Timestamps must include an explicit timezone.")
        return value.astimezone(timezone.utc)
