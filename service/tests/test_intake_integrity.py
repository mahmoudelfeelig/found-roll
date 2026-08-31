from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from conftest import STAFF_HEADERS
from app.config import Settings
from app.domain import (
    CaseRecord,
    CustodyState,
    EvidenceOrigin,
    EvidenceProvenance,
    EvidenceVisibility,
    OutboxFailureStage,
    OutboxStatus,
    RiskTier,
)
from app.errors import Conflict, Unavailable
from app.evidence import ORIGINAL_TRANSFORM, PREVIEW_TRANSFORM
from app.main import create_app
from app.repository import FirestoreRepository, InMemoryRepository


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


def _store_pair(
    store,
    *,
    case_id: str,
    workflow_epoch: str,
    original_marker: str,
    preview_marker: str,
    authorize_preview_for_model: bool,
):
    """Seed one immutable pair without invoking the upload route's auto starter."""

    key_hash = original_marker * 64
    fingerprint = preview_marker * 64
    original = store.put(
        case_id=case_id,
        workflow_epoch=workflow_epoch,
        content=f"original-{original_marker}".encode("ascii"),
        mime_type="image/jpeg",
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.ORIGINAL,
            transform=ORIGINAL_TRANSFORM,
        ),
        visibility=EvidenceVisibility.STAFF_ONLY,
        record_id=f"evd-{original_marker * 32}",
        idempotency_key_hash=key_hash,
        command_fingerprint=fingerprint,
    )
    preview = store.put(
        case_id=case_id,
        workflow_epoch=workflow_epoch,
        content=f"preview-{preview_marker}".encode("ascii"),
        mime_type="image/jpeg",
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.DERIVED,
            source_evidence_id=original.id,
            transform=PREVIEW_TRANSFORM,
        ),
        visibility=(
            EvidenceVisibility.MODEL_AUTHORIZED
            if authorize_preview_for_model
            else EvidenceVisibility.STAFF_ONLY
        ),
        record_id=f"evd-{preview_marker * 32}",
        idempotency_key_hash=key_hash,
        command_fingerprint=fingerprint,
    )
    return original, preview


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
    assert created.json()["case"]["analysis_auto_start_armed"] is True
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


def test_imported_case_queues_one_authorized_analysis_and_cites_uploaded_provenance(client):
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
    assert blocked.json()["error"]["code"] == "ordinary_intake_auto_queue_only"
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
    analysis_job = uploaded.json()["analysis_job"]
    assert analysis_job["case"]["state"] == "ANALYZING"
    assert analysis_job["task"]["mode"] == "inline"
    events = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    assert [event["type"] for event in events] == [
        "ITEM_PASSPORT_CREATED",
        "EVIDENCE_PACKET_READY",
        "ANALYSIS_REQUESTED",
    ]
    evidence_ready = next(event for event in events if event["type"] == "EVIDENCE_PACKET_READY")
    assert evidence_ready["evidence_refs"] == sorted(
        [
            f"evidence://{original['id']}?sha256={original['sha256']}",
            f"evidence://{preview['id']}?sha256={preview['sha256']}",
        ]
    )
    assert all("fixture://" not in reference for reference in evidence_ready["evidence_refs"])
    outbox_before = client.get(f"/api/v1/passports/{case_id}").json()["outbox"]
    blocked_manual = client.post(
        f"/api/v1/passports/{case_id}/analysis-jobs",
        json={"expected_version": 1, "idempotency_key": "manual-armed-bypass-001"},
    )
    assert blocked_manual.status_code == 409
    assert blocked_manual.json()["error"]["code"] == "ordinary_intake_auto_queue_only"
    assert client.get(f"/api/v1/passports/{case_id}/events").json()["items"] == events
    assert client.get(f"/api/v1/passports/{case_id}").json()["outbox"] == outbox_before


def test_imported_case_waits_for_authorized_preview_then_retries_without_duplicate_analysis(client):
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
    assert uploaded.json()["analysis_job"] is None
    assert client.get(f"/api/v1/passports/{case_id}").json()["case"]["state"] == "RECEIVED"

    authorized = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", _jpeg(), "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "import-authorized-upload-001",
        },
    )
    assert authorized.status_code == 200, authorized.text
    first_job = authorized.json()["analysis_job"]
    assert first_job["case"]["state"] == "ANALYZING"

    retried = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", _jpeg(), "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "import-authorized-upload-001",
        },
    )
    assert retried.status_code == 200, retried.text
    retry_job = retried.json()["analysis_job"]
    assert retry_job["task"]["task_name"] == first_job["task"]["task_name"]
    events = client.get(f"/api/v1/passports/{case_id}/events").json()["items"]
    assert [event["type"] for event in events].count("EVIDENCE_PACKET_READY") == 1
    assert [event["type"] for event in events].count("ANALYSIS_REQUESTED") == 1


