from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from threading import Barrier
from types import SimpleNamespace

from PIL import Image
import pytest
from fastapi.testclient import TestClient

from app.agent import FixtureCaseAnalyst
from app.config import Settings
from app.domain import (
    CaseRecord,
    CustodyState,
    ExecutionClaimDisposition,
    OutboxFailureStage,
    OutboxKind,
    OutboxStatus,
    RiskTier,
)
from app.errors import Conflict, Unavailable
from app.evidence import InMemoryEvidenceStore
from app.fixtures import DEMO_CASE_ID, reset_demo_repository
from app.main import create_app
from app.outbox import CloudTasksPublisher, InlineTaskPublisher, make_outbox
from app.fixtures import fixture_case
from app.relay import FixtureRelayGateway
from app.repository import FirestoreRepository, InMemoryRepository, MutationSpec


DEMO_TOKEN = "production-demo-mutation-token-0001"
ADMIN_TOKEN = "production-demo-admin-token-000001"
STAFF_TOKEN = "production-evidence-staff-token-001"
SUPERVISOR_TOKEN = "production-supervisor-token-00001"


def _production_settings(**changes) -> Settings:
    base = Settings(
        environment="production",
        repository_backend="firestore",
        evidence_backend="gcs",
        analyst_mode="vertex_adk",
        inventory_mode="http",
        inventory_base_url="https://simulator.example.test",
        relay_mode="http",
        tasks_mode="cloud",
        demo_mode=True,
        require_task_header=True,
        require_task_oidc=True,
        google_cloud_project="fixture-project",
        google_cloud_location="global",
        firestore_namespace="foundRoll_synthetic_demo",
        evidence_bucket="fixture-private-evidence",
        evidence_staff_token=STAFF_TOKEN,
        supervisor_token=SUPERVISOR_TOKEN,
        relay_base_url="https://relay.example.test",
        relay_api_key="production-relay-api-key-0001",
        public_base_url="https://custody.example.test",
        task_service_account="tasks@fixture-project.iam.gserviceaccount.com",
        secret_pepper="production-private-answer-pepper-0001",
        relay_shared_secret="production-callback-secret-00001",
        demo_access_token=DEMO_TOKEN,
        admin_token=ADMIN_TOKEN,
    )
    return replace(base, **changes)


def _production_app():
    settings = _production_settings()
    repository = InMemoryRepository()
    reset_demo_repository(
        repository,
        settings.secret_pepper,
        occurred_at=datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc),
    )
    return create_app(
        settings=settings,
        repository=repository,
        evidence_store=InMemoryEvidenceStore(),
        analyst=FixtureCaseAnalyst(),
        relay=FixtureRelayGateway(),
        task_publisher=InlineTaskPublisher(),
        seed_demo=False,
    )


class _ReadyHttpInventory:
    mode = "http"

    def is_ready(self) -> bool:
        return True

    def search_custodian(self, tenant_id, candidates):
        raise AssertionError("health must not search inventory")

    def load_candidate(self, candidate_id, candidates):
        raise AssertionError("health must not load inventory")


def test_production_health_exposes_canonical_environment_and_auth_guards():
    settings = _production_settings(inventory_allow_legacy_health_without_environment=False)
    with TestClient(
        create_app(
            settings=settings,
            repository=InMemoryRepository(),
            evidence_store=InMemoryEvidenceStore(),
            inventory_gateway=_ReadyHttpInventory(),
            analyst=FixtureCaseAnalyst(),
            relay=FixtureRelayGateway(),
            task_publisher=InlineTaskPublisher(),
            seed_demo=False,
        )
    ) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    expected = {
        "environment": "production",
        "demo_mutation_auth_required": True,
        "admin_reset_auth_required": True,
        "staff_read_auth_required": True,
        "task_header_required": True,
        "task_oidc_required": True,
        "demo_mode": True,
        "inventory_legacy_health_compatibility": False,
    }
    assert {key: response.json().get(key) for key in expected} == expected


def _jpeg() -> bytes:
    output = BytesIO()
    Image.new("RGB", (32, 24), (34, 55, 76)).save(output, format="JPEG", quality=90)
    return output.getvalue()


