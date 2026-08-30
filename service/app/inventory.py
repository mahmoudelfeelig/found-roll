"""Claimant-safe inventory tools for fixture and live simulator modes."""

from __future__ import annotations

from typing import Any, Literal, Protocol
from urllib.parse import quote

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from .config import Settings
from .correlation import CORRELATION_HEADER, get_or_create_correlation_id
from .domain import Candidate
from .errors import Unavailable


class InventoryGateway(Protocol):
    mode: str

    def is_ready(self) -> bool: ...

    def search_custodian(
        self,
        tenant_id: str,
        candidates: list[Candidate],
    ) -> dict[str, Any]: ...

    def load_candidate(
        self,
        candidate_id: str,
        candidates: list[Candidate],
    ) -> dict[str, Any]: ...


def claimant_safe_candidate(candidate: Candidate) -> dict[str, Any]:
    """The complete and only candidate shape exposed to the model."""

    return {
        "id": candidate.id,
        "tenant_id": candidate.tenant_id,
        "tenant_name": candidate.tenant_name,
        "category": candidate.category,
        "coarse_description": candidate.coarse_description,
        "found_at": candidate.found_at.isoformat(),
        "found_zone": candidate.found_zone,
        "availability": candidate.availability,
        "public_signals": candidate.public_signals,
        "route_compatible": candidate.route_compatible,
        "time_compatible": candidate.time_compatible,
        "visible_signal_count": candidate.visible_signal_count,
        "frozen_score": candidate.frozen_score,
    }


class FixtureInventoryGateway:
    """Deterministic local tool boundary with no network behavior."""

    mode = "fixture"

    def is_ready(self) -> bool:
        return True

    def search_custodian(
        self,
        tenant_id: str,
        candidates: list[Candidate],
    ) -> dict[str, Any]:
        authorized_tenants = {candidate.tenant_id for candidate in candidates}
        if tenant_id not in authorized_tenants:
            return {"error": "tenant_not_authorized", "restricted_fields_included": False}
        return {
            "candidates": [
                claimant_safe_candidate(candidate)
                for candidate in candidates
                if candidate.tenant_id == tenant_id
            ],
            "restricted_fields_included": False,
            "source": "deterministic_fixture",
        }

    def load_candidate(
        self,
        candidate_id: str,
        candidates: list[Candidate],
    ) -> dict[str, Any]:
        authorized = {candidate.id: candidate for candidate in candidates}
        if candidate_id not in authorized:
            return {"error": "candidate_not_authorized"}
        return claimant_safe_candidate(authorized[candidate_id])


class _SimulationDisclosure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["SIMULATED"]
    fixture: Literal["camera-pouch-v1"]
    notice: str = Field(min_length=8, max_length=500)


class _RemoteInventoryItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    item_id: str = Field(min_length=3, max_length=100)
    custodian_id: str = Field(min_length=2, max_length=80)
    category: str = Field(min_length=2, max_length=80)
    coarse_description: str = Field(min_length=8, max_length=500)
    found_at: AwareDatetime
    found_zone: str = Field(min_length=2, max_length=120)
    status: Literal["AVAILABLE", "HELD", "RELEASED"]
    version: int = Field(ge=0)
    etag: str = Field(min_length=3, max_length=160)


class _InventoryListData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    custodian_id: str
    items: list[_RemoteInventoryItem] = Field(max_length=100)
    count: int = Field(ge=0, le=100)


class _InventoryItemData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item: _RemoteInventoryItem


class _InventoryListEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    simulation: _SimulationDisclosure
    data: _InventoryListData


class _InventoryItemEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    simulation: _SimulationDisclosure
    data: _InventoryItemData


class _InventoryHealthData(BaseModel):
    # Health payloads are additive within API v1. Ignore future diagnostics so a
    # simulator rollout cannot make a compatible service revision fail closed.
    model_config = ConfigDict(extra="ignore")

    status: Literal["ok"]
    service: Literal["found-roll-simulator"]
    api_version: Literal["v1"]
    fixture_version: Literal["camera-pouch-v1"]
    environment: Literal["development", "production"] | None = None
    mutation_auth_configured: bool
    callback_signing_configured: bool
    token_derivation_configured: bool


class _InventoryHealthEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    simulation: _SimulationDisclosure
    data: _InventoryHealthData