@pytest.mark.parametrize("second_pair_authorized", [True, False])
def test_ordinary_intake_binds_the_triggering_exact_pair_when_a_later_pair_exists(
    client,
    second_pair_authorized,
):
    created = client.post(
        "/api/v1/intakes",
        json={**_intake_payload(), "idempotency_key": f"import-race-{second_pair_authorized}-001"},
        headers=STAFF_HEADERS,
    )
    assert created.status_code == 200, created.text
    case = created.json()["case"]
    store = client.app.state.evidence_store
    first = _store_pair(
        store,
        case_id=case["id"],
        workflow_epoch=case["workflow_epoch"],
        original_marker="a",
        preview_marker="b",
        authorize_preview_for_model=True,
    )
    second = _store_pair(
        store,
        case_id=case["id"],
        workflow_epoch=case["workflow_epoch"],
        original_marker="c",
        preview_marker="d",
        authorize_preview_for_model=second_pair_authorized,
    )
    # This models a second upload becoming latest before the first request gets
    # CPU time to create its background command.
    assert store.latest_complete_pair(case["id"], case["workflow_epoch"])[1].id == second[1].id

    started = client.app.state.custody_service.auto_start_authorized_intake_analysis(
        case["id"],
        workflow_epoch=case["workflow_epoch"],
        original_id=first[0].id,
        preview_id=first[1].id,
    )

    assert started is not None
    assert started["case"].state == CustodyState.ANALYZING
    events = client.get(f"/api/v1/passports/{case['id']}/events").json()["items"]
    evidence_ready = next(event for event in events if event["type"] == "EVIDENCE_PACKET_READY")
    assert evidence_ready["evidence_refs"] == sorted(
        [
            f"evidence://{first[0].id}?sha256={first[0].sha256}",
            f"evidence://{first[1].id}?sha256={first[1].sha256}",
        ]
    )
    assert all(second_record.id not in reference for reference in evidence_ready["evidence_refs"] for second_record in second)
    assert len(client.get(f"/api/v1/passports/{case['id']}").json()["outbox"]) == 1


def test_upload_route_queues_its_authorized_pair_when_a_later_staff_only_pair_wins_latest_lookup(
    client,
    monkeypatch,
):
    created = client.post(
        "/api/v1/intakes",
        json={**_intake_payload(), "idempotency_key": "import-http-race-001"},
        headers=STAFF_HEADERS,
    )
    assert created.status_code == 200, created.text
    case = created.json()["case"]
    store = client.app.state.evidence_store
    original_latest_complete_pair = store.latest_complete_pair
    injected = False

    def race_latest_complete_pair(case_id, workflow_epoch):
        nonlocal injected
        if not injected:
            injected = True
            _store_pair(
                store,
                case_id=case_id,
                workflow_epoch=workflow_epoch,
                original_marker="c",
                preview_marker="d",
                authorize_preview_for_model=False,
            )
        return original_latest_complete_pair(case_id, workflow_epoch)

    monkeypatch.setattr(store, "latest_complete_pair", race_latest_complete_pair)
    uploaded = client.post(
        f"/api/v1/staff/passports/{case['id']}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", _jpeg(), "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "import-http-race-upload-001",
        },
    )

    assert uploaded.status_code == 200, uploaded.text
    assert injected is True
    assert uploaded.json()["active_for_analysis"] is False
    assert uploaded.json()["analysis_job"]["case"]["state"] == "ANALYZING"
    events = client.get(f"/api/v1/passports/{case['id']}/events").json()["items"]
    evidence_ready = next(event for event in events if event["type"] == "EVIDENCE_PACKET_READY")
    original = uploaded.json()["original"]
    preview = uploaded.json()["preview"]
    assert evidence_ready["evidence_refs"] == sorted(
        [
            f"evidence://{original['id']}?sha256={original['sha256']}",
            f"evidence://{preview['id']}?sha256={preview['sha256']}",
        ]
    )


class _FailOnceAnalysisRequestRepository(InMemoryRepository):
    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    def apply_mutation(self, spec, **kwargs):
        if spec.event_type == "ANALYSIS_REQUESTED" and not self.failed:
            self.failed = True
            raise RuntimeError("synthetic interruption after the evidence checkpoint")
        return super().apply_mutation(spec, **kwargs)