def test_production_demo_analysis_requires_and_cites_uploaded_evidence():
    with TestClient(_production_app()) as client:
        blocked = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "production-evidence-gate-001"},
            headers={"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        )
        assert blocked.status_code == 409
        assert blocked.json()["error"]["code"] == "analysis_evidence_required"

        uploaded = client.post(
            f"/api/v1/staff/passports/{DEMO_CASE_ID}/evidence",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
            files={"file": ("canonical.jpg", _jpeg(), "image/jpeg")},
            data={
                "authorize_preview_for_model": "true",
                "idempotency_key": "production-evidence-upload-001",
            },
        )
        assert uploaded.status_code == 200, uploaded.text
        started = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "production-evidence-gate-001"},
            headers={"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        )
        assert started.status_code == 200, started.text
        events = client.get(
            f"/api/v1/passports/{DEMO_CASE_ID}/events",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        ).json()["items"]

    ready = next(event for event in events if event["type"] == "EVIDENCE_PACKET_READY")
    assert len(ready["evidence_refs"]) == 2
    assert all(reference.startswith("evidence://evd-") for reference in ready["evidence_refs"])
    assert all("fixture://" not in reference for reference in ready["evidence_refs"])


def test_demo_reset_excludes_prior_epoch_evidence_from_analysis_and_vertex_selection():
    app = _production_app()
    with TestClient(app) as client:
        first_snapshot = client.get(
            f"/api/v1/passports/{DEMO_CASE_ID}",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        ).json()
        first_upload = client.post(
            f"/api/v1/staff/passports/{DEMO_CASE_ID}/evidence",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
            files={"file": ("old.jpg", _jpeg(), "image/jpeg")},
            data={
                "authorize_preview_for_model": "true",
                "idempotency_key": "pre-reset-evidence-upload-001",
            },
        )
        assert first_upload.status_code == 200, first_upload.text

        reset = client.post(
            "/api/v1/demo/reset",
            headers={"X-Found-Roll-Admin-Token": ADMIN_TOKEN},
        )
        assert reset.status_code == 200, reset.text
        second_snapshot = client.get(
            f"/api/v1/passports/{DEMO_CASE_ID}",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        ).json()
        assert second_snapshot["case"]["workflow_epoch"] != first_snapshot["case"]["workflow_epoch"]

        second_upload = client.post(
            f"/api/v1/staff/passports/{DEMO_CASE_ID}/evidence",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
            files={"file": ("current.jpg", _jpeg(), "image/jpeg")},
            data={
                "authorize_preview_for_model": "true",
                "idempotency_key": "post-reset-evidence-upload-001",
            },
        )
        assert second_upload.status_code == 200, second_upload.text
        current_pair = second_upload.json()
        assert current_pair["active_for_analysis"] is True

        started = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "post-reset-analysis-001"},
            headers={"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        )
        assert started.status_code == 200, started.text
        events = client.get(
            f"/api/v1/passports/{DEMO_CASE_ID}/events",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        ).json()["items"]
        listing = client.get(
            f"/api/v1/staff/passports/{DEMO_CASE_ID}/evidence",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        ).json()

    evidence_ready = next(event for event in events if event["type"] == "EVIDENCE_PACKET_READY")
    expected_refs = sorted(
        [
            f"evidence://{current_pair['original']['id']}?sha256={current_pair['original']['sha256']}",
            f"evidence://{current_pair['preview']['id']}?sha256={current_pair['preview']['sha256']}",
        ]
    )
    assert evidence_ready["evidence_refs"] == expected_refs
    assert len(listing["items"]) == 4
    assert sorted(listing["active_pair_ids"]) == sorted(
        [current_pair["original"]["id"], current_pair["preview"]["id"]]
    )
    selected = app.state.evidence_store.list_model_authorized(
        DEMO_CASE_ID,
        second_snapshot["case"]["workflow_epoch"],
    )
    assert [record.id for record in selected] == [current_pair["preview"]["id"]]


def test_authenticated_intake_actor_is_derived_when_the_client_omits_it():
    settings = Settings(staff_actor_id="staff.configured-operator")
    app = create_app(settings=settings)
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/intakes",
            headers={"X-Found-Roll-Staff-Token": settings.evidence_staff_token},
            json={
                "safety_result": "ORDINARY_ITEM",
                "category": "camera_pouch",
                "risk_tier": "VALUABLE",
                "assigned_tenant": "northport-air",
                "current_holder": "Northport Air property desk",
                "public_description": "Black camera pouch with a repaired seam.",
                "found_at": "2026-08-29T10:00:00Z",
                "found_zone": "Terminal C",
                "report_route": ["Northport Air"],
                "idempotency_key": "server-derived-actor-001",
            },
        )
        assert created.status_code == 200, created.text
        case_id = created.json()["case"]["id"]
        events = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]

    assert events[0]["actor"] == "staff.configured-operator"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/v1/intakes",
            {
                "safety_result": "SUSPICIOUS_OR_DANGEROUS",
                "category": "suspicious_package",
                "risk_tier": "DANGEROUS",
                "assigned_tenant": "northport-air",
                "current_holder": "Unmoved",
                "public_description": "Synthetic suspicious package fixture.",
                "found_at": "2026-08-29T10:00:00Z",
                "found_zone": "Terminal C",
                "report_route": ["Terminal C"],
                "actor": "staff.northport",
                "idempotency_key": "auth-intake-001",
            },
        ),
        (
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            {"expected_version": 1, "idempotency_key": "auth-analysis-001"},
        ),
        (
            f"/api/v1/passports/{DEMO_CASE_ID}/claim-links",
            {"expected_version": 1, "idempotency_key": "auth-claim-link-001"},
        ),
        (f"/api/v1/passports/{DEMO_CASE_ID}/reservations", {}),
        (f"/api/v1/passports/{DEMO_CASE_ID}/tokens", {}),
        (f"/api/v1/passports/{DEMO_CASE_ID}/token-attestations", {}),
        (f"/api/v1/passports/{DEMO_CASE_ID}/close", {}),
    ],
)
def test_production_custody_mutations_require_demo_token(path, body):
    with TestClient(_production_app()) as client:
        staff_read = client.get(
            f"/api/v1/passports/{DEMO_CASE_ID}",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        )
        denied = client.post(path, json=body)
        allowed_headers = {"X-Found-Roll-Demo-Token": DEMO_TOKEN}
        if path == "/api/v1/intakes" or path.endswith("/claim-links"):
            allowed_headers["X-Found-Roll-Staff-Token"] = STAFF_TOKEN
        allowed_boundary = client.post(
            path,
            json=body,
            headers=allowed_headers,
        )

    assert staff_read.status_code == 200
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "demo_auth_required"
    assert allowed_boundary.status_code != 403


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/passports",
        f"/api/v1/passports/{DEMO_CASE_ID}",
        f"/api/v1/passports/{DEMO_CASE_ID}/events",
        f"/api/v1/passports/{DEMO_CASE_ID}/candidates",
        f"/api/v1/passports/{DEMO_CASE_ID}/manifest",
        "/api/v1/demo/snapshot",
    ],
)
def test_production_staff_read_surfaces_reject_enumeration_and_operator_credentials(path):
    operator_only_headers = [
        {},
        {"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        {"X-Found-Roll-Admin-Token": ADMIN_TOKEN},
        {
            "X-Found-Roll-Demo-Token": DEMO_TOKEN,
            "X-Found-Roll-Admin-Token": ADMIN_TOKEN,
        },
    ]
    with TestClient(_production_app()) as client:
        denied = [client.get(path, headers=headers) for headers in operator_only_headers]
        staff = client.get(path, headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN})

    assert all(response.status_code == 403 for response in denied)
    assert all(response.json()["error"]["code"] == "staff_auth_required" for response in denied)
    # The initial fixture has no closed manifest yet, so authenticated access reaches
    # the domain precondition rather than returning a credential failure.
    assert staff.status_code == (409 if path.endswith("/manifest") else 200)


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/v1/intakes",
            {
                "safety_result": "SUSPICIOUS_OR_DANGEROUS",
                "category": "suspicious_package",
                "risk_tier": "DANGEROUS",
                "assigned_tenant": "northport-air",
                "current_holder": "Unmoved",
                "public_description": "Synthetic staff-bound intake.",
                "found_at": "2026-08-29T10:00:00Z",
                "found_zone": "Terminal C",
                "report_route": ["Terminal C"],
                "actor": "staff.northport",
                "idempotency_key": "staff-auth-intake-001",
            },
        ),
        (
            f"/api/v1/passports/{DEMO_CASE_ID}/claim-links",
            {"expected_version": 1, "idempotency_key": "staff-auth-claim-link-001"},
        ),
    ],
)
def test_intake_and_claim_link_issuance_require_staff_role_as_well_as_demo_access(path, body):
    with TestClient(_production_app()) as client:
        shared_demo_only = client.post(
            path,
            json=body,
            headers={"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        )

    assert shared_demo_only.status_code == 403
    assert shared_demo_only.json()["error"]["code"] == "staff_auth_required"


def test_production_claim_evidence_rejects_shared_demo_token_without_claim_link():
    body = {
        "expected_version": 1,
        "idempotency_key": "auth-private-claim-001",
        "answer": "synthetic-private-answer",
    }
    with TestClient(_production_app()) as client:
        denied = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/claim-evidence",
            json=body,
            headers={"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        )

    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "claim_link_required"


@pytest.mark.parametrize(
    ("path", "body", "header", "token", "error_code"),
    [
        (
            f"/api/v1/passports/{DEMO_CASE_ID}/identity-attestations",
            {
                "expected_version": 1,
                "idempotency_key": "role-identity-001",
                "staff_user_id": "staff.northport",
                "method": "government_id_visual_check",
            },
            "X-Found-Roll-Staff-Token",
            STAFF_TOKEN,
            "staff_auth_required",
        ),
        (
            f"/api/v1/passports/{DEMO_CASE_ID}/approvals",
            {
                "expected_version": 1,
                "idempotency_key": "role-approval-001",
                "supervisor_user_id": "supervisor.northport",
                "approved": True,
                "reason": "Synthetic role-bound approval test.",
            },
            "X-Found-Roll-Supervisor-Token",
            SUPERVISOR_TOKEN,
            "supervisor_auth_required",
        ),
        (
            f"/api/v1/passports/{DEMO_CASE_ID}/releases",
            {
                "expected_version": 1,
                "idempotency_key": "role-release-001",
                "staff_user_id": "staff.northport",
            },
            "X-Found-Roll-Staff-Token",
            STAFF_TOKEN,
            "staff_auth_required",
        ),
    ],
)
def test_production_human_actions_require_role_specific_credentials(
    path, body, header, token, error_code
):
    with TestClient(_production_app()) as client:
        missing = client.post(path, json=body)
        shared_demo = client.post(
            path,
            json=body,
            headers={"X-Found-Roll-Demo-Token": DEMO_TOKEN},
        )
        role_authenticated = client.post(path, json=body, headers={header: token})

    assert missing.status_code == 403
    assert missing.json()["error"]["code"] == error_code
    assert shared_demo.status_code == 403
    assert shared_demo.json()["error"]["code"] == error_code
    assert role_authenticated.status_code != 403


def test_production_reset_requires_admin_token_and_preserves_unrelated_cases():
    app = _production_app()
    repository = app.state.custody_service.repository
    unrelated = CaseRecord(
        id="FR-UNRELATED-0001",
        state=CustodyState.RECEIVED,
        version=0,
        category="umbrella",
        risk_tier=RiskTier.ORDINARY,
        assigned_tenant="grand-hall",
        current_holder="Grand Hall desk",
        public_description="Synthetic unrelated umbrella retained across demo reset.",
        found_at=datetime(2026, 8, 29, 8, 0, tzinfo=timezone.utc),
        found_zone="Lobby",
        report_route=["Grand Hall"],
    )
    repository.create_case(
        unrelated,
        [],
        actor="fixture:test",
        reason="Create an unrelated synthetic case for reset-scope verification.",
        idempotency_key="unrelated:create:001",
        occurred_at=datetime(2026, 8, 29, 8, 1, tzinfo=timezone.utc),
    )

    with TestClient(app) as client:
        denied = client.post("/api/v1/demo/reset")
        wrong = client.post(
            "/api/v1/demo/reset",
            headers={"X-Found-Roll-Admin-Token": "incorrect-admin-token-value"},
        )
        reset = client.post(
            "/api/v1/demo/reset",
            headers={"X-Found-Roll-Admin-Token": ADMIN_TOKEN},
        )
        unrelated_after = client.get(
            f"/api/v1/passports/{unrelated.id}",
            headers={"X-Found-Roll-Staff-Token": STAFF_TOKEN},
        )

    assert denied.status_code == 403
    assert wrong.status_code == 403
    assert reset.status_code == 200
    assert reset.json()["case"]["id"] == DEMO_CASE_ID
    assert reset.json()["case"]["version"] == 1
    assert unrelated_after.status_code == 200


def test_demo_reset_stamps_the_new_epoch_from_the_service_clock():
    reset_at = datetime(2026, 8, 31, 12, 34, 56, 789012, tzinfo=timezone.utc)
    app = _production_app()
    service = app.state.custody_service
    service.clock = lambda: reset_at

    with TestClient(app) as client:
        reset = client.post(
            "/api/v1/demo/reset",
            headers={"X-Found-Roll-Admin-Token": ADMIN_TOKEN},
        )

    assert reset.status_code == 200, reset.text
    case = service.repository.get_case(DEMO_CASE_ID)
    events = service.repository.list_events(DEMO_CASE_ID)
    assert case.created_at == reset_at
    assert case.updated_at == reset_at
    assert len(events) == 1
    assert events[0].occurred_at == reset_at


def test_production_synthetic_reset_requires_scoped_namespace():
    unsafe = _production_settings(firestore_namespace="foundRoll")
    with pytest.raises(ValueError, match="synthetic_demo"):
        unsafe.validate()


def test_hosted_auth_configuration_fails_closed_on_typos_defaults_or_reuse():
    with pytest.raises(ValueError, match="FOUND_ROLL_ENV"):
        replace(_production_settings(), environment="prodution").validate()
    with pytest.raises(ValueError, match="DEMO_ACCESS_TOKEN"):
        replace(
            _production_settings(),
            demo_access_token="found-roll-local-demo-token",
        ).validate()
    with pytest.raises(ValueError, match="must be distinct"):
        replace(_production_settings(), admin_token=DEMO_TOKEN).validate()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("secret_pepper", "replace-with-a-long-production-secret"),
        ("demo_access_token", "replace-with-an-operator-demo-token"),
        ("admin_token", "replace-with-an-admin-token"),
        ("evidence_staff_token", "replace-with-a-staff-token"),
        ("supervisor_token", "replace-with-a-supervisor-token"),
        ("relay_api_key", "replace-with-the-relay-key"),
        ("relay_shared_secret", "replace-with-the-callback-secret"),
        ("google_cloud_project", "replace-with-your-project-id"),
        ("evidence_bucket", "replace-with-private-bucket-name"),
        ("task_service_account", "replace-with-task-service-account-email"),
    ],
)
def test_production_rejects_example_placeholders(field, value):
    with pytest.raises(ValueError, match="placeholder"):
        replace(_production_settings(), **{field: value}).validate()


def test_production_relay_and_public_urls_require_https():
    with pytest.raises(ValueError, match="RELAY_BASE_URL.*HTTPS"):
        replace(_production_settings(), relay_base_url="http://relay.example.test").validate()
    with pytest.raises(ValueError, match="PUBLIC_BASE_URL.*HTTPS"):
        replace(_production_settings(), public_base_url="http://custody.example.test").validate()


class _FakeSnapshot:
    def __init__(self, reference, data):
        self.reference = reference
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return self._data


class _FakeDocument:
    def __init__(self, client, path):
        self.client = client
        self.path = path

    def get(self, transaction=None):
        return _FakeSnapshot(self, self.client.rows.get(self.path))

    def collection(self, suffix):
        return _FakeCollection(self.client, f"{self.path}/{suffix}")


class _FakeQuery:
    def __init__(self, collection, field, value):
        self.collection = collection
        self.field = field
        self.value = value

    def stream(self, transaction=None):
        rows = []
        for row in self.collection.stream(transaction=transaction):
            value = row.to_dict()
            for part in self.field.split("."):
                value = value.get(part) if isinstance(value, dict) else None
            if value == self.value:
                rows.append(row)
        return rows


class _FakeCollection:
    def __init__(self, client, path):
        self.client = client
        self.path = path

    def document(self, document_id):
        return _FakeDocument(self.client, f"{self.path}/{document_id}")

    def where(self, field, _operator, value):
        return _FakeQuery(self, field, value)

    def stream(self, transaction=None):
        prefix = self.path + "/"
        return [
            _FakeSnapshot(_FakeDocument(self.client, path), data)
            for path, data in sorted(self.client.rows.items())
            if path.startswith(prefix) and "/" not in path[len(prefix) :]
        ]


class _FakeTransaction:
    def __init__(self, client):
        self.client = client

    def set(self, reference, data):
        self.client.rows[reference.path] = data

    def delete(self, reference):
        self.client.rows.pop(reference.path, None)


class _FakeFirestoreClient:
    def __init__(self, rows):
        self.rows = rows

    def collection(self, suffix):
        return _FakeCollection(self, suffix)

    def transaction(self):
        return _FakeTransaction(self)


class _FakeFirestoreModule:
    @staticmethod
    def transactional(function):
        return function


class _ExhaustedFirestoreModule:
    @staticmethod
    def transactional(_function):
        def exhausted(_transaction):
            from google.api_core.exceptions import Aborted

            try:
                raise Aborted("synthetic Firestore contention")
            except Aborted as exc:
                raise ValueError("Transaction failed after bounded retries.") from exc

        return exhausted


def _contention_repository(case: CaseRecord) -> FirestoreRepository:
    prefix = "foundRoll"
    repository = FirestoreRepository.__new__(FirestoreRepository)
    repository._prefix = prefix
    repository._client = _FakeFirestoreClient(
        {f"{prefix}_passports/{case.id}": case.model_dump(mode="python")}
    )
    repository._firestore = _ExhaustedFirestoreModule()
    return repository


def _evidence_ready_spec(case: CaseRecord) -> MutationSpec:
    return MutationSpec(
        case_id=case.id,
        expected_version=case.version,
        target_state=CustodyState.EVIDENCE_READY,
        event_type="EVIDENCE_PACKET_READY",
        actor="service:intake",
        reason="Synthetic transaction-contention fixture.",
        idempotency_key=f"case:{case.id}:analysis:contention:evidence-ready",
        fingerprint="contention-fingerprint",
        occurred_at=datetime(2026, 8, 30, 14, 0, tzinfo=timezone.utc),
    )


def test_firestore_retry_exhaustion_maps_an_advanced_case_to_stale_version():
    initial = fixture_case().model_copy(update={"version": 1})
    advanced = initial.model_copy(
        update={"state": CustodyState.EVIDENCE_READY, "version": initial.version + 1}
    )
    repository = _contention_repository(advanced)

    with pytest.raises(Conflict) as error:
        repository.apply_mutation(_evidence_ready_spec(initial))

    assert error.value.code == "stale_case_version"
    assert set(repository._client.rows) == {f"foundRoll_passports/{initial.id}"}


def test_firestore_retry_exhaustion_remains_retryable_without_a_winner():
    initial = fixture_case().model_copy(update={"version": 1})
    repository = _contention_repository(initial)

    with pytest.raises(Unavailable) as error:
        repository.apply_mutation(_evidence_ready_spec(initial))

    assert error.value.code == "firestore_transaction_contention"


def test_firestore_fixture_reset_deletes_only_exact_synthetic_scope():
    prefix = "foundRoll_synthetic_demo"
    rows = {
        f"{prefix}_passports/{DEMO_CASE_ID}": {"id": DEMO_CASE_ID},
        f"{prefix}_passports/{DEMO_CASE_ID}/events/evt-old": {"case_id": DEMO_CASE_ID},
        f"{prefix}_outbox/out-old": {"case_id": DEMO_CASE_ID},
        f"{prefix}_analysisExecutionClaims/out-old": {"case_id": DEMO_CASE_ID},
        f"{prefix}_handoffs/handoff-old": {"case_id": DEMO_CASE_ID},
        f"{prefix}_tokens/token-old": {"case_id": DEMO_CASE_ID},
        f"{prefix}_idempotency/idem-old": {"response": {"case_id": DEMO_CASE_ID}},
        f"{prefix}_passports/FR-UNRELATED-0001": {"id": "FR-UNRELATED-0001"},
        f"{prefix}_outbox/out-unrelated": {"case_id": "FR-UNRELATED-0001"},
        f"{prefix}_inventoryItems/UNRELATED-ITEM": {"id": "UNRELATED-ITEM"},
    }
    repository = FirestoreRepository.__new__(FirestoreRepository)
    repository._prefix = prefix
    repository._client = _FakeFirestoreClient(rows)
    repository._firestore = _FakeFirestoreModule()

    reset_demo_repository(
        repository,
        "test-synthetic-pepper",
        occurred_at=datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc),
    )

    assert rows[f"{prefix}_passports/{DEMO_CASE_ID}"]["version"] == 1
    demo_events = [
        path
        for path in rows
        if path.startswith(f"{prefix}_passports/{DEMO_CASE_ID}/events/")
    ]
    assert len(demo_events) == 1
    assert f"{prefix}_outbox/out-old" not in rows
    assert f"{prefix}_analysisExecutionClaims/out-old" not in rows
    assert f"{prefix}_handoffs/handoff-old" not in rows
    assert f"{prefix}_tokens/token-old" not in rows
    assert f"{prefix}_idempotency/idem-old" not in rows
    assert f"{prefix}_passports/FR-UNRELATED-0001" in rows
    assert f"{prefix}_outbox/out-unrelated" in rows
    assert f"{prefix}_inventoryItems/UNRELATED-ITEM" in rows


