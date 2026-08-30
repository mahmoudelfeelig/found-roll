from __future__ import annotations

from dataclasses import replace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agent import FixtureCaseAnalyst, VertexAdkCaseAnalyst
from app.config import Settings
from app.correlation import (
    CORRELATION_HEADER,
    bind_correlation_id,
    reset_correlation_id,
)
from app.errors import Conflict, Unavailable
from app.evidence import InMemoryEvidenceStore
from app.fixtures import fixture_candidates
from app.inventory import FixtureInventoryGateway, HttpInventoryGateway
from app.main import _components, create_app
from app.outbox import InlineTaskPublisher
from app.relay import FixtureRelayGateway
from app.repository import InMemoryRepository


SAFE_CANDIDATE_FIELDS = {
    "id",
    "tenant_id",
    "tenant_name",
    "category",
    "coarse_description",
    "found_at",
    "found_zone",
    "availability",
    "public_signals",
    "route_compatible",
    "time_compatible",
    "visible_signal_count",
    "frozen_score",
}


def _settings() -> Settings:
    return Settings(
        inventory_mode="http",
        inventory_base_url="https://simulator.example.test",
        inventory_timeout_seconds=1.0,
    )


def _remote_item(
    *,
    item_id: str = "NA-PCH-231",
    custodian_id: str = "northport-air",
    category: str = "camera_pouch",
    status: str = "AVAILABLE",
    version: int = 5,
    etag: str = '"na-231-v5"',
) -> dict[str, Any]:
    return {
        "item_id": item_id,
        "custodian_id": custodian_id,
        "category": category,
        "coarse_description": "Live public description from the fictional custodian.",
        "found_at": "2026-08-28T21:08:00Z",
        "found_zone": "Live public simulator zone",
        "status": status,
        "version": version,
        "etag": etag,
        "remote_key": "must-not-reach-model",
        "storage_slot": "must-not-reach-model",
        "risk_tier": "VALUABLE",
        "restricted_value_hash": "must-not-reach-model",
    }


def _envelope(data: dict[str, Any], *, mode: str = "SIMULATED") -> dict[str, Any]:
    return {
        "simulation": {
            "mode": mode,
            "fixture": "camera-pouch-v1",
            "notice": "Fictional synthetic inventory response for contract testing only.",
        },
        "data": data,
    }


def test_http_inventory_uses_real_mock_transport_and_returns_only_authorized_safe_fields():
    candidates = fixture_candidates("inventory-test-pepper")
    northport = [candidate for candidate in candidates if candidate.tenant_id == "northport-air"]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers[CORRELATION_HEADER] == "corr-inventory-http-0001"
        assert request.headers["Accept"] == "application/json"
        headers = {"X-Found-Roll-Mode": "SIMULATED"}
        if request.url.path.endswith("/inventory"):
            items = [
                _remote_item(),
                _remote_item(item_id="NPA-UMB-011", category="umbrella"),
            ]
            return httpx.Response(
                200,
                headers=headers,
                json=_envelope(
                    {
                        "custodian_id": "northport-air",
                        "items": items,
                        "count": len(items),
                    }
                ),
            )
        return httpx.Response(
            200,
            headers=headers,
            json=_envelope({"item": _remote_item()}),
        )

    gateway = HttpInventoryGateway(
        _settings(), transport=httpx.MockTransport(handler)
    )
    token = bind_correlation_id("corr-inventory-http-0001")
    try:
        listed = gateway.search_custodian("northport-air", northport)
        loaded = gateway.load_candidate("NA-PCH-231", northport)
    finally:
        reset_correlation_id(token)

    assert [row["id"] for row in listed["candidates"]] == ["NA-PCH-231"]
    assert listed["source"] == "simulator_http"
    assert listed["restricted_fields_included"] is False
    assert set(listed["candidates"][0]) == SAFE_CANDIDATE_FIELDS
    assert set(loaded) == SAFE_CANDIDATE_FIELDS
    assert loaded["coarse_description"].startswith("Live public description")
    assert loaded["availability"] == "AVAILABLE"
    assert all(
        marker not in str(listed) + str(loaded)
        for marker in ("remote_key", "storage_slot", "risk_tier", "restricted_value_hash")
    )
    assert [request.url.path for request in requests] == [
        "/v1/custodians/northport-air/inventory",
        "/v1/custodians/northport-air/inventory/NA-PCH-231",
    ]


def test_http_inventory_rejects_unauthorized_scope_without_network_access():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    gateway = HttpInventoryGateway(
        _settings(), transport=httpx.MockTransport(handler)
    )
    northport = [
        candidate
        for candidate in fixture_candidates("inventory-test-pepper")
        if candidate.tenant_id == "northport-air"
    ]

    assert gateway.search_custodian("grand-hall", northport)["error"] == "tenant_not_authorized"
    assert gateway.load_candidate("GH-PCH-104", northport)["error"] == "candidate_not_authorized"
    assert calls == 0


