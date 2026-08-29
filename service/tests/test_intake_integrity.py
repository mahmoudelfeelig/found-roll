from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

from PIL import Image
import pytest

from conftest import STAFF_HEADERS
from app.domain import CaseRecord, CustodyState, RiskTier
from app.errors import Conflict
from app.repository import FirestoreRepository


def _intake_payload() -> dict:
    return {
        "safety_result": "ORDINARY_ITEM",
        "category": "camera_pouch",
        "risk_tier": "VALUABLE",
        "assigned_tenant": "northport-air",
        "current_holder": "Northport Air property desk",
        "public_description": "Imported black camera pouch with a worn zipper pull.",
        "found_at": "2026-08-29T10:00:00Z",
        "found_zone": "Terminal C",
        "report_route": ["Northport Air"],
        "actor": "staff.northport",
        "idempotency_key": "import-intake-integrity-001",
    }


def _jpeg() -> bytes:
    output = BytesIO()
    Image.new("RGB", (32, 24), (35, 61, 87)).save(output, format="JPEG", quality=90)
    return output.getvalue()


def test_intake_exact_retry_conflict_retry_and_no_version_zero_orphan(client):
    before_ids = {
        item["id"] for item in client.get("/api/v1/passports").json()["items"]
    }
    payload = _intake_payload()

    created = client.post("/api/v1/intakes", json=payload, headers=STAFF_HEADERS)
    retried = client.post("/api/v1/intakes", json=payload, headers=STAFF_HEADERS)

    assert created.status_code == 200, created.text
    assert retried.status_code == 200, retried.text
    assert retried.json() == created.json()
    case_id = created.json()["case"]["id"]
    assert case_id.startswith("case-")
    assert payload["idempotency_key"] not in case_id
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    candidate_listing = client.get(f"/api/v1/passports/{case_id}/candidates").json()
    assert snapshot["case"]["candidate_ids"] == []
    assert snapshot["candidates"] == []
    assert candidate_listing["items"] == []

    conflicting_payload = {**payload, "public_description": "A different imported item payload."}
    conflict = client.post(
        "/api/v1/intakes",
        json=conflicting_payload,
        headers=STAFF_HEADERS,
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"

    imported = [
        item
        for item in client.get("/api/v1/passports").json()["items"]
        if item["id"] not in before_ids
    ]
    assert [item["id"] for item in imported] == [case_id]
    assert imported[0]["version"] == 1
    events = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    assert len(events) == 1
    assert events[0]["type"] == "ITEM_PASSPORT_CREATED"
    assert payload["idempotency_key"] not in events[0]["idempotency_key"]


def test_imported_case_requires_evidence_and_cites_uploaded_provenance(client):
    created = client.post(
        "/api/v1/intakes",
        json={**_intake_payload(), "idempotency_key": "import-evidence-gate-001"},
        headers=STAFF_HEADERS,
    )
    assert created.status_code == 200, created.text
    case_id = created.json()["case"]["id"]

    blocked = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "import-analysis-001"},
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "analysis_evidence_required"
    assert client.get(f"/api/v1/passports/{case_id}").json()["case"]["version"] == 1

    uploaded = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", _jpeg(), "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "import-evidence-upload-001",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    original = uploaded.json()["original"]
    preview = uploaded.json()["preview"]
    assert original["visibility"] == "STAFF_ONLY"
    assert preview["visibility"] == "MODEL_AUTHORIZED"
    assert preview["provenance"]["origin"] == "DERIVED"
    assert preview["provenance"]["source_evidence_id"] == original["id"]

    started = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "import-analysis-001"},
    )
    assert started.status_code == 200, started.text
    events = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    evidence_ready = next(event for event in events if event["type"] == "EVIDENCE_PACKET_READY")
    assert evidence_ready["evidence_refs"] == sorted(
        [
            f"evidence://{original['id']}?sha256={original['sha256']}",
            f"evidence://{preview['id']}?sha256={preview['sha256']}",
        ]
    )
    assert all("fixture://" not in reference for reference in evidence_ready["evidence_refs"])