def test_firestore_execution_claim_matches_memory_single_flight_and_token_guards():
    prefix = "foundRoll"
    claimed_at = datetime(2026, 8, 30, 14, 0, tzinfo=timezone.utc)
    case = fixture_case().model_copy(
        update={"state": CustodyState.ANALYZING, "version": 2}
    )
    outbox = make_outbox(
        OutboxKind.ANALYZE_CASE,
        fixture_case(),
        created_at=claimed_at,
    ).model_copy(update={"status": OutboxStatus.DISPATCHED})
    rows = {
        f"{prefix}_passports/{case.id}": case.model_dump(mode="python"),
        f"{prefix}_outbox/{outbox.id}": outbox.model_dump(mode="python"),
    }
    repository = FirestoreRepository.__new__(FirestoreRepository)
    repository._prefix = prefix
    repository._client = _FakeFirestoreClient(rows)
    repository._firestore = _FakeFirestoreModule()

    winner = repository.claim_outbox_execution(
        outbox.id,
        claim_token="firestore-winner-token",
        claimed_at=claimed_at,
        lease_expires_at=claimed_at + timedelta(seconds=5),
    )
    duplicate = repository.claim_outbox_execution(
        outbox.id,
        claim_token="firestore-duplicate-token",
        claimed_at=claimed_at + timedelta(seconds=1),
        lease_expires_at=claimed_at + timedelta(seconds=6),
    )
    replacement = repository.claim_outbox_execution(
        outbox.id,
        claim_token="firestore-recovery-token",
        claimed_at=claimed_at + timedelta(seconds=6),
        lease_expires_at=claimed_at + timedelta(seconds=11),
    )

    assert winner.disposition == ExecutionClaimDisposition.ACQUIRED
    assert duplicate.disposition == ExecutionClaimDisposition.IN_PROGRESS
    assert duplicate.claim.token_hash == winner.claim.token_hash
    assert replacement.disposition == ExecutionClaimDisposition.STALE_RECOVERY
    assert replacement.claim.recovery_required is True
    assert replacement.claim.token_hash != winner.claim.token_hash

    stale_result = MutationSpec(
        case_id=case.id,
        expected_version=case.version,
        target_state=CustodyState.CANDIDATES_READY,
        event_type="CANDIDATE_PACKET_PROPOSED",
        actor="agent:case-analyst",
        reason="Synthetic stale-winner result.",
        idempotency_key=f"outbox:{outbox.id}:candidates-ready",
        fingerprint="stale-winner-fingerprint",
        occurred_at=claimed_at + timedelta(seconds=7),
    )
    with pytest.raises(Conflict) as stale_write:
        repository.apply_mutation(
            stale_result,
            execution_claim_outbox_id=outbox.id,
            execution_claim_token="firestore-winner-token",
        )
    assert stale_write.value.code == "outbox_execution_claim_lost"

    with pytest.raises(Conflict) as losing_terminal:
        repository.mark_outbox_execution(
            outbox.id,
            OutboxStatus.FAILED,
            claim_token="firestore-duplicate-token",
            completed_at=claimed_at + timedelta(seconds=8),
            failure_stage=OutboxFailureStage.EXECUTE,
            failure_code="analyst_unavailable",
        )
    assert losing_terminal.value.code == "outbox_execution_claim_lost"
    terminal = repository.mark_outbox_execution(
        outbox.id,
        OutboxStatus.FAILED,
        claim_token="firestore-recovery-token",
        completed_at=claimed_at + timedelta(seconds=9),
        failure_stage=OutboxFailureStage.EXECUTE,
        failure_code="analyst_unavailable",
    )
    assert terminal.status == OutboxStatus.FAILED
    stored_claim = rows[f"{prefix}_analysisExecutionClaims/{outbox.id}"]
    assert stored_claim["terminal_status"] == OutboxStatus.FAILED


