from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.fixtures import DEMO_CASE_ID
from app.main import create_app


def _runtime_headers(settings: Settings) -> dict[str, str]:
    return {
        "X-Found-Roll-Demo-Token": settings.demo_access_token,
        "X-Found-Roll-Staff-Token": settings.evidence_staff_token,
        "X-Found-Roll-Supervisor-Token": settings.supervisor_token,
    }


def test_runtime_role_probe_is_strict_read_only_and_returns_configured_actor_ids():
    settings = Settings(
        environment="development",
        staff_actor_id="staff.probe-operator",
        supervisor_actor_id="supervisor.probe-reviewer",
    )
    with TestClient(create_app(settings=settings)) as client:
        before = client.get(f"/api/v1/passports/{DEMO_CASE_ID}").json()
        response = client.get(
            "/api/v1/auth/runtime-roles",
            headers=_runtime_headers(settings),
        )
        after = client.get(f"/api/v1/passports/{DEMO_CASE_ID}").json()

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store, private"
    assert response.json() == {
        "authenticated": True,
        "staff_actor_id": "staff.probe-operator",
        "supervisor_actor_id": "supervisor.probe-reviewer",
    }
    assert after == before


@pytest.mark.parametrize(
    ("header", "error_code"),
    [
        ("X-Found-Roll-Demo-Token", "demo_auth_required"),
        ("X-Found-Roll-Staff-Token", "staff_auth_required"),
        ("X-Found-Roll-Supervisor-Token", "supervisor_auth_required"),
    ],
)
def test_runtime_role_probe_rejects_each_wrong_role_even_in_development(header, error_code):
    settings = Settings(environment="development")
    headers = _runtime_headers(settings)
    headers[header] = "wrong-role-credential"

    with TestClient(create_app(settings=settings)) as client:
        response = client.get("/api/v1/auth/runtime-roles", headers=headers)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == error_code
