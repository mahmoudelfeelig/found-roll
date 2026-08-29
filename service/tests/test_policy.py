from app.domain import PolicyOutcome, RiskTier
from app.fixtures import fixture_case
from app.policy import evaluate_release_policy, specialist_intake_guidance


def test_visual_similarity_never_allows_handoff():
    case = fixture_case().model_copy(
        update={
            "candidate_ids": ["NA-PCH-231"],
            "selected_item_id": "NA-PCH-231",
            "accepted_claim_evidence": False,
            "identity_attestation_ref": "attestation-present",
            "approval_ref": "approval-present",
        }
    )
    decision = evaluate_release_policy(case)
    assert decision.outcome == PolicyOutcome.REQUEST_EVIDENCE
    assert "private_claim_evidence_missing" in decision.reason_codes


def test_valuable_item_requires_identity_and_approval():
    case = fixture_case().model_copy(update={"accepted_claim_evidence": True})
    assert evaluate_release_policy(case).outcome == PolicyOutcome.REQUIRE_REVIEW
    case = case.model_copy(update={"identity_attestation_ref": "identity-att"})
    assert evaluate_release_policy(case).outcome == PolicyOutcome.REQUIRE_REVIEW
    case = case.model_copy(update={"approval_ref": "approval-att"})
    assert evaluate_release_policy(case).outcome == PolicyOutcome.ALLOW_HANDOFF


def test_sensitive_and_dangerous_tiers_are_denied():
    for tier in (RiskTier.SENSITIVE, RiskTier.DANGEROUS):
        case = fixture_case().model_copy(
            update={
                "risk_tier": tier,
                "accepted_claim_evidence": True,
                "identity_attestation_ref": "identity-att",
                "approval_ref": "approval-att",
            }
        )
        assert evaluate_release_policy(case).outcome == PolicyOutcome.DENY


def test_four_incorrect_answers_force_review():
    case = fixture_case().model_copy(update={"wrong_answer_count": 4})
    decision = evaluate_release_policy(case)
    assert decision.outcome == PolicyOutcome.REQUIRE_REVIEW
    assert "too_many_incorrect_private_answers" in decision.reason_codes


def test_sensitive_categories_get_specific_no_upload_routing_and_retention_guidance():
    expected_routes = {
        "passport": "government_document",
        "payment_card": "payment_instrument",
        "access_badge": "access_credential",
        "medication": "medication",
        "suspicious_package": "dangerous_or_suspicious",
    }
    for category, route_kind in expected_routes.items():
        guidance = specialist_intake_guidance(category, "northport-air")
        assert guidance["route_kind"] == route_kind
        assert guidance["upload_allowed"] is False
        assert guidance["model_allowed"] is False
        assert "Northport Air" in guidance["next_action"] or category == "suspicious_package"
        assert len(guidance["retention_guidance"]) >= 30