class _FailOncePublisher:
    def __init__(self) -> None:
        self.calls = 0

    def publish(self, outbox):
        self.calls += 1
        if self.calls == 1:
            raise Unavailable(
                "cloud_tasks_unavailable",
                "Synthetic enqueue failure containing private-debug-marker.",
            )
        return {"queued": True, "mode": "cloud_tasks", "task_name": outbox.task_name}


class _QueuedPublisher:
    def __init__(self) -> None:
        self.calls = 0

    def publish(self, outbox):
        self.calls += 1
        return {"queued": True, "mode": "cloud_tasks", "task_name": outbox.task_name}


class _FailOnceAnalysisRequestRepository(InMemoryRepository):
    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    def apply_mutation(self, spec, **kwargs):
        if spec.event_type == "ANALYSIS_REQUESTED" and not self.failed:
            self.failed = True
            raise RuntimeError("synthetic crash between analysis mutations")
        return super().apply_mutation(spec, **kwargs)


class _BarrierAnalysisRepository(InMemoryRepository):
    def __init__(self) -> None:
        super().__init__()
        self.analysis_barrier = Barrier(2)

    def apply_mutation(self, spec, **kwargs):
        if spec.event_type == "EVIDENCE_PACKET_READY":
            self.analysis_barrier.wait(timeout=5)
        return super().apply_mutation(spec, **kwargs)


