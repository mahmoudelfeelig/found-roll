from conftest import STAFF_HEADERS, begin_and_process_analysis, issue_claim_link, reach_approved


PRIVATE_ANSWER = "4118"
OPAQUE_PRIVATE_FIELD_SUFFIXES = (
    "_at",
    "_at_utc",
    "_digest",
    "_digests",
    "_etag",
    "_generation",
    "_generations",
    "_hash",
    "_hashes",
    "_id",
    "_ids",
    "_sha",
    "_sha256",
    "_utc",
)
OPAQUE_PRIVATE_FIELD_NAMES = {
    "checksum",
    "digest",
    "etag",
    "generation",
    "hash",
    "id",
    "sha256",
    "evidence_digests",
    "idempotency_key",
    "last_replay_task_name",
    "project_number",
    "release_task_name",
    "submitted_commit",
    "task_name",
    "workflow_epoch",
}
REFERENCE_PRIVATE_FIELD_SUFFIXES = (
    "_bucket",
    "_file",
    "_namespace",
    "_origin",
    "_package",
    "_path",
    "_ref",
    "_refs",
    "_resource",
    "_resources",
    "_revision",
    "_uri",
    "_url",
)
REFERENCE_PRIVATE_FIELD_NAMES = {
    "bucket",
    "entrypoint",
    "evidence_refs",
    "firestore_namespace",
    "origin",
    "package",
    "path",
    "render",
    "renderer",
    "repository",
    "resource",
    "revision",
    "source",
    "source_file",
    "uri",
    "url",
}


def private_field_mode(field_name):
    if field_name in REFERENCE_PRIVATE_FIELD_NAMES or field_name.endswith(REFERENCE_PRIVATE_FIELD_SUFFIXES):
        return "reference"
    if field_name in OPAQUE_PRIVATE_FIELD_NAMES or field_name.endswith(OPAQUE_PRIVATE_FIELD_SUFFIXES):
        return "opaque"
    return "semantic"


def scalar_contains_private_value(value, token, mode):
    if mode == "opaque":
        return value == token
    if mode == "semantic":
        return token in value
    start = 0
    while True:
        index = value.find(token, start)
        if index < 0:
            return False
        end = index + len(token)
        if (index == 0 or not value[index - 1].isalnum()) and (
            end == len(value) or not value[end].isalnum()
        ):
            return True
        start = index + 1


