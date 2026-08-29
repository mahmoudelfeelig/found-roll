"""Deterministic release policy. Model confidence is deliberately absent."""

from __future__ import annotations

from .domain import CaseRecord, PolicyDecision, PolicyOutcome, RiskTier


POLICY_VERSION = "found-roll-release-v1"

SPECIALIST_INTAKE_ALIASES = {
    "credit_card": "payment_card",
    "debit_card": "payment_card",
    "bank_card": "payment_card",
    "id_card": "government_id",
    "identity_card": "government_id",
    "passport_book": "passport",
    "passport_card": "passport",
    "security_badge": "access_badge",
    "employee_badge": "access_badge",
    "prescription_medication": "medication",
    "medicine": "medication",
    "pills": "medication",
    "unattended_package": "suspicious_package",
    "unknown_package": "suspicious_package",
}

SPECIALIST_INTAKE_CATEGORIES = frozenset(
    {
        "passport",
        "government_id",
        "payment_card",
        "access_badge",
        "medication",
        "suspicious_package",
    }
)

ORDINARY_INTAKE_CATEGORIES = frozenset(
    {
        "camera_pouch",
        "camera",
        "phone",
        "laptop",
        "tablet",
        "headphones",
        "umbrella",
        "bag",
        "backpack",
        "clothing",
        "book",
        "keys",
    }
)


def normalize_intake_category(category: str) -> str:
    normalized = category.strip().lower().replace("-", "_").replace(" ", "_")
    return SPECIALIST_INTAKE_ALIASES.get(normalized, normalized)


def category_requires_specialist(category: str) -> bool:
    """Protect known specialist categories even if a caller understates risk."""

    normalized = normalize_intake_category(category)
    return normalized in SPECIALIST_INTAKE_CATEGORIES or normalized not in ORDINARY_INTAKE_CATEGORIES


def specialist_intake_guidance(category: str, assigned_tenant: str) -> dict[str, str | bool]:
    """Deterministic no-upload routing for property outside ordinary recovery."""

    normalized = normalize_intake_category(category)
    tenant_routes = {
        "northport-air": "Northport Air security and controlled-property desk",
        "metro-loop": "Metro Loop transit security control",
        "grand-hall": "Grand Hall venue security office",
    }
    route = tenant_routes.get(assigned_tenant, "the custodian's security or specialist desk")
    guidance = {
        "passport": (
            "government_document",
            f"Place it in a sealed document envelope and contact {route}.",
            "Do not scan or copy identity pages. Retain only the passport receipt ID and follow the tenant's documented handoff and retention schedule.",
        ),
        "government_id": (
            "government_document",
            f"Place it in a sealed document envelope and contact {route}.",
            "Do not scan or copy identity fields. Retain only custody metadata and follow the tenant's documented handoff and retention schedule.",
        ),
        "payment_card": (
            "payment_instrument",
            f"Do not record card numbers; contact {route} and follow the card issuer notification procedure.",
            "Retain no PAN, expiry, CVV, or card image. Keep only a coarse receipt and the tenant's disposition reference.",
        ),
        "access_badge": (
            "access_credential",
            f"Contact {route} so the badge can be disabled and returned through access control.",
            "Do not photograph credential identifiers. Retain only a coarse badge receipt and the access-control disposition reference.",
        ),
        "medication": (
            "medication",
            f"Do not identify, dispense, or relay medication; contact {route} or the onsite medical procedure.",
            "Retain no label image or patient data. Follow the tenant's documented medical-property retention and disposal process.",
        ),
        "suspicious_package": (
            "dangerous_or_suspicious",
            "Leave the item in place and follow the local emergency or security procedure.",
            "Create no Found Roll record, photo, or model request.",
        ),
    }
    route_kind, next_action, retention = guidance.get(
        normalized,
        (
            "specialist_review",
            f"Stop ordinary recovery and contact {route} for category-specific handling.",
            "Do not upload sensitive media. Retain only the minimum custody metadata allowed by the tenant's documented schedule.",
        ),
    )
    return {
        "route_kind": route_kind,
        "next_action": next_action,
        "retention_guidance": retention,
        "upload_allowed": False,
        "model_allowed": False,
    }


def evaluate_release_policy(case: CaseRecord) -> PolicyDecision:
    if case.risk_tier == RiskTier.DANGEROUS:
        return PolicyDecision(
            outcome=PolicyOutcome.DENY,
            reason_codes=["dangerous_items_never_enter_recovery"],
            next_action="Follow local emergency or security procedure; do not photograph, move, or release the item.",
        )
    if case.risk_tier == RiskTier.SENSITIVE:
        return PolicyDecision(
            outcome=PolicyOutcome.DENY,
            reason_codes=["specialist_policy_required"],
            next_action="Route to the tenant specialist policy; the demo cannot execute this return.",
        )
    if case.wrong_answer_count > 3:
        return PolicyDecision(
            outcome=PolicyOutcome.REQUIRE_REVIEW,
            reason_codes=["too_many_incorrect_private_answers"],
            next_action="Move the Item Passport to manual review without revealing the expected answer.",
        )
    if not case.accepted_claim_evidence:
        return PolicyDecision(
            outcome=PolicyOutcome.REQUEST_EVIDENCE,
            reason_codes=["private_claim_evidence_missing"],
            next_action="Request the minimum non-leading private discriminator.",
        )
    if case.risk_tier == RiskTier.VALUABLE and not case.identity_attestation_ref:
        return PolicyDecision(
            outcome=PolicyOutcome.REQUIRE_REVIEW,
            reason_codes=["staff_identity_attestation_missing"],
            next_action="A staff member must attest an identity check without retaining an ID image.",
        )
    if case.risk_tier == RiskTier.VALUABLE and not case.approval_ref:
        return PolicyDecision(
            outcome=PolicyOutcome.REQUIRE_REVIEW,
            reason_codes=["supervisor_approval_missing"],
            next_action="An accountable supervisor approval is required for valuable electronics.",
        )
    return PolicyDecision(
        outcome=PolicyOutcome.ALLOW_HANDOFF,
        reason_codes=["deterministic_release_gates_satisfied"],
        next_action="Create a disclosed SIMULATED relay reservation through the outbox.",
    )