class HttpInventoryGateway:
    """Bounded read-only adapter to the separately deployed simulator."""

    mode = "http"

    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not settings.inventory_base_url:
            raise Unavailable(
                "inventory_url_missing",
                "FOUND_ROLL_INVENTORY_BASE_URL is required for HTTP inventory mode.",
            )
        self._base_url = settings.inventory_base_url.rstrip("/")
        self._timeout = httpx.Timeout(
            settings.inventory_timeout_seconds,
            connect=min(settings.inventory_timeout_seconds, 2.0),
        )
        self._transport = transport
        self._require_production_environment = settings.environment == "production"
        self._allow_legacy_health_without_environment = (
            self._require_production_environment
            and settings.inventory_allow_legacy_health_without_environment
        )

    def is_ready(self) -> bool:
        try:
            _response, payload = self._get("/api/v1/healthz")
            health = _InventoryHealthEnvelope.model_validate(payload)
        except (Unavailable, ValidationError):
            return False
        if self._require_production_environment:
            if health.data.environment == "development":
                return False
            if (
                health.data.environment is None
                and not self._allow_legacy_health_without_environment
            ):
                return False
        return True

    def _get(self, path: str) -> tuple[httpx.Response, dict[str, Any]]:
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.get(
                    f"{self._base_url}{path}",
                    headers={
                        CORRELATION_HEADER: get_or_create_correlation_id(),
                        "Accept": "application/json",
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise Unavailable(
                "inventory_unavailable",
                "The SIMULATED custodian inventory could not be read safely.",
            ) from exc
        if response.headers.get("X-Found-Roll-Mode") != "SIMULATED":
            raise Unavailable(
                "inventory_disclosure_missing",
                "The inventory response omitted its SIMULATED response header.",
            )
        if not isinstance(payload, dict):
            raise Unavailable(
                "inventory_contract_invalid",
                "The inventory response contract is invalid.",
            )
        return response, payload

    @staticmethod
    def _overlay(candidate: Candidate, remote: _RemoteInventoryItem) -> dict[str, Any]:
        if remote.item_id != candidate.id or remote.custodian_id != candidate.tenant_id:
            raise Unavailable(
                "inventory_scope_mismatch",
                "The inventory response escaped the authorized candidate scope.",
            )
        if remote.category != candidate.category:
            raise Unavailable(
                "inventory_contract_mismatch",
                "The inventory candidate category did not match the authorized record.",
            )
        if (
            remote.version != candidate.remote_version
            or remote.etag != candidate.remote_etag
        ):
            raise Unavailable(
                "inventory_version_mismatch",
                "The inventory candidate changed after its authorized snapshot.",
            )
        safe = claimant_safe_candidate(candidate)
        safe.update(
            {
                "coarse_description": remote.coarse_description,
                "found_at": remote.found_at.isoformat(),
                "found_zone": remote.found_zone,
                "availability": remote.status,
            }
        )
        return safe

    def search_custodian(
        self,
        tenant_id: str,
        candidates: list[Candidate],
    ) -> dict[str, Any]:
        authorized = {
            candidate.id: candidate
            for candidate in candidates
            if candidate.tenant_id == tenant_id
        }
        if not authorized:
            return {"error": "tenant_not_authorized", "restricted_fields_included": False}
        _response, payload = self._get(
            f"/v1/custodians/{quote(tenant_id, safe='')}/inventory"
        )
        try:
            envelope = _InventoryListEnvelope.model_validate(payload)
        except ValidationError as exc:
            raise Unavailable(
                "inventory_contract_invalid",
                "The inventory list response did not satisfy the SIMULATED schema.",
            ) from exc
        if envelope.data.count != len(envelope.data.items):
            raise Unavailable(
                "inventory_contract_invalid",
                "The inventory list count did not match its item collection.",
            )
        if envelope.data.custodian_id != tenant_id:
            raise Unavailable(
                "inventory_scope_mismatch",
                "The inventory list referred to another custodian.",
            )
        seen: set[str] = set()
        safe_rows: list[dict[str, Any]] = []
        for remote in envelope.data.items:
            if remote.item_id not in authorized:
                continue
            if remote.item_id in seen:
                raise Unavailable(
                    "inventory_contract_invalid",
                    "The inventory list repeated an authorized candidate.",
                )
            seen.add(remote.item_id)
            safe_rows.append(self._overlay(authorized[remote.item_id], remote))
        return {
            "candidates": safe_rows,
            "restricted_fields_included": False,
            "source": "simulator_http",
        }

    def load_candidate(
        self,
        candidate_id: str,
        candidates: list[Candidate],
    ) -> dict[str, Any]:
        authorized = {candidate.id: candidate for candidate in candidates}
        candidate = authorized.get(candidate_id)
        if candidate is None:
            return {"error": "candidate_not_authorized"}
        _response, payload = self._get(
            "/v1/custodians/"
            f"{quote(candidate.tenant_id, safe='')}/inventory/{quote(candidate.id, safe='')}"
        )
        try:
            envelope = _InventoryItemEnvelope.model_validate(payload)
        except ValidationError as exc:
            raise Unavailable(
                "inventory_contract_invalid",
                "The inventory item response did not satisfy the SIMULATED schema.",
            ) from exc
        return self._overlay(candidate, envelope.data.item)
