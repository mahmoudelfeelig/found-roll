"""Exercise the service inventory gateway against a real loopback simulator socket."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "service"))

from app.config import Settings  # noqa: E402
from app.fixtures import DEMO_PRIVATE_ANSWER, fixture_candidates  # noqa: E402
from app.inventory import HttpInventoryGateway  # noqa: E402


ALLOWED_CANDIDATE_FIELDS = {
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--simulator-url", required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def assert_safe_candidate(row: dict[str, Any]) -> None:
    if set(row) != ALLOWED_CANDIDATE_FIELDS:
        extra = sorted(set(row) - ALLOWED_CANDIDATE_FIELDS)
        missing = sorted(ALLOWED_CANDIDATE_FIELDS - set(row))
        raise AssertionError(
            f"Inventory gateway field contract changed; extra={extra}, missing={missing}."
        )


def main() -> int:
    args = parse_args()
    settings = Settings(
        inventory_mode="http",
        inventory_base_url=args.simulator_url,
        inventory_timeout_seconds=3.0,
    )
    settings.validate()
    gateway = HttpInventoryGateway(settings)
    candidates = fixture_candidates("loopback-inventory-smoke-pepper")

    observed_ids: list[str] = []
    for tenant_id in sorted({candidate.tenant_id for candidate in candidates}):
        result = gateway.search_custodian(tenant_id, candidates)
        if result.get("source") != "simulator_http":
            raise AssertionError("Inventory search did not use the simulator HTTP source.")
        if result.get("restricted_fields_included") is not False:
            raise AssertionError("Inventory search did not explicitly exclude restricted fields.")
        rows = result.get("candidates", [])
        expected = sorted(
            candidate.id for candidate in candidates if candidate.tenant_id == tenant_id
        )
        if sorted(row.get("id") for row in rows) != expected:
            raise AssertionError(f"Inventory scope mismatch for tenant {tenant_id}.")
        for row in rows:
            assert_safe_candidate(row)
            observed_ids.append(row["id"])

    for candidate in candidates:
        loaded = gateway.load_candidate(candidate.id, candidates)
        assert_safe_candidate(loaded)
        if loaded["id"] != candidate.id or loaded["tenant_id"] != candidate.tenant_id:
            raise AssertionError("Loaded inventory item escaped its authorized candidate scope.")

    unauthorized_tenant = gateway.search_custodian("outside-authorized-network", candidates)
    unauthorized_candidate = gateway.load_candidate("OUTSIDE-CANDIDATE", candidates)
    if unauthorized_tenant.get("error") != "tenant_not_authorized":
        raise AssertionError("Unauthorized tenant search did not fail closed.")
    if unauthorized_candidate.get("error") != "candidate_not_authorized":
        raise AssertionError("Unauthorized candidate load did not fail closed.")

    receipt = {
        "schema_version": "1",
        "result": "passed",
        "run_id": str(uuid4()),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "transport": "real_loopback_http",
        "gateway_mode": gateway.mode,
        "simulator_disclosure_required": "SIMULATED",
        "authorized_tenant_count": len({candidate.tenant_id for candidate in candidates}),
        "authorized_candidate_ids": sorted(observed_ids),
        "restricted_fields_included": False,
        "unauthorized_tenant_denied": True,
        "unauthorized_candidate_denied": True,
    }
    rendered = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    if DEMO_PRIVATE_ANSWER in rendered:
        raise AssertionError("The inventory receipt contains the private fixture answer.")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