def test_imported_case_rejects_staff_only_preview(client):
    created = client.post(
        "/api/v1/intakes",
        json={**_intake_payload(), "idempotency_key": "import-preview-gate-001"},
        headers=STAFF_HEADERS,
    )
    assert created.status_code == 200, created.text
    case_id = created.json()["case"]["id"]
    uploaded = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", _jpeg(), "image/jpeg")},
        data={
            "authorize_preview_for_model": "false",
            "idempotency_key": "import-staff-only-upload-001",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["preview"]["visibility"] == "STAFF_ONLY"
    assert uploaded.json()["active_for_analysis"] is False

    blocked = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "staff-only-analysis-001"},
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "model_authorized_preview_required"
    assert client.get(f"/api/v1/passports/{case_id}").json()["case"]["version"] == 1


class _Snapshot:
    def __init__(self, reference, data):
        self.reference = reference
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return self._data


class _Document:
    def __init__(self, client, path):
        self.client = client
        self.path = path

    def get(self, transaction=None):
        return _Snapshot(self, self.client.rows.get(self.path))

    def collection(self, suffix):
        return _Collection(self.client, f"{self.path}/{suffix}")


class _Collection:
    def __init__(self, client, path):
        self.client = client
        self.path = path

    def document(self, document_id):
        return _Document(self.client, f"{self.path}/{document_id}")


class _Transaction:
    def __init__(self, client):
        self.client = client

    def create(self, reference, data):
        if reference.path in self.client.rows:
            raise AssertionError(f"document already exists: {reference.path}")
        self.client.rows[reference.path] = data

    def set(self, reference, data):
        self.client.rows[reference.path] = data


class _Client:
    def __init__(self):
        self.rows = {}

    def collection(self, suffix):
        return _Collection(self, suffix)

    def transaction(self):
        return _Transaction(self)


class _FirestoreModule:
    @staticmethod
    def transactional(function):
        return function


def test_firestore_intake_commit_replays_and_never_persists_a_base_case():
    repository = FirestoreRepository.__new__(FirestoreRepository)
    repository._prefix = "foundRoll_test"
    repository._client = _Client()
    repository._firestore = _FirestoreModule()
    occurred_at = datetime(2026, 8, 29, 10, 0, tzinfo=timezone.utc)
    case = CaseRecord(
        id="case-opaque-stable-id",
        state=CustodyState.RECEIVED,
        version=0,
        category="camera_pouch",
        risk_tier=RiskTier.VALUABLE,
        assigned_tenant="northport-air",
        current_holder="Northport Air property desk",
        public_description="Imported black camera pouch with a worn zipper pull.",
        found_at=occurred_at,
        found_zone="Terminal C",
        report_route=["Northport Air"],
        created_at=occurred_at,
        updated_at=occurred_at,
    )
    kwargs = {
        "actor": "staff.northport",
        "reason": "Create a tested imported Item Passport.",
        "idempotency_key": "intake:opaque-digest",
        "occurred_at": occurred_at,
        "fingerprint": "a" * 64,
    }

    created = repository.create_case(case, [], **kwargs)
    retried = repository.create_case(case, [], **kwargs)

    assert created.duplicate is False
    assert retried.duplicate is True
    assert retried.receipt == created.receipt
    stored = repository._client.rows["foundRoll_test_passports/case-opaque-stable-id"]
    assert stored["version"] == 1
    assert stored["last_event_sequence"] == 1
    event_paths = [
        path
        for path in repository._client.rows
        if path.startswith("foundRoll_test_passports/case-opaque-stable-id/events/")
    ]
    assert len(event_paths) == 1

    with pytest.raises(Conflict) as error:
        repository.create_case(case, [], **{**kwargs, "fingerprint": "b" * 64})
    assert error.value.code == "idempotency_conflict"
    assert repository._client.rows["foundRoll_test_passports/case-opaque-stable-id"]["version"] == 1
