from __future__ import annotations

import asyncio
from dataclasses import replace
from hashlib import sha256
from io import BytesIO
import re

import pytest
from fastapi import UploadFile
from fastapi.testclient import TestClient
from PIL import Image
from starlette.datastructures import Headers

from app.config import Settings
from app.domain import (
    EvidenceOrigin,
    EvidenceProvenance,
    EvidenceVisibility,
)
from app.errors import DomainError, Unavailable
from app.evidence import (
    GcsObject,
    GoogleCloudStorageEvidenceStore,
    InMemoryEvidenceStore,
    store_upload_pair,
)
from app.main import create_app


STAFF_HEADERS = {"X-Found-Roll-Staff-Token": "found-roll-local-staff-token"}


def _jpeg_with_exif(color=(35, 61, 87)) -> bytes:
    image = Image.new("RGB", (48, 32), color)
    exif = Image.Exif()
    exif[270] = "staff-only intake note"
    output = BytesIO()
    image.save(output, format="JPEG", quality=92, exif=exif)
    return output.getvalue()


def _png() -> bytes:
    output = BytesIO()
    Image.new("RGBA", (24, 24), (120, 80, 40, 128)).save(output, format="PNG")
    return output.getvalue()


def _upload(content: bytes, mime_type: str = "image/jpeg") -> UploadFile:
    return UploadFile(
        file=BytesIO(content),
        filename="intake-image",
        headers=Headers({"content-type": mime_type}),
    )


def _store_pair(
    store,
    *,
    content: bytes,
    workflow_epoch: str,
    idempotency_key: str,
    authorized: bool = True,
):
    return asyncio.run(
        store_upload_pair(
            store,
            case_id="FR-CASE",
            workflow_epoch=workflow_epoch,
            idempotency_key=idempotency_key,
            upload=_upload(content),
            authorize_preview_for_model=authorized,
            max_bytes=2_000_000,
            preview_max_edge=1600,
        )
    )


def test_upload_preserves_original_and_creates_exif_free_authorized_preview(client, case_id):
    original_bytes = _jpeg_with_exif()
    uploaded = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("claimant-secret-file.jpg", original_bytes, "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "evidence-preserve-preview-001",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    body = uploaded.json()
    original = body["original"]
    preview = body["preview"]

    replayed = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("renamed-on-retry.jpg", original_bytes, "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "evidence-preserve-preview-001",
        },
    )
    assert replayed.status_code == 200, replayed.text
    assert replayed.json() == body
    conflicting = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("different.jpg", _jpeg_with_exif((90, 30, 10)), "image/jpeg")},
        data={
            "authorize_preview_for_model": "true",
            "idempotency_key": "evidence-preserve-preview-001",
        },
    )
    assert conflicting.status_code == 409
    assert conflicting.json()["error"]["code"] == "evidence_idempotency_conflict"

    assert body["restricted_bytes_included"] is False
    assert original["provenance"] == {
        "origin": "ORIGINAL",
        "source_evidence_id": None,
        "transform": "unaltered-upload-v1",
    }
    assert preview["provenance"]["origin"] == "DERIVED"
    assert preview["provenance"]["source_evidence_id"] == original["id"]
    assert original["visibility"] == "STAFF_ONLY"
    assert preview["visibility"] == "MODEL_AUTHORIZED"
    assert original["sha256"] == sha256(original_bytes).hexdigest()
    assert original["mime_type"] == "image/jpeg"
    assert preview["mime_type"] == "image/jpeg"
    assert "idempotency_key_hash" not in uploaded.text
    assert "command_fingerprint" not in uploaded.text
    assert "evidence-preserve-preview-001" not in uploaded.text
    for record in (original, preview):
        assert re.fullmatch(r"evidence/[a-f0-9]{32}", record["object_name"])
        assert case_id not in record["object_name"]
        assert "claimant" not in record["object_name"]

    original_read = client.get(
        f"/api/v1/staff/passports/{case_id}/evidence/{original['id']}",
        headers=STAFF_HEADERS,
    )
    assert original_read.status_code == 200
    assert original_read.content == original_bytes
    assert original_read.headers["cache-control"] == "no-store, private"
    assert original_read.headers["x-found-roll-evidence-sha256"] == original["sha256"]

    preview_read = client.get(
        f"/api/v1/staff/passports/{case_id}/evidence/{preview['id']}",
        headers=STAFF_HEADERS,
    )
    assert preview_read.status_code == 200
    assert sha256(preview_read.content).hexdigest() == preview["sha256"]
    with Image.open(BytesIO(preview_read.content)) as decoded:
        assert decoded.format == "JPEG"
        assert len(decoded.getexif()) == 0

    metadata = client.get(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
    )
    assert metadata.status_code == 200
    assert len(metadata.json()["items"]) == 2
    assert "claimant-secret-file" not in metadata.text
    assert "staff-only intake note" not in metadata.text