def test_cloud_task_retry_receipt_keeps_the_publisher_contract_without_payload():
    settings = Settings(tasks_mode="cloud")
    publisher = _QueuedPublisher()
    app = create_app(settings=settings, task_publisher=publisher)
    with TestClient(app) as client:
        first = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "cloud-receipt-retry-001"},
        )
        retry = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "cloud-receipt-retry-001"},
        )
        altered = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 0, "idempotency_key": "cloud-receipt-retry-001"},
        )

    assert first.status_code == 200
    assert retry.status_code == 200
    assert first.json()["task"]["mode"] == "cloud_tasks"
    assert retry.json()["task"]["mode"] == "cloud_tasks"
    assert retry.json()["task"]["queued"] is True
    assert "payload" not in retry.json()["task"]
    assert altered.status_code == 409
    assert altered.json()["error"]["code"] == "stale_case_version"
    assert publisher.calls == 1


def test_exact_analysis_retry_recovers_the_intermediate_evidence_ready_state():
    settings = Settings(tasks_mode="cloud")
    publisher = _QueuedPublisher()
    repository = _FailOnceAnalysisRequestRepository()
    app = create_app(settings=settings, repository=repository, task_publisher=publisher)
    with TestClient(app) as client:
        interrupted_response = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "analysis-crash-retry-001"},
        )
        interrupted = repository.get_case(DEMO_CASE_ID)
        unrelated = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "analysis-crash-other-001"},
        )
        recovered = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "analysis-crash-retry-001"},
        )

    assert interrupted_response.status_code == 500
    assert interrupted.state == CustodyState.EVIDENCE_READY
    assert interrupted.version == 2
    assert unrelated.status_code == 409, unrelated.text
    assert unrelated.json()["error"]["code"] == "stale_case_version"
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["case"]["state"] == "ANALYZING"
    assert publisher.calls == 1


