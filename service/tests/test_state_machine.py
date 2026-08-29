import pytest

from app.domain import CustodyState
from app.errors import Conflict
from app.state_machine import ALLOWED_TRANSITIONS, assert_transition


def test_every_declared_transition_is_accepted():
    for source, targets in ALLOWED_TRANSITIONS.items():
        for target in targets:
            assert_transition(source, target)


def test_release_cannot_skip_policy_and_handoff_states():
    forbidden_sources = [
        CustodyState.RECEIVED,
        CustodyState.CANDIDATES_READY,
        CustodyState.CLAIM_EVIDENCE_ACCEPTED,
        CustodyState.APPROVAL_REQUIRED,
        CustodyState.RESERVED,
    ]
    for source in forbidden_sources:
        with pytest.raises(Conflict, match="cannot move"):
            assert_transition(source, CustodyState.RELEASED)


def test_same_state_requires_explicit_fact_event():
    with pytest.raises(Conflict):
        assert_transition(CustodyState.RESERVED, CustodyState.RESERVED)
    assert_transition(CustodyState.RESERVED, CustodyState.RESERVED, allow_fact_event=True)
