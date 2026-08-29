import pytest
from app.errors import Forbidden
from app.config import Settings
from app.main import _verify_task_oidc, create_app
from fastapi.testclient import TestClient
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token


TASK_SERVICE_ACCOUNT = "found-roll-tasks@example.iam.gserviceaccount.com"
PUBLIC_BASE_URL = "https://found-roll.example.test"


def _oidc_settings() -> Settings:
    return Settings(
        require_task_header=True,
        require_task_oidc=True,
        task_service_account=TASK_SERVICE_ACCOUNT,
        public_base_url=PUBLIC_BASE_URL,
    )


def _valid_claims(**updates):
    claims = {
        "iss": "https://accounts.google.com",
        "email": TASK_SERVICE_ACCOUNT,
        "email_verified": True,
    }
    claims.update(updates)
    return claims


def _install_offline_verifier(monkeypatch, *, claims=None, failure=None):
    captured = {}
    request_sentinel = object()

    monkeypatch.setattr(google_requests, "Request", lambda: request_sentinel)

    def verify(token, request, *, audience):
        captured.update(token=token, request=request, audience=audience)
        if failure is not None:
            raise failure
        return claims

    monkeypatch.setattr(id_token, "verify_oauth2_token", verify)
    captured["request_sentinel"] = request_sentinel
    return captured


def test_task_route_requires_google_oidc_when_configured():
    settings = _oidc_settings()
    app = create_app(settings=settings)
    with TestClient(app) as client:
        response = client.post(
            "/tasks/outbox",
            headers={"X-CloudTasks-TaskName": "projects/p/locations/l/queues/q/tasks/t"},
            json={
                "schema_version": "1",
                "case_id": "FR-20260829-0042",
                "outbox_id": "out-not-loaded",
            },
        )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "task_oidc_required"


@pytest.mark.parametrize(
    "failure_message",
    ["invalid signature", "token expired"],
    ids=["invalid-signature", "expired-token"],
)
def test_task_oidc_verifier_failures_are_sanitized_and_preserve_the_cause(
    monkeypatch, failure_message
):
    verifier_failure = ValueError(failure_message)
    _install_offline_verifier(monkeypatch, failure=verifier_failure)

    with pytest.raises(Forbidden) as raised:
        _verify_task_oidc("Bearer signed-task-token", _oidc_settings())

    assert raised.value.code == "task_oidc_invalid"
    assert raised.value.status_code == 403
    assert failure_message not in raised.value.message
    assert raised.value.__cause__ is verifier_failure


def test_task_oidc_rejects_wrong_issuer(monkeypatch):
    _install_offline_verifier(
        monkeypatch,
        claims=_valid_claims(iss="https://issuer.example.test"),
    )

    with pytest.raises(Forbidden) as raised:
        _verify_task_oidc("Bearer signed-task-token", _oidc_settings())

    assert raised.value.code == "task_oidc_issuer_invalid"


def test_task_oidc_rejects_wrong_service_account_principal(monkeypatch):
    _install_offline_verifier(
        monkeypatch,
        claims=_valid_claims(email="another-caller@example.iam.gserviceaccount.com"),
    )

    with pytest.raises(Forbidden) as raised:
        _verify_task_oidc("Bearer signed-task-token", _oidc_settings())

    assert raised.value.code == "task_oidc_principal_invalid"


def test_task_oidc_rejects_unverified_service_account_email(monkeypatch):
    _install_offline_verifier(
        monkeypatch,
        claims=_valid_claims(email_verified=False),
    )

    with pytest.raises(Forbidden) as raised:
        _verify_task_oidc("Bearer signed-task-token", _oidc_settings())

    assert raised.value.code == "task_oidc_principal_invalid"


def test_task_oidc_verifier_receives_configured_public_url_as_audience(monkeypatch):
    captured = _install_offline_verifier(monkeypatch, claims=_valid_claims())

    _verify_task_oidc("Bearer signed-task-token", _oidc_settings())

    assert captured["token"] == "signed-task-token"
    assert captured["audience"] == PUBLIC_BASE_URL
    assert captured["request"] is captured["request_sentinel"]
