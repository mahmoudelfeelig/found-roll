"""The custody graph. Models and remote adapters never bypass this module."""

from __future__ import annotations

from .domain import CustodyState
from .errors import Conflict


ALLOWED_TRANSITIONS: dict[CustodyState, frozenset[CustodyState]] = {
    CustodyState.RECEIVED: frozenset({CustodyState.EVIDENCE_READY, CustodyState.SECURITY_ESCALATION}),
    CustodyState.EVIDENCE_READY: frozenset({CustodyState.ANALYZING}),
    CustodyState.ANALYZING: frozenset(
        {
            CustodyState.CANDIDATES_READY,
            CustodyState.SECURITY_ESCALATION,
            CustodyState.NO_MATCH,
            CustodyState.MANUAL_REVIEW,
        }
    ),
    CustodyState.CANDIDATES_READY: frozenset(
        {CustodyState.CLARIFICATION_REQUIRED, CustodyState.CLAIM_EVIDENCE_ACCEPTED}
    ),
    CustodyState.CLARIFICATION_REQUIRED: frozenset({CustodyState.ANALYZING}),
    CustodyState.CLAIM_EVIDENCE_ACCEPTED: frozenset({CustodyState.IDENTITY_ATTESTED}),
    CustodyState.IDENTITY_ATTESTED: frozenset(
        {CustodyState.APPROVAL_REQUIRED, CustodyState.RESERVE_REQUESTED}
    ),
    CustodyState.APPROVAL_REQUIRED: frozenset(
        {CustodyState.RESERVE_REQUESTED, CustodyState.REJECTED}
    ),
    CustodyState.RESERVE_REQUESTED: frozenset(
        {CustodyState.RESERVED, CustodyState.RECONCILIATION_REQUIRED}
    ),
    CustodyState.RESERVED: frozenset({CustodyState.CLAIMANT_PRESENT, CustodyState.EXPIRED}),
    CustodyState.CLAIMANT_PRESENT: frozenset({CustodyState.RELEASE_REQUESTED}),
    CustodyState.RELEASE_REQUESTED: frozenset(
        {CustodyState.RELEASED, CustodyState.RECONCILIATION_REQUIRED}
    ),
    CustodyState.RELEASED: frozenset({CustodyState.CLOSED}),
    CustodyState.MANUAL_REVIEW: frozenset({CustodyState.ANALYZING}),
    CustodyState.EXPIRED: frozenset({CustodyState.ANALYZING}),
    CustodyState.RECONCILIATION_REQUIRED: frozenset(
        {CustodyState.RESERVED, CustodyState.RELEASED}
    ),
    CustodyState.CLOSED: frozenset(),
    CustodyState.SECURITY_ESCALATION: frozenset(),
    CustodyState.NO_MATCH: frozenset(),
    CustodyState.REJECTED: frozenset(),
}


def assert_transition(
    current: CustodyState,
    target: CustodyState,
    *,
    allow_fact_event: bool = False,
) -> None:
    if current == target and allow_fact_event:
        return
    if target not in ALLOWED_TRANSITIONS[current]:
        raise Conflict(
            "invalid_transition",
            f"Custody state cannot move from {current.value} to {target.value}.",
        )