def test_ordinary_intake_retry_resumes_only_its_frozen_evidence_checkpoint():
    repository = _FailOnceAnalysisRequestRepository()
    application = create_app(settings=Settings(), repository=repository)
    with TestClient(application) as client:
        created = client.post(
            "/api/v1/intakes",
            json={**_intake_payload(), "idempotency_key": "import-frozen-resume-001"},
            headers=STAFF_HEADERS,
        )
        assert created.status_code == 200, created.text
        case = created.json()["case"]
        store = application.state.evidence_store
        first = _store_pair(
            store,
            case_id=case["id"],
            workflow_epoch=case["workflow_epoch"],
            original_marker="e",
            preview_marker="f",
            authorize_preview_for_model=True,
        )
        service = application.state.custody_service
        with pytest.raises(RuntimeError):
            service.auto_start_authorized_intake_analysis(
                case["id"],
                workflow_epoch=case["workflow_epoch"],
                original_id=first[0].id,
                preview_id=first[1].id,
            )
        assert repository.get_case(case["id"]).state == CustodyState.EVIDENCE_READY
        _store_pair(
            store,
            case_id=case["id"],
            workflow_epoch=case["workflow_epoch"],
            original_marker="1",
            preview_marker="2",
            authorize_preview_for_model=True,
        )

        resumed = service.auto_start_authorized_intake_analysis(
            case["id"],
            workflow_epoch=case["workflow_epoch"],
            original_id=first[0].id,
            preview_id=first[1].id,
        )

    assert resumed is not None
    assert resumed["case"].state == CustodyState.ANALYZING
    events = repository.list_events(case["id"])
    evidence_ready = next(event for event in events if event.type == "EVIDENCE_PACKET_READY")
    assert evidence_ready.evidence_refs == sorted(
        [
            f"evidence://{first[0].id}?sha256={first[0].sha256}",
            f"evidence://{first[1].id}?sha256={first[1].sha256}",
        ]
    )
    assert len([row for row in repository.list_outboxes(case["id"])]) == 1


class _FailOncePublisher:
    def __init__(self) -> None:
        self.calls = 0

    def publish(self, outbox):
        self.calls += 1
        if self.calls == 1:
            raise Unavailable("task_publish_failed", "synthetic queue failure")
        return {"queued": True, "mode": "cloud_tasks", "task_name": outbox.task_name}


def test_ordinary_intake_failed_publish_recovers_only_through_bounded_admin_reconciliation(
    client,
    settings,
):
    publisher = _FailOncePublisher()
    client.app.state.custody_service.task_publisher = publisher
    created = client.post(
        "/api/v1/intakes",
        json={**_intake_payload(), "idempotency_key": "import-publish-recovery-001"},
        headers=STAFF_HEADERS,
    )
    assert created.status_code == 200, created.text
    case_id = created.json()["case"]["id"]
    failed_upload = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", _jpeg(), "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "import-publish-recovery-upload-001",
        },
    )
    assert failed_upload.status_code == 503
    snapshot = client.get(f"/api/v1/passports/{case_id}").json()
    assert snapshot["case"]["state"] == "ANALYZING"
    assert snapshot["outbox"][-1]["status"] == "FAILED"
    assert snapshot["outbox"][-1]["failure_stage"] == "PUBLISH"
    event_count = len(snapshot["events"])

    denied = client.post(
        f"/api/v1/admin/passports/{case_id}/outbox/reconcile",
        json={"max_items": 1},
    )
    recovered = client.post(
        f"/api/v1/admin/passports/{case_id}/outbox/reconcile",
        json={"max_items": 1},
        headers={"X-Found-Roll-Admin-Token": settings.admin_token},
    )
    replay = client.post(
        f"/api/v1/admin/passports/{case_id}/outbox/reconcile",
        json={"max_items": 1},
        headers={"X-Found-Roll-Admin-Token": settings.admin_token},
    )

    assert denied.status_code == 403
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["eligible"] == 1
    assert recovered.json()["recovered"] == 1
    assert recovered.json()["items"][0]["status"] == "DISPATCHED"
    assert replay.status_code == 200
    assert replay.json()["eligible"] == 0
    assert publisher.calls == 2
    assert len(client.get(f"/api/v1/passports/{case_id}").json()["events"]) == event_count

    outbox_id = recovered.json()["items"][0]["outbox_id"]
    client.app.state.custody_service.repository.mark_outbox(
        outbox_id,
        OutboxStatus.FAILED,
        failure_stage=OutboxFailureStage.EXECUTE,
        failure_code="analyst_unavailable",
    )
    execution_failed = client.post(
        f"/api/v1/admin/passports/{case_id}/outbox/reconcile",
        json={"max_items": 1},
        headers={"X-Found-Roll-Admin-Token": settings.admin_token},
    )
    assert execution_failed.status_code == 200
    assert execution_failed.json()["eligible"] == 0


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
