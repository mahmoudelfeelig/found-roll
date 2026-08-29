import pytest

from app.custody_service import CustodyService
from app.errors import Conflict


def test_seed_event_chain_is_valid(app, case_id):
    service: CustodyService = app.state.custody_service
    assert service.verify_event_chain(case_id) is True
    events = service.repository.list_events(case_id)
    assert events[0].previous_hash == "0" * 64
    assert len(events[0].event_hash) == 64


def test_event_chain_detects_application_store_tampering(app, case_id):
    service: CustodyService = app.state.custody_service
    repo = service.repository
    original = repo._events[case_id][0]
    repo._events[case_id][0] = original.model_copy(update={"reason": "tampered"})
    with pytest.raises(Conflict, match="internally inconsistent"):
        service.verify_event_chain(case_id)