def test_new_analysis_command_with_stale_version_cannot_join_inflight_work():
    settings = Settings(tasks_mode="cloud")
    publisher = _QueuedPublisher()
    repository = _BarrierAnalysisRepository()
    app = create_app(
        settings=settings,
        repository=repository,
        task_publisher=publisher,
    )
    with TestClient(app) as client:
        def contend(key):
            return client.post(
                f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
                json={"expected_version": 1, "idempotency_key": key},
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(
                pool.map(contend, ("contention-a-001", "contention-b-001"))
            )
        events = client.get(f"/api/v1/passports/{DEMO_CASE_ID}/events").json()["items"]

    winner = next(response for response in responses if response.status_code == 200)
    loser = next(response for response in responses if response.status_code == 409)
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert winner.json()["task"]["queued"] is True
    assert loser.status_code == 409, loser.text
    assert loser.json()["error"]["code"] == "stale_case_version"
    assert publisher.calls == 1
    assert [event["type"] for event in events].count("EVIDENCE_PACKET_READY") == 1
    assert [event["type"] for event in events].count("ANALYSIS_REQUESTED") == 1


def test_failed_publication_can_be_reconciled_once_with_admin_auth(settings):
    publisher = _FailOncePublisher()
    app = create_app(settings=settings, task_publisher=publisher)
    with TestClient(app) as client:
        started = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "publish-failure-001"},
        )
        snapshot = client.get(f"/api/v1/passports/{DEMO_CASE_ID}").json()
        denied = client.post(
            "/api/v1/admin/demo/outbox/reconcile",
            json={"max_items": 10},
        )
        recovered = client.post(
            "/api/v1/admin/demo/outbox/reconcile",
            json={"max_items": 10},
            headers={"X-Found-Roll-Admin-Token": settings.admin_token},
        )
        replay = client.post(
            "/api/v1/admin/demo/outbox/reconcile",
            json={"max_items": 10},
            headers={"X-Found-Roll-Admin-Token": settings.admin_token},
        )

    assert started.status_code == 503
    assert "private-debug-marker" not in started.text
    assert snapshot["case"]["state"] == "ANALYZING"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "PUBLISH"
    assert denied.status_code == 403
    assert recovered.status_code == 200
    assert recovered.json()["recovered"] == 1
    assert recovered.json()["items"][0]["status"] == "DISPATCHED"
    assert replay.json()["eligible"] == 0
    assert publisher.calls == 2