@pytest.mark.parametrize(
    ("mode_header", "payload", "expected_code"),
    [
        (
            None,
            _envelope(
                {
                    "custodian_id": "northport-air",
                    "items": [_remote_item()],
                    "count": 1,
                }
            ),
            "inventory_disclosure_missing",
        ),
        (
            "SIMULATED",
            _envelope(
                {
                    "custodian_id": "northport-air",
                    "items": [_remote_item()],
                    "count": 2,
                }
            ),
            "inventory_contract_invalid",
        ),
        (
            "SIMULATED",
            _envelope(
                {
                    "custodian_id": "northport-air",
                    "items": [_remote_item(custodian_id="another-custodian")],
                    "count": 1,
                }
            ),
            "inventory_scope_mismatch",
        ),
        (
            "SIMULATED",
            _envelope(
                {
                    "custodian_id": "northport-air",
                    "items": [_remote_item(version=6, etag='"na-231-v6"')],
                    "count": 1,
                }
            ),
            "inventory_version_mismatch",
        ),
        (
            "SIMULATED",
            _envelope(
                {
                    "custodian_id": "northport-air",
                    "items": [_remote_item()],
                    "count": 1,
                },
                mode="LIVE",
            ),
            "inventory_contract_invalid",
        ),
    ],
)
def test_http_inventory_fails_closed_on_disclosure_schema_and_scope_errors(
    mode_header: str | None,
    payload: dict[str, Any],
    expected_code: str,
):
    def handler(_request: httpx.Request) -> httpx.Response:
        headers = {"X-Found-Roll-Mode": mode_header} if mode_header else {}
        return httpx.Response(200, headers=headers, json=payload)

    gateway = HttpInventoryGateway(
        _settings(), transport=httpx.MockTransport(handler)
    )
    northport = [
        candidate
        for candidate in fixture_candidates("inventory-test-pepper")
        if candidate.tenant_id == "northport-air"
    ]
    with pytest.raises(Unavailable) as raised:
        gateway.search_custodian("northport-air", northport)
    assert raised.value.code == expected_code
    assert "must-not-reach-model" not in raised.value.message


def test_http_inventory_sanitizes_transport_failures():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("private-network-detail", request=request)

    gateway = HttpInventoryGateway(
        _settings(), transport=httpx.MockTransport(handler)
    )
    candidates = fixture_candidates("inventory-test-pepper")
    with pytest.raises(Unavailable) as raised:
        gateway.load_candidate("NA-PCH-231", candidates)
    assert raised.value.code == "inventory_unavailable"
    assert "private-network-detail" not in raised.value.message


def test_vertex_inventory_tools_call_the_configured_gateway():
    class SpyGateway:
        mode = "spy"

        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        def search_custodian(self, tenant_id, candidates):
            self.calls.append(("search", tenant_id))
            return {"candidates": [], "restricted_fields_included": False}

        def load_candidate(self, candidate_id, candidates):
            self.calls.append(("load", candidate_id))
            return {"id": candidate_id}

    gateway = SpyGateway()
    analyst = VertexAdkCaseAnalyst(
        project="fixture-project",
        location="us-central1",
        model_name="gemini-3.5-flash",
        inventory_gateway=gateway,
    )
    agent = analyst._build_agent(fixture_candidates("inventory-test-pepper"))

    assert agent.tools[0]("northport-air")["restricted_fields_included"] is False
    assert agent.tools[1]("NA-PCH-231")["id"] == "NA-PCH-231"
    assert gateway.calls == [
        ("search", "northport-air"),
        ("load", "NA-PCH-231"),
    ]


def test_vertex_rejects_a_selected_candidate_that_is_not_live_available():
    candidate = fixture_candidates("inventory-test-pepper")[-1]

    class HeldGateway:
        mode = "http"

        def search_custodian(self, tenant_id, candidates):
            return {"candidates": []}

        def load_candidate(self, candidate_id, candidates):
            return {
                "id": candidate_id,
                "availability": "HELD",
            }

    analyst = VertexAdkCaseAnalyst(
        project="fixture-project",
        location="us-central1",
        model_name="gemini-3.5-flash",
        inventory_gateway=HeldGateway(),
    )
    with pytest.raises(Conflict) as raised:
        analyst._validate_selected_inventory(candidate.id, [candidate])
    assert raised.value.code == "agent_candidate_unavailable"