def test_restricted_evidence_bytes_are_not_available_without_staff_auth(client, case_id):
    original_bytes = _jpeg_with_exif()
    uploaded = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.jpg", original_bytes, "image/jpeg")},
        data={"idempotency_key": "evidence-auth-boundary-001"},
    ).json()
    evidence_id = uploaded["original"]["id"]

    denied = client.get(f"/api/v1/staff/passports/{case_id}/evidence/{evidence_id}")
    assert denied.status_code == 403
    assert original_bytes not in denied.content
    public_guess = client.get(f"/api/v1/passports/{case_id}/evidence/{evidence_id}")
    assert public_guess.status_code == 404
    assert original_bytes not in public_guess.content


def test_upload_rejects_unsupported_and_spoofed_types(client, case_id):
    unsupported = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("note.txt", b"not an image", "text/plain")},
        data={"idempotency_key": "evidence-unsupported-type-001"},
    )
    assert unsupported.status_code == 415
    assert unsupported.json()["error"]["code"] == "evidence_type_unsupported"

    spoofed = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("spoofed.jpg", _png(), "image/jpeg")},
        data={"idempotency_key": "evidence-spoofed-type-001"},
    )
    assert spoofed.status_code == 415
    assert spoofed.json()["error"]["code"] == "evidence_type_mismatch"