def test_pending_publication_can_be_reconciled(settings):
    app = create_app(settings=settings)
    with TestClient(app) as client:
        started = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "publish-pending-001"},
        )
        assert started.status_code == 200
        assert started.json()["outbox"]["status"] == "PENDING"

        queued = _QueuedPublisher()
        app.state.custody_service.task_publisher = queued
        recovered = client.post(
            "/api/v1/admin/demo/outbox/reconcile",
            json={"max_items": 1},
            headers={"X-Found-Roll-Admin-Token": settings.admin_token},
        )

    assert recovered.status_code == 200
    assert recovered.json()["eligible"] == 1
    assert recovered.json()["recovered"] == 1
    assert queued.calls == 1


def test_cloud_tasks_duplicate_name_is_an_idempotent_enqueue_success():
    class AlreadyExists(Exception):
        pass

    class Tasks:
        class HttpMethod:
            POST = "POST"

    class Client:
        @staticmethod
        def queue_path(project, location, queue):
            return f"projects/{project}/locations/{location}/queues/{queue}"

        @staticmethod
        def task_path(project, location, queue, task):
            return f"projects/{project}/locations/{location}/queues/{queue}/tasks/{task}"

        @staticmethod
        def create_task(*, parent, task):
            raise AlreadyExists("deterministic task already exists")

    settings = Settings(google_cloud_project="fixture-project")
    publisher = CloudTasksPublisher.__new__(CloudTasksPublisher)
    publisher._tasks = Tasks
    publisher._client = Client()
    publisher._settings = settings
    publisher._already_exists = AlreadyExists
    outbox = make_outbox(
        OutboxKind.ANALYZE_CASE,
        fixture_case().model_copy(update={"version": 2}),
        created_at=datetime(2026, 8, 29, 9, 5, tzinfo=timezone.utc),
    )

    result = publisher.publish(outbox)

    assert result["queued"] is True
    assert result["idempotent_replay"] is True
    assert result["task_name"].endswith(f"/tasks/{outbox.task_name}")


