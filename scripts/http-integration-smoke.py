"""Exercise one fresh custody-service to relay-simulator workflow over real HTTP."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


CASE_ID = "FR-20260829-0042"
SELECTED_ITEM_ID = "NA-PCH-231"
LOCAL_STAFF_TOKEN = "found-roll-local-staff-token"
LOCAL_SUPERVISOR_TOKEN = "found-roll-local-supervisor-token"


class HttpFailure(RuntimeError):
    def __init__(self, status: int, payload: Any, path: str) -> None:
        super().__init__(f"HTTP {status} from {path}: {json.dumps(payload, sort_keys=True)}")
        self.status = status
        self.payload = payload


def request_json(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> Any:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
            **(headers or {}),
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"body": raw}
        raise HttpFailure(error.code, parsed, path) from error
    except URLError as error:
        raise RuntimeError(f"Could not reach {base_url}{path}: {error.reason}") from error


def post(base_url: str, path: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> Any:
    return request_json(base_url, path, method="POST", payload=payload, headers=headers)


def key(label: str) -> str:
    return f"http-smoke:{label}:{uuid.uuid4()}"


def assert_state(response: dict[str, Any], expected: str) -> dict[str, Any]:
    case = response["case"]
    if case["state"] != expected:
        raise AssertionError(f"Expected {expected}; received {case['state']} at version {case['version']}")
    return case


def run(
    service_url: str,
    simulator_url: str,
    simulator_key: str,
    staff_token: str,
    supervisor_token: str,
) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    simulator_headers = {"Authorization": f"Bearer {simulator_key}"}
    staff_headers = {"X-Found-Roll-Staff-Token": staff_token}
    supervisor_headers = {"X-Found-Roll-Supervisor-Token": supervisor_token}

    service_health = request_json(service_url, "/api/v1/healthz")
    simulator_health = request_json(simulator_url, "/api/v1/healthz")
    if service_health.get("service") != "found-roll-custody":
        raise AssertionError("The service health response is not Found Roll custody.")
    if simulator_health.get("data", {}).get("service") != "found-roll-simulator":
        raise AssertionError("The simulator health response is not Found Roll simulator.")

    post(
        simulator_url,
        "/v1/admin/reset",
        {
            "confirmation": "RESET_SIMULATED_FIXTURE",
            "actor": "staff.northport",
            "reason": "Start one deterministic cross-service verification run.",
        },
        simulator_headers,
    )
    reset = post(service_url, "/api/v1/demo/reset", {})
    case = reset["case"]

    analysis = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/analysis-jobs",
        {"expected_version": case["version"], "idempotency_key": key("analysis")},
    )
    analyzed = post(service_url, "/tasks/outbox", analysis["task"]["payload"])
    case = assert_state(analyzed, "CLARIFICATION_REQUIRED")

    claim_link = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/claim-links",
        {"expected_version": case["version"], "idempotency_key": key("claim-link")},
        staff_headers,
    )

    claim = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/claim-evidence",
        {"expected_version": case["version"], "idempotency_key": key("claim"), "answer": "4118"},
        {"X-Found-Roll-Claim-Link": claim_link["token"]},
    )
    case = assert_state(claim, "CLAIM_EVIDENCE_ACCEPTED")

    identity = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/identity-attestations",
        {
            "expected_version": case["version"],
            "idempotency_key": key("identity"),
            "staff_user_id": "staff.northport",
            "method": "government_id_visual_check",
        },
        staff_headers,
    )
    case = assert_state(identity, "APPROVAL_REQUIRED")

    approval = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/approvals",
        {
            "expected_version": case["version"],
            "idempotency_key": key("approval"),
            "supervisor_user_id": "supervisor.northport",
            "approved": True,
            "reason": "Private evidence and staff attestation satisfy the valuable-item policy.",
        },
        supervisor_headers,
    )
    case = assert_state(approval, "APPROVAL_REQUIRED")

    candidates = request_json(
        service_url,
        f"/api/v1/passports/{CASE_ID}/candidates",
        headers=staff_headers,
    )["items"]
    selected = next(candidate for candidate in candidates if candidate["id"] == SELECTED_ITEM_ID)
    reservation = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/reservations",
        {
            "expected_version": case["version"],
            "idempotency_key": key("reserve"),
            "expected_remote_etag": selected["remote_etag"],
        },
    )
    reserved = post(service_url, "/tasks/outbox", reservation["task"]["payload"])
    case = assert_state(reserved, "RESERVED")

    issued = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/tokens",
        {"expected_version": case["version"], "idempotency_key": key("tokens")},
    )
    case = issued["case"]
    handoff = issued["handoff"]

    custodian = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/token-attestations",
        {
            "expected_version": case["version"],
            "idempotency_key": key("custodian-token"),
            "handoff_id": handoff["id"],
            "purpose": "CUSTODIAN",
            "token": issued["custodian_token"],
        },
    )
    case = custodian["case"]
    event_count_after_token = len(
        request_json(
            service_url,
            f"/api/v1/passports/{CASE_ID}/events",
            headers=staff_headers,
        )["items"]
    )
    try:
        post(
            service_url,
            f"/api/v1/passports/{CASE_ID}/token-attestations",
            {
                "expected_version": case["version"],
                "idempotency_key": key("custodian-token-replay"),
                "handoff_id": handoff["id"],
                "purpose": "CUSTODIAN",
                "token": issued["custodian_token"],
            },
        )
    except HttpFailure as error:
        if error.status not in {409, 422}:
            raise AssertionError(f"Consumed-token replay returned unexpected status {error.status}") from error
    else:
        raise AssertionError("The service accepted a consumed one-time credential.")
    if len(
        request_json(
            service_url,
            f"/api/v1/passports/{CASE_ID}/events",
            headers=staff_headers,
        )["items"]
    ) != event_count_after_token:
        raise AssertionError("Consumed-token replay appended an event.")

    claimant = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/token-attestations",
        {
            "expected_version": case["version"],
            "idempotency_key": key("claimant-token"),
            "handoff_id": handoff["id"],
            "purpose": "CLAIMANT",
            "token": issued["claimant_token"],
        },
    )
    case = assert_state(claimant, "CLAIMANT_PRESENT")

    release = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/releases",
        {
            "expected_version": case["version"],
            "idempotency_key": key("release"),
            "staff_user_id": "staff.northport",
        },
        staff_headers,
    )
    released = post(service_url, "/tasks/outbox", release["task"]["payload"])
    case = assert_state(released, "RELEASED")
    events_before_task_replay = request_json(
        service_url,
        f"/api/v1/passports/{CASE_ID}/events",
        headers=staff_headers,
    )
    replayed = post(service_url, "/tasks/outbox", release["task"]["payload"])
    if replayed.get("replayed") is not True:
        raise AssertionError("Completed outbox replay was not acknowledged idempotently.")
    events_after_task_replay = request_json(
        service_url,
        f"/api/v1/passports/{CASE_ID}/events",
        headers=staff_headers,
    )
    if len(events_before_task_replay["items"]) != len(events_after_task_replay["items"]):
        raise AssertionError("Completed outbox replay appended another event.")

    manifest = post(
        service_url,
        f"/api/v1/passports/{CASE_ID}/close",
        {"expected_version": case["version"], "idempotency_key": key("close")},
    )
    if manifest["final_state"] != "CLOSED" or manifest["internally_consistent"] is not True:
        raise AssertionError("The closed Item Passport manifest is not internally consistent.")
    if manifest["physical_transfer_proven"] is not False:
        raise AssertionError("The manifest overstated physical-transfer proof.")

    final_snapshot = request_json(
        service_url,
        f"/api/v1/passports/{CASE_ID}",
        headers=staff_headers,
    )
    final_events = request_json(
        service_url,
        f"/api/v1/passports/{CASE_ID}/events",
        headers=staff_headers,
    )
    if final_snapshot["case"]["state"] != "CLOSED" or final_events["hash_chain_valid"] is not True:
        raise AssertionError("The final service snapshot or event chain is invalid.")

    return {
        "result": "passed",
        "case_id": CASE_ID,
        "service_execution": final_snapshot["execution"],
        "final_state": final_snapshot["case"]["state"],
        "final_version": final_snapshot["case"]["version"],
        "event_count": len(final_events["items"]),
        "manifest_id": manifest["manifest_id"],
        "final_event_hash": manifest["final_event_hash"],
        "token_replay_rejected": True,
        "outbox_replay_idempotent": True,
        "physical_transfer_proven": False,
        "simulator_fixture_version": simulator_health["data"]["fixture_version"],
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-url", default="http://127.0.0.1:8080")
    parser.add_argument("--simulator-url", default="http://127.0.0.1:8091")
    parser.add_argument("--simulator-api-key", default=os.getenv("SIMULATOR_API_KEY"))
    parser.add_argument(
        "--service-staff-token",
        default=os.getenv("FOUND_ROLL_EVIDENCE_STAFF_TOKEN", LOCAL_STAFF_TOKEN),
    )
    parser.add_argument(
        "--service-supervisor-token",
        default=os.getenv("FOUND_ROLL_SUPERVISOR_TOKEN", LOCAL_SUPERVISOR_TOKEN),
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.simulator_api_key:
        parser.error("--simulator-api-key or SIMULATOR_API_KEY is required")
    receipt = run(
        args.service_url,
        args.simulator_url,
        args.simulator_api_key,
        args.service_staff_token,
        args.service_supervisor_token,
    )
    rendered = json.dumps(receipt, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