def test_production_vertex_requires_https_http_inventory_gateway():
    baseline = Settings(
        environment="production",
        analyst_mode="vertex_adk",
        secret_pepper="production-private-answer-pepper-0001",
        relay_shared_secret="production-callback-secret-0001",
    )
    with pytest.raises(ValueError, match="INVENTORY_MODE=http"):
        baseline.validate()

    insecure = replace(
        baseline,
        inventory_mode="http",
        inventory_base_url="http://simulator.example.test",
    )
    with pytest.raises(ValueError, match="must use HTTPS"):
        insecure.validate()

    embedded_credentials = replace(
        baseline,
        inventory_mode="http",
        inventory_base_url="https://user:secret@simulator.example.test",
    )
    with pytest.raises(ValueError, match="without credentials"):
        embedded_credentials.validate()

    with pytest.raises(ValueError, match="requires the HTTP inventory gateway"):
        _components(
            baseline,
            repository=InMemoryRepository(),
            evidence_store=InMemoryEvidenceStore(),
            inventory_gateway=FixtureInventoryGateway(),
            analyst=FixtureCaseAnalyst(),
            relay=FixtureRelayGateway(),
            task_publisher=InlineTaskPublisher(),
        )


def test_health_identifies_configured_http_inventory_mode():
    settings = _settings()

    def healthy_simulator(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/healthz"
        return httpx.Response(
            200,
            headers={"X-Found-Roll-Mode": "SIMULATED"},
            json=_envelope(
                {
                    "status": "ok",
                    "service": "found-roll-simulator",
                    "api_version": "v1",
                    "fixture_version": "camera-pouch-v1",
                    "environment": "development",
                    "mutation_auth_configured": True,
                    "callback_signing_configured": True,
                    "token_derivation_configured": True,
                }
            ),
        )

    gateway = HttpInventoryGateway(
        settings,
        transport=httpx.MockTransport(healthy_simulator),
    )
    with TestClient(create_app(settings=settings, inventory_gateway=gateway)) as client:
        health = client.get("/api/v1/healthz")

    assert health.status_code == 200
    assert health.json()["inventory_mode"] == "http"
    assert health.json()["inventory_base_url_configured"] is True
    assert health.json()["inventory_gateway_configured"] is True
    assert health.json()["inventory_gateway_ready"] is True
    assert health.json()["inventory_timeout_seconds"] == 1.0

    unavailable_gateway = HttpInventoryGateway(
        settings,
        transport=httpx.MockTransport(lambda _request: httpx.Response(500)),
    )
    with TestClient(
        create_app(settings=settings, inventory_gateway=unavailable_gateway)
    ) as client:
        unavailable = client.get("/api/v1/healthz")
    assert unavailable.status_code == 503
    assert unavailable.json()["status"] == "unavailable"
    assert unavailable.json()["inventory_gateway_configured"] is True
    assert unavailable.json()["inventory_gateway_ready"] is False


def test_health_contract_accepts_additive_v1_diagnostics_and_pre_environment_payloads():
    settings = _settings()
    base_data = {
        "status": "ok",
        "service": "found-roll-simulator",
        "api_version": "v1",
        "fixture_version": "camera-pouch-v1",
        "mutation_auth_configured": True,
        "callback_signing_configured": True,
        "token_derivation_configured": True,
    }
    payloads = [
        base_data,
        {**base_data, "environment": "production", "future_diagnostic": "compatible"},
    ]

    for data in payloads:
        gateway = HttpInventoryGateway(
            settings,
            transport=httpx.MockTransport(
                lambda _request, response_data=data: httpx.Response(
                    200,
                    headers={"X-Found-Roll-Mode": "SIMULATED"},
                    json=_envelope(response_data),
                )
            ),
        )
        assert gateway.is_ready() is True


def test_production_health_requires_a_production_simulator_environment():
    settings = replace(_settings(), environment="production")
    base_data = {
        "status": "ok",
        "service": "found-roll-simulator",
        "api_version": "v1",
        "fixture_version": "camera-pouch-v1",
        "mutation_auth_configured": True,
        "callback_signing_configured": True,
        "token_derivation_configured": True,
    }

    for environment, expected in ((None, False), ("development", False), ("production", True)):
        data = {**base_data, **({"environment": environment} if environment else {})}
        gateway = HttpInventoryGateway(
            settings,
            transport=httpx.MockTransport(
                lambda _request, response_data=data: httpx.Response(
                    200,
                    headers={"X-Found-Roll-Mode": "SIMULATED"},
                    json=_envelope(response_data),
                )
            ),
        )
        assert gateway.is_ready() is expected


def test_transitional_production_health_accepts_only_a_missing_legacy_environment():
    settings = replace(
        _settings(),
        environment="production",
        inventory_allow_legacy_health_without_environment=True,
    )
    base_data = {
        "status": "ok",
        "service": "found-roll-simulator",
        "api_version": "v1",
        "fixture_version": "camera-pouch-v1",
        "mutation_auth_configured": True,
        "callback_signing_configured": True,
        "token_derivation_configured": True,
    }

    for environment, expected in ((None, True), ("development", False), ("production", True)):
        data = {**base_data, **({"environment": environment} if environment else {})}
        gateway = HttpInventoryGateway(
            settings,
            transport=httpx.MockTransport(
                lambda _request, response_data=data: httpx.Response(
                    200,
                    headers={"X-Found-Roll-Mode": "SIMULATED"},
                    json=_envelope(response_data),
                )
            ),
        )
        assert gateway.is_ready() is expected
