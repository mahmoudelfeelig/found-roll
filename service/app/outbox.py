"""Opaque Cloud Tasks payloads and task publication."""

from __future__ import annotations

import json
from typing import Any, Protocol
from uuid import NAMESPACE_URL, uuid5

from .config import Settings
from .domain import CaseRecord, OpaqueTaskPayload, OutboxKind, OutboxRecord
from .errors import Unavailable


def make_outbox(kind: OutboxKind, case: CaseRecord, *, created_at) -> OutboxRecord:
    digest = uuid5(
        NAMESPACE_URL,
        f"found-roll:{case.id}:{case.workflow_epoch}:{kind.value}:{case.version + 1}",
    ).hex
    outbox_id = f"out-{digest[:24]}"
    return OutboxRecord(
        id=outbox_id,
        task_name=f"fr-{kind.value.lower().replace('_', '-')}-{digest[:20]}",
        kind=kind,
        case_id=case.id,
        expected_case_version=case.version + 1,
        created_at=created_at,
    )


def opaque_payload(outbox: OutboxRecord) -> OpaqueTaskPayload:
    return OpaqueTaskPayload(case_id=outbox.case_id, outbox_id=outbox.id)


class TaskPublisher(Protocol):
    def publish(self, outbox: OutboxRecord) -> dict[str, Any]: ...

    def publish_replay(self, outbox: OutboxRecord, idempotency_key: str) -> dict[str, Any]: ...


def replay_task_name(outbox: OutboxRecord, idempotency_key: str) -> str:
    digest = uuid5(
        NAMESPACE_URL,
        f"found-roll:replay:{outbox.id}:{idempotency_key}",
    ).hex
    return f"fr-replay-{digest[:20]}"


class InlineTaskPublisher:
    """Returns an explicit local task receipt without pretending it was queued."""

    def publish(self, outbox: OutboxRecord) -> dict[str, Any]:
        return {
            "queued": False,
            "mode": "inline",
            "task_name": outbox.task_name,
            "payload": opaque_payload(outbox).model_dump(mode="json"),
        }

    def publish_replay(self, outbox: OutboxRecord, idempotency_key: str) -> dict[str, Any]:
        return {
            "queued": False,
            "mode": "inline",
            "task_name": replay_task_name(outbox, idempotency_key),
            "payload": opaque_payload(outbox).model_dump(mode="json"),
        }


class CloudTasksPublisher:
    def __init__(self, settings: Settings) -> None:
        try:
            from google.cloud import tasks_v2
            from google.api_core.exceptions import AlreadyExists
        except ImportError as exc:  # pragma: no cover - requires cloud extras
            raise Unavailable(
                "cloud_tasks_dependency_missing",
                "Install google-cloud-tasks to publish background work.",
            ) from exc
        if not settings.google_cloud_project:
            raise Unavailable("cloud_project_missing", "GOOGLE_CLOUD_PROJECT is required for Cloud Tasks.")
        self._tasks = tasks_v2
        self._already_exists = AlreadyExists
        self._client = tasks_v2.CloudTasksClient()
        self._settings = settings

    def _publish_named(self, outbox: OutboxRecord, task_name: str) -> dict[str, Any]:
        parent = self._client.queue_path(
            self._settings.google_cloud_project,
            self._settings.task_location,
            self._settings.task_queue,
        )
        task_path = self._client.task_path(
            self._settings.google_cloud_project,
            self._settings.task_location,
            self._settings.task_queue,
            task_name,
        )
        request: dict[str, Any] = {
            "name": task_path,
            "dispatch_deadline": {
                "seconds": self._settings.task_dispatch_deadline_seconds,
            },
            "http_request": {
                "http_method": self._tasks.HttpMethod.POST,
                "url": f"{self._settings.public_base_url}/tasks/outbox",
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps(
                    opaque_payload(outbox).model_dump(mode="json"), separators=(",", ":")
                ).encode("utf-8"),
            },
        }
        if self._settings.task_service_account:
            request["http_request"]["oidc_token"] = {
                "service_account_email": self._settings.task_service_account,
                "audience": self._settings.public_base_url,
            }
        try:
            created = self._client.create_task(parent=parent, task=request)
        except self._already_exists:
            # Deterministic task names make an ambiguous first enqueue safe to retry.
            return {
                "queued": True,
                "mode": "cloud_tasks",
                "task_name": task_path,
                "idempotent_replay": True,
            }
        return {
            "queued": True,
            "mode": "cloud_tasks",
            "task_name": created.name,
            "idempotent_replay": False,
        }

    def publish(self, outbox: OutboxRecord) -> dict[str, Any]:
        return self._publish_named(outbox, outbox.task_name)

    def publish_replay(self, outbox: OutboxRecord, idempotency_key: str) -> dict[str, Any]:
        return self._publish_named(outbox, replay_task_name(outbox, idempotency_key))
