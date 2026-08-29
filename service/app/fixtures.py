"""Synthetic, explicitly fictional camera-pouch fixture."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from .domain import Candidate, CaseRecord, CustodyState, RiskTier
from .hashing import secret_digest
from .repository import Repository


DEMO_CASE_ID = "FR-20260829-0042"
DEMO_PRIVATE_ANSWER = "4118"
DEMO_PRIVATE_ATTRIBUTE_ID = "lens_serial_last4"
FIXTURE_DISCLOSURE = (
    "Grand Hall, Metro Loop, Northport Air, their inventories, and Relay Post are fictional. "
    "All case data is synthetic. Relay attestations are SIMULATED service events and do not prove physical possession."
)


def fixture_candidates(pepper: str) -> list[Candidate]:
    restricted_hash = secret_digest(DEMO_PRIVATE_ANSWER, pepper)
    return [
        Candidate(
            id="GH-PCH-104",
            tenant_id="grand-hall",
            tenant_name="Grand Hall",
            category="camera_pouch",
            coarse_description="Compact black padded camera pouch with a top zip.",
            found_at=datetime(2026, 8, 28, 18, 42, tzinfo=timezone.utc),
            found_zone="Coat Check B",
            public_signals=["black woven shell", "single top zip"],
            route_compatible=True,
            time_compatible=False,
            visible_signal_count=1,
            frozen_score=0.61,
            remote_etag='"gh-104-v3"',
            remote_version=3,
        ),
        Candidate(
            id="ML-PCH-219",
            tenant_id="metro-loop",
            tenant_name="Metro Loop",
            category="camera_pouch",
            coarse_description="Small black camera pouch with a grey zipper pull.",
            found_at=datetime(2026, 8, 28, 20, 15, tzinfo=timezone.utc),
            found_zone="Blue Line car 714",
            public_signals=["grey zipper pull", "rounded lid"],
            route_compatible=True,
            time_compatible=True,
            visible_signal_count=1,
            frozen_score=0.72,
            remote_etag='"ml-219-v2"',
            remote_version=2,
        ),
        Candidate(
            id="NA-PCH-231",
            tenant_id="northport-air",
            tenant_name="Northport Air",
            category="camera_pouch",
            coarse_description="Compact black padded camera pouch with a grey pull and repaired corner seam.",
            found_at=datetime(2026, 8, 28, 21, 7, tzinfo=timezone.utc),
            found_zone="Terminal C security return",
            public_signals=["grey zipper pull", "repaired lower corner seam"],
            route_compatible=True,
            time_compatible=True,
            visible_signal_count=2,
            frozen_score=0.86,
            remote_etag='"na-231-v5"',
            remote_version=5,
            restricted_attribute_id=DEMO_PRIVATE_ATTRIBUTE_ID,
            restricted_value_hash=restricted_hash,
        ),
    ]


def fixture_case() -> CaseRecord:
    return CaseRecord(
        id=DEMO_CASE_ID,
        workflow_epoch=uuid4().hex,
        state=CustodyState.RECEIVED,
        version=0,
        category="camera_pouch",
        risk_tier=RiskTier.VALUABLE,
        assigned_tenant="northport-air",
        current_holder="Northport Air secure dropbox",
        public_description="Black padded camera pouch found after a venue-to-transit-to-airport route.",
        found_at=datetime(2026, 8, 28, 21, 7, tzinfo=timezone.utc),
        found_zone="Terminal C security return",
        report_route=["Grand Hall", "Metro Loop Blue Line", "Northport Air Terminal C"],
    )


def reset_demo_repository(repo: Repository, pepper: str) -> None:
    repo.replace_synthetic_fixture(
        fixture_case(),
        fixture_candidates(pepper),
        actor="fixture:system",
        reason=(
            "Created a synthetic Item Passport after the ordinary-item safety screen. "
            "No physical possession or ownership claim is made."
        ),
        idempotency_key="fixture:camera-pouch:create:v1",
        occurred_at=datetime(2026, 8, 29, 9, 0, tzinfo=timezone.utc),
    )
