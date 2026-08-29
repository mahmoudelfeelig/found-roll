import re

from conftest import STAFF_HEADERS, begin_and_process_analysis, issue_claim_link, reach_approved


PRIVATE_ANSWER_PATTERN = re.compile(r"(?<!\d)4118(?!\d)")


def test_dangerous_pre_intake_creates_no_record_or_model_call(client):
    before = client.get("/api/v1/passports").json()["items"]
    response = client.post(
        "/api/v1/intakes",
        json={
            "safety_result": "SUSPICIOUS_OR_DANGEROUS",
            "category": "suspicious_package",
            "risk_tier": "DANGEROUS",
            "assigned_tenant": "northport-air",
            "current_holder": "Unmoved at discovery point",
            "public_description": "This text must never become an intake record.",
            "found_at": "2026-08-29T10:00:00Z",
            "found_zone": "Terminal C",
            "report_route": ["Terminal C"],
            "actor": "staff.northport",
            "idempotency_key": "danger-screen-001",
        },
        headers=STAFF_HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is False
    assert body["record_created"] is False
    assert body["model_called"] is False
    assert body["guidance"]["route_kind"] == "dangerous_or_suspicious"
    assert body["guidance"]["upload_allowed"] is False
    assert len(client.get("/api/v1/passports").json()["items"]) == len(before)


def test_sensitive_intake_returns_category_and_tenant_specific_guidance_without_a_record(client):
    before = client.get("/api/v1/passports").json()["items"]
    response = client.post(
        "/api/v1/intakes",
        json={
            "safety_result": "ORDINARY_ITEM",
            "category": "payment_card",
            "risk_tier": "SENSITIVE",
            "assigned_tenant": "metro-loop",
            "current_holder": "Metro Loop property desk",
            "public_description": "Sensitive payment instrument must not enter ordinary recovery.",
            "found_at": "2026-08-29T10:00:00Z",
            "found_zone": "Blue Line platform",
            "report_route": ["Metro Loop"],
            "actor": "staff.northport",
            "idempotency_key": "sensitive-route-001",
        },
        headers=STAFF_HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is False
    assert body["record_created"] is False
    assert body["model_called"] is False
    assert body["guidance"]["route_kind"] == "payment_instrument"
    assert "Metro Loop" in body["guidance"]["next_action"]
    assert "PAN" in body["guidance"]["retention_guidance"]
    assert len(client.get("/api/v1/passports").json()["items"]) == len(before)


def test_known_specialist_category_cannot_be_downgraded_by_caller_supplied_risk(client):
    before = client.get("/api/v1/passports").json()["items"]
    response = client.post(
        "/api/v1/intakes",
        json={
            "safety_result": "ORDINARY_ITEM",
            "category": "passport",
            "risk_tier": "VALUABLE",
            "assigned_tenant": "northport-air",
            "current_holder": "Northport Air property desk",
            "public_description": "Caller attempts to classify a passport as an ordinary valuable.",
            "found_at": "2026-08-29T10:00:00Z",
            "found_zone": "Terminal C",
            "report_route": ["Northport Air"],
            "actor": "staff.northport",
            "idempotency_key": "sensitive-downgrade-001",
        },
        headers=STAFF_HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is False
    assert body["record_created"] is False
    assert body["model_called"] is False
    assert body["guidance"]["route_kind"] == "government_document"
    assert len(client.get("/api/v1/passports").json()["items"]) == len(before)


def test_specialist_aliases_and_unknown_categories_fail_closed(client):
    before = len(client.get("/api/v1/passports").json()["items"])
    expectations = {
        "credit_card": "payment_instrument",
        "id_card": "government_document",
        "passport_book": "government_document",
        "prescription_medication": "medication",
        "unclassified_sensitive_property": "specialist_review",
    }
    for index, (category, route_kind) in enumerate(expectations.items(), start=1):
        response = client.post(
            "/api/v1/intakes",
            json={
                "safety_result": "ORDINARY_ITEM",
                "category": category,
                "risk_tier": "VALUABLE",
                "assigned_tenant": "northport-air",
                "current_holder": "Northport Air property desk",
                "public_description": "Synthetic category-alias fail-closed verification input.",
                "found_at": "2026-08-29T10:00:00Z",
                "found_zone": "Terminal C",
                "report_route": ["Northport Air"],
                "actor": "staff.northport",
                "idempotency_key": f"category-alias-stop-{index:03d}",
            },
            headers=STAFF_HEADERS,
        )
        assert response.status_code == 200
        body = response.json()
        assert body["accepted"] is False
        assert body["record_created"] is False
        assert body["model_called"] is False
        assert body["guidance"]["route_kind"] == route_kind
    assert len(client.get("/api/v1/passports").json()["items"]) == before


def test_intake_actor_is_bound_to_the_authenticated_staff_role(client):
    before = client.get("/api/v1/passports").json()["items"]
    response = client.post(
        "/api/v1/intakes",
        json={
            "safety_result": "ORDINARY_ITEM",
            "category": "camera_pouch",
            "risk_tier": "VALUABLE",
            "assigned_tenant": "northport-air",
            "current_holder": "Northport Air property desk",
            "public_description": "Synthetic camera pouch for actor-binding verification.",
            "found_at": "2026-08-29T10:00:00Z",
            "found_zone": "Terminal C",
            "report_route": ["Northport Air"],
            "actor": "supervisor.northport",
            "idempotency_key": "intake-actor-forgery-001",
        },
        headers=STAFF_HEADERS,
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "staff_actor_mismatch"
    assert len(client.get("/api/v1/passports").json()["items"]) == len(before)


def test_candidate_and_case_surfaces_never_reveal_private_answer(client, case_id):
    begin_and_process_analysis(client, case_id)
    for endpoint in (
        f"/api/v1/passports/{case_id}",
        f"/api/v1/passports/{case_id}/candidates",
        f"/api/v1/passports/{case_id}/events",
        "/api/v1/demo/snapshot",
    ):
        response = client.get(endpoint)
        assert response.status_code == 200
        text = response.text.lower()
        assert PRIVATE_ANSWER_PATTERN.search(text) is None
        assert "restricted_value_hash" not in text
        assert "claimant_token_hash" not in text
        assert "custodian_token_hash" not in text


def test_cannot_reserve_on_visual_evidence_or_before_human_gates(client, case_id):
    begin_and_process_analysis(client, case_id)
    blocked = client.post(
        f"/api/v1/passports/{case_id}/reservations",
        json={
            "expected_version": 5,
            "idempotency_key": "premature-reserve-001",
            "expected_remote_etag": '"na-231-v5"',
        },
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "reservation_not_allowed"

    claim_link = issue_claim_link(
        client,
        case_id,
        expected_version=5,
        idempotency_key="claim-link-no-human-001",
    )
    accepted = client.post(
        f"/api/v1/passports/{case_id}/claim-evidence",
        json={"expected_version": 5, "idempotency_key": "claim-no-human-001", "answer": "4118"},
        headers={"X-Found-Roll-Claim-Link": claim_link["token"]},
    )
    assert accepted.status_code == 200
    still_blocked = client.post(
        f"/api/v1/passports/{case_id}/reservations",
        json={
            "expected_version": 8,
            "idempotency_key": "premature-reserve-002",
            "expected_remote_etag": '"na-231-v5"',
        },
    )
    assert still_blocked.status_code == 409


def test_repeated_wrong_answers_enter_manual_review_without_answer_leak(client, case_id):
    begin_and_process_analysis(client, case_id)
    version = 5
    claim_link = issue_claim_link(
        client,
        case_id,
        expected_version=version,
        idempotency_key="wrong-answer-link-001",
    )
    for attempt in range(1, 5):
        response = client.post(
            f"/api/v1/passports/{case_id}/claim-evidence",
            json={
                "expected_version": version,
                "idempotency_key": f"wrong-answer-{attempt:03d}",
                "answer": f"nope-{attempt}",
            },
            headers={"X-Found-Roll-Claim-Link": claim_link["token"]},
        )
        assert response.status_code == 200, response.text
        version = response.json()["case"]["version"]
        if response.json()["case"]["state"] == "CLARIFICATION_REQUIRED":
            claim_link = response.json()["replacement_claim_link"]
    assert response.json()["case"]["state"] == "MANUAL_REVIEW"
    assert PRIVATE_ANSWER_PATTERN.search(
        client.get(f"/api/v1/passports/{case_id}/events").text
    ) is None


def test_stale_case_version_is_rejected(client, case_id):
    begin_and_process_analysis(client, case_id)
    claim_link = issue_claim_link(
        client,
        case_id,
        expected_version=5,
        idempotency_key="stale-claim-link-001",
    )
    stale = client.post(
        f"/api/v1/passports/{case_id}/claim-evidence",
        json={"expected_version": 1, "idempotency_key": "stale-claim-001", "answer": "0000"},
        headers={"X-Found-Roll-Claim-Link": claim_link["token"]},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_case_version"


def test_validation_error_does_not_echo_token_value(client, case_id):
    secret_value = "this-token-must-not-be-echoed"
    response = client.post(
        f"/api/v1/passports/{case_id}/token-attestations",
        json={
            "expected_version": -1,
            "idempotency_key": "bad-token-request-001",
            "handoff_id": "short",
            "purpose": "CLAIMANT",
            "token": secret_value,
        },
    )
    assert response.status_code == 422
    assert secret_value not in response.text
