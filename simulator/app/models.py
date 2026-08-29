"""Versioned request schemas for the simulator boundary."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


Identifier = Annotated[str, Field(min_length=2, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")]
IdempotencyKey = Annotated[
    str,
    Field(min_length=8, max_length=256, pattern=r"^[A-Za-z0-9._:-]+$"),
]
Etag = Annotated[str, Field(min_length=8, max_length=256)]
Actor = Annotated[str, Field(min_length=2, max_length=128)]
Reason = Annotated[str, Field(min_length=3, max_length=512)]
EvidenceRefs = Annotated[list[Identifier], Field(min_length=1, max_length=24)]


class StrictRequest(BaseModel):
    """Reject undeclared data at a custody-changing boundary."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ReservationCreateRequest(StrictRequest):
    case_id: Identifier
    case_version: Annotated[int, Field(ge=1)]
    custodian_id: Identifier
    item_id: Identifier
    expected_item_version: Annotated[int, Field(ge=1)]
    expected_item_etag: Etag
    destination: Annotated[str, Field(min_length=3, max_length=160)]
    expires_at: datetime
    actor: Actor
    reason: Reason
    evidence_refs: EvidenceRefs
    idempotency_key: IdempotencyKey


class ReservationBoundRequest(StrictRequest):
    case_id: Identifier
    case_version: Annotated[int, Field(ge=1)]
    item_id: Identifier
    custodian_id: Identifier
    expected_reservation_version: Annotated[int, Field(ge=1)]
    expected_reservation_etag: Etag
    actor: Actor
    reason: Reason
    evidence_refs: EvidenceRefs
    idempotency_key: IdempotencyKey


class CredentialIssueRequest(ReservationBoundRequest):
    token_expires_at: datetime


class TokenAttestationRequest(ReservationBoundRequest):
    role: Literal["CUSTODIAN", "CLAIMANT"]
    token: Annotated[str, Field(min_length=20, max_length=512)]


class HandoffAttestationRequest(ReservationBoundRequest):
    pass


class ResetRequest(StrictRequest):
    confirmation: Literal["RESET_SIMULATED_FIXTURE"]
    actor: Actor
    reason: Reason