def test_png_upload_is_retained_as_png_with_a_separate_jpeg_preview(client, case_id):
    response = client.post(
        f"/api/v1/staff/passports/{case_id}/evidence",
        headers=STAFF_HEADERS,
        files={"file": ("intake.png", _png(), "image/png")},
        data={"idempotency_key": "evidence-png-preview-001"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["original"]["mime_type"] == "image/png"
    assert body["preview"]["mime_type"] == "image/jpeg"
    assert body["preview"]["visibility"] == "STAFF_ONLY"


def test_upload_enforces_configured_byte_limit(settings, case_id):
    limited = replace(settings, evidence_max_upload_bytes=64)
    with TestClient(create_app(settings=limited)) as client:
        response = client.post(
            f"/api/v1/staff/passports/{case_id}/evidence",
            headers=STAFF_HEADERS,
            files={"file": ("large.jpg", _jpeg_with_exif(), "image/jpeg")},
            data={"idempotency_key": "evidence-byte-limit-001"},
        )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "evidence_too_large"


def test_upload_pair_retry_is_deterministic_and_does_not_duplicate_records():
    store = InMemoryEvidenceStore()
    content = _jpeg_with_exif()

    first = _store_pair(
        store,
        content=content,
        workflow_epoch="epoch-7",
        idempotency_key="upload-command-7",
    )
    retried = _store_pair(
        store,
        content=content,
        workflow_epoch="epoch-7",
        idempotency_key="upload-command-7",
    )
    independently_recreated = _store_pair(
        InMemoryEvidenceStore(),
        content=content,
        workflow_epoch="epoch-7",
        idempotency_key="upload-command-7",
    )

    assert [record.id for record in retried] == [record.id for record in first]
    assert [record.object_name for record in retried] == [
        record.object_name for record in first
    ]
    assert [record.id for record in independently_recreated] == [
        record.id for record in first
    ]
    assert [record.object_name for record in independently_recreated] == [
        record.object_name for record in first
    ]
    assert all(record.workflow_epoch == "epoch-7" for record in first)
    assert len(store.list_records("FR-CASE")) == 2


@pytest.mark.parametrize(
    ("retry_content", "retry_authorized"),
    [
        (_jpeg_with_exif((88, 44, 20)), True),
        (_jpeg_with_exif(), False),
    ],
)
def test_same_upload_key_rejects_changed_bytes_or_model_consent(
    retry_content,
    retry_authorized,
):
    store = InMemoryEvidenceStore()
    _store_pair(
        store,
        content=_jpeg_with_exif(),
        workflow_epoch="epoch-8",
        idempotency_key="upload-command-8",
        authorized=True,
    )

    with pytest.raises(DomainError) as error:
        _store_pair(
            store,
            content=retry_content,
            workflow_epoch="epoch-8",
            idempotency_key="upload-command-8",
            authorized=retry_authorized,
        )

    assert error.value.code == "evidence_idempotency_conflict"
    assert error.value.status_code == 409
    assert len(store.list_records("FR-CASE")) == 2


def test_retry_completes_an_original_only_partial_pair_without_duplicates():
    class FailFirstPreviewStore(InMemoryEvidenceStore):
        fail_preview = True

        def put(self, **kwargs):
            if (
                self.fail_preview
                and kwargs["provenance"].origin == EvidenceOrigin.DERIVED
            ):
                self.fail_preview = False
                raise Unavailable("fixture_preview_failure", "Preview write failed.")
            return super().put(**kwargs)

    store = FailFirstPreviewStore()
    content = _jpeg_with_exif()
    with pytest.raises(Unavailable, match="Preview write failed"):
        _store_pair(
            store,
            content=content,
            workflow_epoch="epoch-9",
            idempotency_key="upload-command-9",
        )

    partial = store.list_records("FR-CASE")
    assert len(partial) == 1
    assert partial[0].provenance.origin == EvidenceOrigin.ORIGINAL
    assert store.latest_complete_pair("FR-CASE", "epoch-9") is None

    completed = _store_pair(
        store,
        content=content,
        workflow_epoch="epoch-9",
        idempotency_key="upload-command-9",
    )
    assert completed[0].id == partial[0].id
    assert len(store.list_records("FR-CASE")) == 2
    assert store.latest_complete_pair("FR-CASE", "epoch-9") == completed


def test_epoch_selection_returns_only_the_latest_complete_pair():
    store = InMemoryEvidenceStore()
    old_pair = _store_pair(
        store,
        content=_jpeg_with_exif((10, 20, 30)),
        workflow_epoch="epoch-old",
        idempotency_key="epoch-reused-upload-key",
    )
    first_current = _store_pair(
        store,
        content=_jpeg_with_exif((40, 50, 60)),
        workflow_epoch="epoch-current",
        idempotency_key="epoch-reused-upload-key",
    )
    latest_current = _store_pair(
        store,
        content=_jpeg_with_exif((70, 80, 90)),
        workflow_epoch="epoch-current",
        idempotency_key="current-upload-2",
    )

    assert store.latest_complete_pair("FR-CASE", "epoch-old") == old_pair
    assert store.latest_complete_pair("FR-CASE", "epoch-current") == latest_current
    assert old_pair[0].id != first_current[0].id
    assert store.list_model_authorized("FR-CASE", "epoch-current") == [
        latest_current[1]
    ]
    assert first_current[1] not in store.list_model_authorized(
        "FR-CASE", "epoch-current"
    )

    newest_without_consent = _store_pair(
        store,
        content=_jpeg_with_exif((100, 110, 120)),
        workflow_epoch="epoch-current",
        idempotency_key="current-upload-3",
        authorized=False,
    )
    assert store.latest_complete_pair("FR-CASE", "epoch-current") == newest_without_consent
    assert store.list_model_authorized("FR-CASE", "epoch-current") == []

    store.put(
        case_id="FR-CASE",
        workflow_epoch="epoch-current",
        content=_jpeg_with_exif((130, 140, 150)),
        mime_type="image/jpeg",
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.ORIGINAL,
            transform="unaltered-upload-v1",
        ),
        visibility=EvidenceVisibility.STAFF_ONLY,
        record_id=f"evd-{'f' * 32}",
    )
    assert store.latest_complete_pair("FR-CASE", "epoch-current") == newest_without_consent


class FakeGcsAdapter:
    bucket_name = "private-evidence-fixture"

    def __init__(self, *, exists: bool = True) -> None:
        self.exists = exists
        self.rows: dict[str, GcsObject] = {}
        self.content: dict[str, bytes] = {}
        self.generation = 40

    def bucket_exists(self) -> bool:
        return self.exists

    def upload(self, *, object_name, content, content_type, metadata):
        self.generation += 1
        row = GcsObject(
            object_name=object_name,
            generation=self.generation,
            content_type=content_type,
            size=len(content),
            metadata=dict(metadata),
        )
        self.rows[object_name] = row
        self.content[object_name] = bytes(content)
        return row

    def list(self, *, prefix):
        return [row for name, row in self.rows.items() if name.startswith(prefix)]

    def download(self, *, object_name, generation):
        assert self.rows[object_name].generation == generation
        return self.content[object_name]


def test_gcs_pair_recovers_a_committed_upload_when_the_response_is_lost():
    class LoseFirstUploadResponse(FakeGcsAdapter):
        lose_response = True

        def upload(self, **kwargs):
            row = super().upload(**kwargs)
            if self.lose_response:
                self.lose_response = False
                raise ConnectionError("fixture response lost after commit")
            return row

    adapter = LoseFirstUploadResponse()
    store = GoogleCloudStorageEvidenceStore(
        bucket_name=adapter.bucket_name,
        adapter=adapter,
    )
    content = _jpeg_with_exif()

    first = _store_pair(
        store,
        content=content,
        workflow_epoch="epoch-gcs",
        idempotency_key="gcs-upload-command",
    )
    retried = _store_pair(
        store,
        content=content,
        workflow_epoch="epoch-gcs",
        idempotency_key="gcs-upload-command",
    )

    assert first == retried
    assert len(adapter.rows) == 2
    assert store.latest_complete_pair("FR-CASE", "epoch-gcs") == first
    assert store.list_model_authorized("FR-CASE", "epoch-gcs") == [first[1]]


def test_mockable_gcs_contract_preserves_provenance_and_checksums_reads():
    adapter = FakeGcsAdapter()
    store = GoogleCloudStorageEvidenceStore(
        bucket_name=adapter.bucket_name,
        adapter=adapter,
    )
    original_content = b"fixture-original"
    original = store.put(
        case_id="FR-CASE",
        content=original_content,
        mime_type="image/png",
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.ORIGINAL,
            transform="unaltered-upload-v1",
        ),
        visibility=EvidenceVisibility.STAFF_ONLY,
    )
    preview = store.put(
        case_id="FR-CASE",
        content=b"fixture-preview",
        mime_type="image/jpeg",
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.DERIVED,
            source_evidence_id=original.id,
            transform="exif-transpose-fit-1600-jpeg-v1",
        ),
        visibility=EvidenceVisibility.MODEL_AUTHORIZED,
    )

    assert original.storage_uri.startswith("gs://private-evidence-fixture/evidence/")
    assert original.generation == 41
    assert preview.generation == 42
    assert re.fullmatch(r"evidence/[a-f0-9]{32}", original.object_name)
    assert store.read(original.id) == original_content
    assert [
        record.id
        for record in store.list_model_authorized("FR-CASE", "legacy")
    ] == [preview.id]
    assert store.get_record(preview.id).provenance.source_evidence_id == original.id

    adapter.content[original.object_name] = b"tampered"
    with pytest.raises(Unavailable) as error:
        store.read(original.id)
    assert error.value.code == "evidence_checksum_mismatch"