def surface_contains_private_value(value, token, *, mode="semantic"):
    if isinstance(value, dict):
        return any(
            scalar_contains_private_value(str(key), token, "semantic")
            or surface_contains_private_value(
                child, token, mode=private_field_mode(str(key))
            )
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(
            surface_contains_private_value(child, token, mode=mode)
            for child in value
        )
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return str(value) == token
    if not isinstance(value, str):
        return False
    return scalar_contains_private_value(value, token, mode)


def test_private_surface_check_distinguishes_opaque_collision_from_semantic_echo():
    assert private_field_mode("cloud_build_asset_snapshot_before_utc") == "opaque"
    assert private_field_mode("cloud_build_asset_snapshot_after_utc") == "opaque"
    assert private_field_mode("image_resources") == "reference"
    assert private_field_mode("package") == "reference"
    assert private_field_mode("image_package") == "reference"
    assert surface_contains_private_value(
        {
            "event_hash": f"abc{PRIVATE_ANSWER}def",
            "evidence_digests": [f"abc{PRIVATE_ANSWER}def"],
            "idempotency_key": f"idem-abc{PRIVATE_ANSWER}def",
            "last_replay_task_name": f"replay-abc{PRIVATE_ANSWER}def",
            "occurred_at": f"2026-08-30T03:{PRIVATE_ANSWER}:00Z",
            "original_generation": f"gen-abc{PRIVATE_ANSWER}def",
            "preview_generation": f"gen-abc{PRIVATE_ANSWER}def",
            "release_task_name": f"release-abc{PRIVATE_ANSWER}def",
            "sha256": f"abc{PRIVATE_ANSWER}def",
            "task_name": f"task-abc{PRIVATE_ANSWER}def",
            "workflow_epoch": f"epoch-abc{PRIVATE_ANSWER}def",
            "evidence_refs": [f"ref://item/abc{PRIVATE_ANSWER}def"],
            "bytes": int(f"14{PRIVATE_ANSWER}"),
            "app_origin": f"https://abc{PRIVATE_ANSWER}def.example",
            "app_revision": f"found-roll-app-abc{PRIVATE_ANSWER}def",
            "commit_sha": f"abc{PRIVATE_ANSWER}def",
            "project_created_at_utc": f"2026-08-30T03:{PRIVATE_ANSWER}:00Z",
            "cloud_build_asset_snapshot_before_utc": f"2026-08-30T03:{PRIVATE_ANSWER}:00Z",
            "cloud_build_asset_snapshot_after_utc": f"2026-08-30T04:{PRIVATE_ANSWER}:00Z",
            "project_number": f"106{PRIVATE_ANSWER}7746",
            "revision": f"revision-abc{PRIVATE_ANSWER}def",
            "revision_resource": f"projects/abc{PRIVATE_ANSWER}def/revisions/current",
            "service_resource": f"projects/abc{PRIVATE_ANSWER}def/services/found-roll",
            "image_resources": [
                f"us-central1-docker.pkg.dev/project/repository/abc{PRIVATE_ANSWER}def@sha256:abcdef"
            ],
            "package": f"us-central1-docker.pkg.dev/project/repository/abc{PRIVATE_ANSWER}def",
            "image_package": f"us-central1-docker.pkg.dev/project/repository/abc{PRIVATE_ANSWER}def",
            "submitted_commit": f"abc{PRIVATE_ANSWER}def",
            "tree_sha": f"abc{PRIVATE_ANSWER}def",
        },
        PRIVATE_ANSWER,
    ) is False
    assert surface_contains_private_value(
        {"reason": f"private-answer-{PRIVATE_ANSWER}-was-rejected"},
        PRIVATE_ANSWER,
    ) is True
    assert surface_contains_private_value(
        {f"private-{PRIVATE_ANSWER}-field": "redacted"},
        PRIVATE_ANSWER,
    ) is True
    assert surface_contains_private_value(
        {"evidence_refs": [f"ref://item/{PRIVATE_ANSWER}"]},
        PRIVATE_ANSWER,
    ) is True
    assert surface_contains_private_value({"bytes": int(PRIVATE_ANSWER)}, PRIVATE_ANSWER) is True
    assert surface_contains_private_value({"project_number": PRIVATE_ANSWER}, PRIVATE_ANSWER) is True
    for private_surface in (
        {"cloud_build_asset_snapshot_before_utc": PRIVATE_ANSWER},
        {"cloud_build_asset_snapshot_after_utc": PRIVATE_ANSWER},
        {"image_resources": [f"pkg/{PRIVATE_ANSWER}@sha256:abcdef"]},
        {"package": f"pkg/{PRIVATE_ANSWER}"},
        {"image_package": f"pkg/{PRIVATE_ANSWER}"},
    ):
        assert surface_contains_private_value(private_surface, PRIVATE_ANSWER) is True


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
        assert surface_contains_private_value(response.json(), PRIVATE_ANSWER) is False
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
    wrong_answers = [f"nope-{attempt}" for attempt in range(1, 5)]
    for attempt, wrong_answer in enumerate(wrong_answers, start=1):
        response = client.post(
            f"/api/v1/passports/{case_id}/claim-evidence",
            json={
                "expected_version": version,
                "idempotency_key": f"wrong-answer-{attempt:03d}",
                "answer": wrong_answer,
            },
            headers={"X-Found-Roll-Claim-Link": claim_link["token"]},
        )
        assert response.status_code == 200, response.text
        version = response.json()["case"]["version"]
        if response.json()["case"]["state"] == "CLARIFICATION_REQUIRED":
            claim_link = response.json()["replacement_claim_link"]
    assert response.json()["case"]["state"] == "MANUAL_REVIEW"
    event_response = client.get(f"/api/v1/passports/{case_id}/events")
    event_body = event_response.json()
    assert surface_contains_private_value(event_body, PRIVATE_ANSWER) is False
    assert all(
        surface_contains_private_value(event_body, wrong_answer) is False
        for wrong_answer in wrong_answers
    )


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
