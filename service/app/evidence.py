"""Private image-evidence storage and deterministic preview normalization.

The original object is always staff-only. A separate JPEG preview is decoded,
orientation-normalized, resized, and re-encoded without EXIF. Only previews
explicitly marked MODEL_AUTHORIZED may be attached to a Vertex request.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256
from io import BytesIO
import json
from threading import RLock
from typing import Mapping, Protocol
from uuid import uuid4

from fastapi import UploadFile

from .domain import (
    EvidenceOrigin,
    EvidenceProvenance,
    EvidenceRecord,
    EvidenceVisibility,
    utc_now,
)
from .errors import DomainError, NotFound, Unavailable


ALLOWED_IMAGE_TYPES = frozenset({"image/jpeg", "image/png"})
EVIDENCE_OBJECT_PREFIX = "evidence/"
PREVIEW_TRANSFORM = "exif-transpose-fit-1600-jpeg-v1"
ORIGINAL_TRANSFORM = "unaltered-upload-v1"
MAX_IMAGE_PIXELS = 40_000_000


def _digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def _new_record_id() -> str:
    return f"evd-{uuid4().hex}"


def _object_name_for_record_id(record_id: str) -> str:
    # Deliberately excludes case IDs, user filenames, and MIME extensions.
    return f"{EVIDENCE_OBJECT_PREFIX}{record_id.removeprefix('evd-')}"


def _key_hash(idempotency_key: str) -> str:
    return _digest(idempotency_key.encode("utf-8"))


def _pair_identity(
    *,
    case_id: str,
    workflow_epoch: str,
    idempotency_key: str,
) -> str:
    canonical = json.dumps(
        {
            "case_id": case_id,
            "idempotency_key": idempotency_key,
            "schema_version": "1",
            "workflow_epoch": workflow_epoch,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return _digest(canonical.encode("utf-8"))


def _pair_record_id(pair_identity: str, role: str) -> str:
    return f"evd-{_digest(f'{pair_identity}:{role}'.encode('utf-8'))[:32]}"


def _command_fingerprint(
    *,
    case_id: str,
    workflow_epoch: str,
    image: "ValidatedImage",
    authorize_preview_for_model: bool,
) -> str:
    canonical = json.dumps(
        {
            "authorize_preview_for_model": authorize_preview_for_model,
            "case_id": case_id,
            "original_mime_type": image.original_mime_type,
            "original_sha256": _digest(image.original),
            "preview_sha256": _digest(image.preview),
            "schema_version": "1",
            "workflow_epoch": workflow_epoch,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return _digest(canonical.encode("utf-8"))


def _records_are_one_pair(
    original: EvidenceRecord,
    preview: EvidenceRecord,
    *,
    case_id: str,
    workflow_epoch: str,
) -> bool:
    return (
        original.case_id == case_id
        and preview.case_id == case_id
        and original.workflow_epoch == workflow_epoch
        and preview.workflow_epoch == workflow_epoch
        and original.provenance.origin == EvidenceOrigin.ORIGINAL
        and original.provenance.transform == ORIGINAL_TRANSFORM
        and preview.provenance.origin == EvidenceOrigin.DERIVED
        and preview.provenance.transform == PREVIEW_TRANSFORM
        and preview.provenance.source_evidence_id == original.id
        and original.idempotency_key_hash == preview.idempotency_key_hash
        and original.command_fingerprint == preview.command_fingerprint
    )


def _latest_complete_pair(
    records: list[EvidenceRecord],
    *,
    case_id: str,
    workflow_epoch: str,
) -> tuple[EvidenceRecord, EvidenceRecord] | None:
    originals = {
        record.id: record
        for record in records
        if record.provenance.origin == EvidenceOrigin.ORIGINAL
    }
    pairs: list[tuple[EvidenceRecord, EvidenceRecord]] = []
    for preview in records:
        source_id = preview.provenance.source_evidence_id
        if preview.provenance.origin != EvidenceOrigin.DERIVED or not source_id:
            continue
        original = originals.get(source_id)
        if original is not None and _records_are_one_pair(
            original,
            preview,
            case_id=case_id,
            workflow_epoch=workflow_epoch,
        ):
            pairs.append((original, preview))
    if not pairs:
        return None
    return max(
        pairs,
        key=lambda pair: (
            max(pair[0].created_at, pair[1].created_at),
            pair[1].created_at,
            pair[1].id,
        ),
    )


def _assert_idempotent_match(
    record: EvidenceRecord,
    *,
    case_id: str,
    workflow_epoch: str,
    object_name: str,
    content: bytes,
    mime_type: str,
    provenance: EvidenceProvenance,
    visibility: EvidenceVisibility,
    idempotency_key_hash: str | None,
    command_fingerprint: str | None,
) -> EvidenceRecord:
    expected = (
        case_id,
        workflow_epoch,
        object_name,
        _digest(content),
        mime_type,
        provenance,
        visibility,
        idempotency_key_hash,
        command_fingerprint,
        len(content),
    )
    actual = (
        record.case_id,
        record.workflow_epoch,
        record.object_name,
        record.sha256,
        record.mime_type,
        record.provenance,
        record.visibility,
        record.idempotency_key_hash,
        record.command_fingerprint,
        record.byte_size,
    )
    if actual != expected:
        raise DomainError(
            "evidence_idempotency_conflict",
            "The evidence idempotency key was already used for a different upload command.",
            409,
        )
    return record


@dataclass(frozen=True, slots=True)
class GcsObject:
    object_name: str
    generation: int
    content_type: str
    size: int
    metadata: Mapping[str, str]


class GcsAdapter(Protocol):
    """Small, mockable boundary around the Google Cloud Storage client."""

    bucket_name: str

    def bucket_exists(self) -> bool: ...

    def upload(
        self,
        *,
        object_name: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str],
    ) -> GcsObject: ...

    def list(self, *, prefix: str) -> list[GcsObject]: ...

    def download(self, *, object_name: str, generation: int) -> bytes: ...


class GoogleCloudStorageAdapter:
    """Private-by-default GCS operations with generation-pinned reads."""

    def __init__(self, *, bucket_name: str, project: str | None) -> None:
        try:
            from google.cloud import storage
        except ImportError as exc:  # pragma: no cover - cloud-only dependency guard
            raise Unavailable(
                "gcs_dependency_missing",
                "Install google-cloud-storage to use the Google Cloud evidence store.",
            ) from exc
        self.bucket_name = bucket_name
        self._client = storage.Client(project=project)
        self._bucket = self._client.bucket(bucket_name)

    @staticmethod
    def _object(blob) -> GcsObject:
        return GcsObject(
            object_name=blob.name,
            generation=int(blob.generation),
            content_type=blob.content_type or "application/octet-stream",
            size=int(blob.size or 0),
            metadata=dict(blob.metadata or {}),
        )

    def bucket_exists(self) -> bool:
        return bool(self._bucket.exists(client=self._client))

    def upload(
        self,
        *,
        object_name: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str],
    ) -> GcsObject:
        blob = self._bucket.blob(object_name)
        blob.metadata = dict(metadata)
        # No public ACL or signed URL is created. Generation-match zero prevents overwrite.
        blob.upload_from_string(
            content,
            content_type=content_type,
            if_generation_match=0,
            checksum="auto",
        )
        blob.reload()
        return self._object(blob)

    def list(self, *, prefix: str) -> list[GcsObject]:
        return [
            self._object(blob)
            for blob in self._client.list_blobs(self.bucket_name, prefix=prefix)
        ]

    def download(self, *, object_name: str, generation: int) -> bytes:
        blob = self._bucket.blob(object_name, generation=generation)
        return blob.download_as_bytes(if_generation_match=generation, checksum="auto")


class EvidenceStore(Protocol):
    mode: str
    bucket_name: str | None

    def is_ready(self) -> bool: ...

    def put(
        self,
        *,
        case_id: str,
        workflow_epoch: str = "legacy",
        content: bytes,
        mime_type: str,
        provenance: EvidenceProvenance,
        visibility: EvidenceVisibility,
        record_id: str | None = None,
        created_at: datetime | None = None,
        idempotency_key_hash: str | None = None,
        command_fingerprint: str | None = None,
    ) -> EvidenceRecord: ...

    def list_records(self, case_id: str) -> list[EvidenceRecord]: ...

    def get_record(self, evidence_id: str) -> EvidenceRecord: ...

    def read(self, evidence_id: str) -> bytes: ...

    def latest_complete_pair(
        self,
        case_id: str,
        workflow_epoch: str,
    ) -> tuple[EvidenceRecord, EvidenceRecord] | None: ...

    def list_model_authorized(
        self,
        case_id: str,
        workflow_epoch: str,
    ) -> list[EvidenceRecord]: ...


class InMemoryEvidenceStore:
    mode = "memory"
    bucket_name = None

    def __init__(self) -> None:
        self._lock = RLock()
        self._records: dict[str, EvidenceRecord] = {}
        self._content: dict[str, bytes] = {}

    def is_ready(self) -> bool:
        return True

    def put(
        self,
        *,
        case_id: str,
        workflow_epoch: str = "legacy",
        content: bytes,
        mime_type: str,
        provenance: EvidenceProvenance,
        visibility: EvidenceVisibility,
        record_id: str | None = None,
        created_at: datetime | None = None,
        idempotency_key_hash: str | None = None,
        command_fingerprint: str | None = None,
    ) -> EvidenceRecord:
        evidence_id = record_id or _new_record_id()
        object_name = _object_name_for_record_id(evidence_id)
        with self._lock:
            existing = self._records.get(evidence_id)
            if existing is not None:
                _assert_idempotent_match(
                    existing,
                    case_id=case_id,
                    workflow_epoch=workflow_epoch,
                    object_name=object_name,
                    content=content,
                    mime_type=mime_type,
                    provenance=provenance,
                    visibility=visibility,
                    idempotency_key_hash=idempotency_key_hash,
                    command_fingerprint=command_fingerprint,
                )
                if _digest(self._content[evidence_id]) != existing.sha256:
                    raise Unavailable(
                        "evidence_checksum_mismatch",
                        "Stored evidence failed integrity verification.",
                    )
                return existing.model_copy(deep=True)
            record = EvidenceRecord(
                id=evidence_id,
                case_id=case_id,
                workflow_epoch=workflow_epoch,
                object_name=object_name,
                storage_uri=f"memory://{object_name}",
                provenance=provenance,
                sha256=_digest(content),
                generation=1,
                mime_type=mime_type,
                byte_size=len(content),
                visibility=visibility,
                idempotency_key_hash=idempotency_key_hash,
                command_fingerprint=command_fingerprint,
                created_at=created_at or utc_now(),
            )
            self._records[evidence_id] = record
            self._content[evidence_id] = bytes(content)
            return record.model_copy(deep=True)

    def list_records(self, case_id: str) -> list[EvidenceRecord]:
        with self._lock:
            records = [record for record in self._records.values() if record.case_id == case_id]
            return [record.model_copy(deep=True) for record in sorted(records, key=lambda row: row.id)]

    def get_record(self, evidence_id: str) -> EvidenceRecord:
        with self._lock:
            record = self._records.get(evidence_id)
            if record is None:
                raise NotFound("Evidence")
            return record.model_copy(deep=True)

    def read(self, evidence_id: str) -> bytes:
        record = self.get_record(evidence_id)
        with self._lock:
            content = self._content[evidence_id]
        if _digest(content) != record.sha256:
            raise Unavailable("evidence_checksum_mismatch", "Stored evidence failed integrity verification.")
        return bytes(content)

    def latest_complete_pair(
        self,
        case_id: str,
        workflow_epoch: str,
    ) -> tuple[EvidenceRecord, EvidenceRecord] | None:
        pair = _latest_complete_pair(
            self.list_records(case_id),
            case_id=case_id,
            workflow_epoch=workflow_epoch,
        )
        if pair is None:
            return None
        return tuple(record.model_copy(deep=True) for record in pair)

    def list_model_authorized(
        self,
        case_id: str,
        workflow_epoch: str,
    ) -> list[EvidenceRecord]:
        pair = self.latest_complete_pair(case_id, workflow_epoch)
        if pair is None or pair[1].visibility != EvidenceVisibility.MODEL_AUTHORIZED:
            return []
        return [pair[1]]


class GoogleCloudStorageEvidenceStore:
    mode = "gcs"

    def __init__(
        self,
        *,
        bucket_name: str,
        project: str | None = None,
        adapter: GcsAdapter | None = None,
        require_ready: bool = True,
    ) -> None:
        self.bucket_name = bucket_name
        self._adapter = adapter or GoogleCloudStorageAdapter(
            bucket_name=bucket_name,
            project=project,
        )
        if self._adapter.bucket_name != bucket_name:
            raise ValueError("GCS adapter bucket does not match configured evidence bucket")
        if require_ready and not self.is_ready():
            raise Unavailable(
                "evidence_bucket_unavailable",
                "The configured private evidence bucket is missing or unavailable.",
            )

    def is_ready(self) -> bool:
        try:
            return self._adapter.bucket_exists()
        except Exception:
            return False

    @staticmethod
    def _metadata(
        *,
        evidence_id: str,
        case_id: str,
        workflow_epoch: str,
        checksum: str,
        provenance: EvidenceProvenance,
        visibility: EvidenceVisibility,
        created_at: datetime,
        idempotency_key_hash: str | None,
        command_fingerprint: str | None,
    ) -> dict[str, str]:
        metadata = {
            "found_roll_record_id": evidence_id,
            "found_roll_case_id": case_id,
            "found_roll_workflow_epoch": workflow_epoch,
            "found_roll_sha256": checksum,
            "found_roll_provenance": json.dumps(
                provenance.model_dump(mode="json"),
                sort_keys=True,
                separators=(",", ":"),
            ),
            "found_roll_visibility": visibility.value,
            "found_roll_created_at": created_at.isoformat(),
        }
        if idempotency_key_hash is not None:
            metadata["found_roll_idempotency_key_hash"] = idempotency_key_hash
        if command_fingerprint is not None:
            metadata["found_roll_command_fingerprint"] = command_fingerprint
        return metadata

    def _record(self, row: GcsObject) -> EvidenceRecord | None:
        metadata = row.metadata
        try:
            evidence_id = metadata["found_roll_record_id"]
            provenance = EvidenceProvenance.model_validate_json(
                metadata["found_roll_provenance"]
            )
            return EvidenceRecord(
                id=evidence_id,
                case_id=metadata["found_roll_case_id"],
                workflow_epoch=metadata.get("found_roll_workflow_epoch", "legacy"),
                object_name=row.object_name,
                storage_uri=f"gs://{self.bucket_name}/{row.object_name}",
                provenance=provenance,
                sha256=metadata["found_roll_sha256"],
                generation=row.generation,
                mime_type=row.content_type,
                byte_size=row.size,
                visibility=EvidenceVisibility(metadata["found_roll_visibility"]),
                idempotency_key_hash=metadata.get("found_roll_idempotency_key_hash"),
                command_fingerprint=metadata.get("found_roll_command_fingerprint"),
                created_at=datetime.fromisoformat(metadata["found_roll_created_at"]),
            )
        except (KeyError, TypeError, ValueError):
            # Ignore unrelated bucket objects and malformed legacy metadata.
            return None

    def put(
        self,
        *,
        case_id: str,
        workflow_epoch: str = "legacy",
        content: bytes,
        mime_type: str,
        provenance: EvidenceProvenance,
        visibility: EvidenceVisibility,
        record_id: str | None = None,
        created_at: datetime | None = None,
        idempotency_key_hash: str | None = None,
        command_fingerprint: str | None = None,
    ) -> EvidenceRecord:
        evidence_id = record_id or _new_record_id()
        object_name = _object_name_for_record_id(evidence_id)
        checksum = _digest(content)
        timestamp = created_at or utc_now()
        try:
            existing = self.get_record(evidence_id)
        except NotFound:
            existing = None
        if existing is not None:
            return _assert_idempotent_match(
                existing,
                case_id=case_id,
                workflow_epoch=workflow_epoch,
                object_name=object_name,
                content=content,
                mime_type=mime_type,
                provenance=provenance,
                visibility=visibility,
                idempotency_key_hash=idempotency_key_hash,
                command_fingerprint=command_fingerprint,
            )
        try:
            row = self._adapter.upload(
                object_name=object_name,
                content=content,
                content_type=mime_type,
                metadata=self._metadata(
                    evidence_id=evidence_id,
                    case_id=case_id,
                    workflow_epoch=workflow_epoch,
                    checksum=checksum,
                    provenance=provenance,
                    visibility=visibility,
                    created_at=timestamp,
                    idempotency_key_hash=idempotency_key_hash,
                    command_fingerprint=command_fingerprint,
                ),
            )
        except Exception as upload_error:
            # GCS may commit an if-generation-match upload even if its response is lost.
            # Re-read the deterministic object and return it only when the full command
            # fingerprint matches; otherwise preserve the adapter failure.
            try:
                recovered = self.get_record(evidence_id)
            except NotFound:
                raise upload_error
            return _assert_idempotent_match(
                recovered,
                case_id=case_id,
                workflow_epoch=workflow_epoch,
                object_name=object_name,
                content=content,
                mime_type=mime_type,
                provenance=provenance,
                visibility=visibility,
                idempotency_key_hash=idempotency_key_hash,
                command_fingerprint=command_fingerprint,
            )
        record = self._record(row)
        if record is None:
            raise Unavailable(
                "evidence_metadata_invalid",
                "The evidence store did not preserve required provenance metadata.",
            )
        return record

    def _all_records(self) -> list[EvidenceRecord]:
        records = [self._record(row) for row in self._adapter.list(prefix=EVIDENCE_OBJECT_PREFIX)]
        return [record for record in records if record is not None]

    def list_records(self, case_id: str) -> list[EvidenceRecord]:
        return sorted(
            [record for record in self._all_records() if record.case_id == case_id],
            key=lambda row: row.id,
        )

    def get_record(self, evidence_id: str) -> EvidenceRecord:
        for record in self._all_records():
            if record.id == evidence_id:
                return record
        raise NotFound("Evidence")

    def read(self, evidence_id: str) -> bytes:
        record = self.get_record(evidence_id)
        content = self._adapter.download(
            object_name=record.object_name,
            generation=record.generation,
        )
        if _digest(content) != record.sha256:
            raise Unavailable("evidence_checksum_mismatch", "Stored evidence failed integrity verification.")
        return content

    def latest_complete_pair(
        self,
        case_id: str,
        workflow_epoch: str,
    ) -> tuple[EvidenceRecord, EvidenceRecord] | None:
        return _latest_complete_pair(
            self.list_records(case_id),
            case_id=case_id,
            workflow_epoch=workflow_epoch,
        )

    def list_model_authorized(
        self,
        case_id: str,
        workflow_epoch: str,
    ) -> list[EvidenceRecord]:
        pair = self.latest_complete_pair(case_id, workflow_epoch)
        if pair is None or pair[1].visibility != EvidenceVisibility.MODEL_AUTHORIZED:
            return []
        return [pair[1]]


@dataclass(frozen=True, slots=True)
class ValidatedImage:
    original: bytes
    original_mime_type: str
    preview: bytes


async def validate_and_make_preview(
    upload: UploadFile,
    *,
    max_bytes: int,
    preview_max_edge: int,
) -> ValidatedImage:
    declared_type = (upload.content_type or "").lower()
    if declared_type not in ALLOWED_IMAGE_TYPES:
        raise DomainError(
            "evidence_type_unsupported",
            "Evidence uploads must be JPEG or PNG images.",
            415,
        )

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(min(1024 * 1024, max_bytes + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise DomainError(
                "evidence_too_large",
                f"Evidence uploads may not exceed {max_bytes} bytes.",
                413,
            )
        chunks.append(chunk)
    original = b"".join(chunks)
    if not original:
        raise DomainError("evidence_empty", "Evidence uploads may not be empty.", 422)

    try:
        from PIL import Image, ImageFile, ImageOps, UnidentifiedImageError
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise Unavailable(
            "image_dependency_missing",
            "Install Pillow to validate and normalize evidence images.",
        ) from exc

    ImageFile.LOAD_TRUNCATED_IMAGES = False
    try:
        with Image.open(BytesIO(original)) as probe:
            actual_format = (probe.format or "").upper()
            width, height = probe.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise DomainError(
                    "evidence_dimensions_invalid",
                    "Evidence image dimensions are invalid or exceed the safe pixel limit.",
                    422,
                )
            probe.verify()
        actual_type = {"JPEG": "image/jpeg", "PNG": "image/png"}.get(actual_format)
        if actual_type is None or actual_type != declared_type:
            raise DomainError(
                "evidence_type_mismatch",
                "The declared evidence type does not match the decoded image.",
                415,
            )
        with Image.open(BytesIO(original)) as decoded:
            normalized = ImageOps.exif_transpose(decoded)
            normalized.thumbnail((preview_max_edge, preview_max_edge), Image.Resampling.LANCZOS)
            if normalized.mode in {"RGBA", "LA"}:
                rgba = normalized.convert("RGBA")
                rgb = Image.new("RGB", rgba.size, "white")
                rgb.paste(rgba, mask=rgba.getchannel("A"))
                normalized = rgb
            elif normalized.mode != "RGB":
                normalized = normalized.convert("RGB")
            output = BytesIO()
            normalized.save(output, format="JPEG", quality=88, optimize=True)
            preview = output.getvalue()
    except DomainError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise DomainError(
            "evidence_image_invalid",
            "The uploaded file is not a valid, complete JPEG or PNG image.",
            422,
        ) from exc

    return ValidatedImage(
        original=original,
        original_mime_type=actual_type,
        preview=preview,
    )


async def store_upload_pair(
    store: EvidenceStore,
    *,
    case_id: str,
    workflow_epoch: str,
    idempotency_key: str,
    upload: UploadFile,
    authorize_preview_for_model: bool,
    max_bytes: int,
    preview_max_edge: int,
) -> tuple[EvidenceRecord, EvidenceRecord]:
    if (
        not idempotency_key
        or idempotency_key != idempotency_key.strip()
        or len(idempotency_key) > 240
    ):
        raise DomainError(
            "evidence_idempotency_key_invalid",
            "Evidence idempotency keys must contain 1 to 240 non-padding characters.",
            422,
        )
    image = await validate_and_make_preview(
        upload,
        max_bytes=max_bytes,
        preview_max_edge=preview_max_edge,
    )
    pair_identity = _pair_identity(
        case_id=case_id,
        workflow_epoch=workflow_epoch,
        idempotency_key=idempotency_key,
    )
    key_hash = _key_hash(idempotency_key)
    fingerprint = _command_fingerprint(
        case_id=case_id,
        workflow_epoch=workflow_epoch,
        image=image,
        authorize_preview_for_model=authorize_preview_for_model,
    )
    original_id = _pair_record_id(pair_identity, "original")
    preview_id = _pair_record_id(pair_identity, "preview")
    created_at = utc_now()
    original = store.put(
        case_id=case_id,
        workflow_epoch=workflow_epoch,
        content=image.original,
        mime_type=image.original_mime_type,
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.ORIGINAL,
            transform=ORIGINAL_TRANSFORM,
        ),
        visibility=EvidenceVisibility.STAFF_ONLY,
        record_id=original_id,
        created_at=created_at,
        idempotency_key_hash=key_hash,
        command_fingerprint=fingerprint,
    )
    preview = store.put(
        case_id=case_id,
        workflow_epoch=workflow_epoch,
        content=image.preview,
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
        record_id=preview_id,
        created_at=created_at,
        idempotency_key_hash=key_hash,
        command_fingerprint=fingerprint,
    )
    return original, preview