def test_gcs_store_and_health_fail_closed_when_storage_is_unavailable(settings):
    adapter = FakeGcsAdapter(exists=False)
    with pytest.raises(Unavailable) as error:
        GoogleCloudStorageEvidenceStore(
            bucket_name=adapter.bucket_name,
            adapter=adapter,
        )
    assert error.value.code == "evidence_bucket_unavailable"

    class NotReadyMemoryStore(InMemoryEvidenceStore):
        def is_ready(self) -> bool:
            return False

    with TestClient(create_app(settings=settings, evidence_store=NotReadyMemoryStore())) as client:
        health = client.get("/api/v1/healthz")
    assert health.status_code == 503
    assert health.json()["status"] == "unavailable"
    assert health.json()["evidence_store_ready"] is False
    assert health.json()["repository"] == "memory"
    assert health.json()["tasks_mode"] == "inline"


def test_production_configuration_requires_real_evidence_store_and_bucket():
    production_without_evidence = Settings(
        environment="production",
        repository_backend="firestore",
        analyst_mode="vertex_adk",
        inventory_mode="http",
        inventory_base_url="https://simulator.example.test",
        relay_mode="http",
        tasks_mode="cloud",
        require_task_header=True,
        require_task_oidc=True,
        google_cloud_project="fixture-project",
        relay_base_url="https://relay.example.test",
        relay_api_key="fixture-relay-key",
        task_service_account="tasks@fixture-project.iam.gserviceaccount.com",
        secret_pepper="non-default-pepper",
        relay_shared_secret="non-default-callback-secret",
    )
    with pytest.raises(ValueError, match="EVIDENCE_STORE=gcs"):
        production_without_evidence.validate()

    missing_bucket = replace(production_without_evidence, evidence_backend="gcs")
    with pytest.raises(ValueError, match="EVIDENCE_BUCKET"):
        missing_bucket.validate()