def test_cloud_tasks_replay_uses_a_distinct_oidc_task_with_the_same_opaque_scope():
    class AlreadyExists(Exception):
        pass

    class Tasks:
        class HttpMethod:
            POST = "POST"

    class Client:
        def __init__(self):
            self.created = []

        @staticmethod
        def queue_path(project, location, queue):
            return f"projects/{project}/locations/{location}/queues/{queue}"

        @staticmethod
        def task_path(project, location, queue, task):
            return f"projects/{project}/locations/{location}/queues/{queue}/tasks/{task}"

        def create_task(self, *, parent, task):
            self.created.append((parent, task))
            return SimpleNamespace(name=task["name"])

    settings = Settings(
        google_cloud_project="fixture-project",
        public_base_url="https://custody.example.test",
        task_service_account="tasks@fixture-project.iam.gserviceaccount.com",
    )
    publisher = CloudTasksPublisher.__new__(CloudTasksPublisher)
    publisher._tasks = Tasks
    publisher._client = Client()
    publisher._settings = settings
    publisher._already_exists = AlreadyExists
    outbox = make_outbox(
        OutboxKind.RELEASE_RELAY,
        fixture_case().model_copy(update={"version": 16}),
        created_at=datetime(2026, 8, 29, 9, 5, tzinfo=timezone.utc),
    )

    original = publisher.publish(outbox)
    replay = publisher.publish_replay(outbox, "release-replay-contract-001")

    assert original["task_name"] != replay["task_name"]
    assert replay["task_name"].rsplit("/", 1)[1].startswith("fr-replay-")
    original_request = publisher._client.created[0][1]["http_request"]
    replay_request = publisher._client.created[1][1]["http_request"]
    assert json.loads(replay_request["body"]) == json.loads(original_request["body"])
    assert replay_request["oidc_token"] == {
        "service_account_email": settings.task_service_account,
        "audience": settings.public_base_url,
    }


def test_delayed_publish_ack_cannot_regress_completed_outbox(settings):
    app = create_app(settings=settings)
    with TestClient(app) as client:
        started = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "monotonic-outbox-001"},
        ).json()
        completed = client.post("/tasks/outbox", json=started["task"]["payload"])
        assert completed.status_code == 200

    repository = app.state.custody_service.repository
    outbox_id = started["outbox"]["id"]
    before = repository.get_outbox(outbox_id)
    delayed_ack = repository.mark_outbox(outbox_id, OutboxStatus.DISPATCHED)

    assert before.status == OutboxStatus.COMPLETE
    assert delayed_ack.status == OutboxStatus.COMPLETE
    assert delayed_ack.attempt == before.attempt


def test_demo_reset_uses_new_task_identity_for_cloud_tasks_retention(settings):
    app = create_app(settings=settings)
    with TestClient(app) as client:
        first = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "epoch-first-001"},
        ).json()
        reset = client.post("/api/v1/demo/reset")
        assert reset.status_code == 200
        second = client.post(
            f"/api/v1/passports/{DEMO_CASE_ID}/analysis-jobs",
            json={"expected_version": 1, "idempotency_key": "epoch-second-001"},
        ).json()

    assert first["outbox"]["id"] != second["outbox"]["id"]
    assert first["outbox"]["task_name"] != second["outbox"]["task_name"]
