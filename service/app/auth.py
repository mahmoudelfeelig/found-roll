"""Constant-time header credential checks for hosted service boundaries."""

from __future__ import annotations

import hmac

from .config import Settings
from .errors import Forbidden


def _matches(provided: str | None, expected: str) -> bool:
    return bool(provided) and hmac.compare_digest(provided, expected)


def verify_staff_token(provided: str | None, settings: Settings) -> None:
    if not _matches(provided, settings.evidence_staff_token):
        raise Forbidden(
            "staff_auth_required",
            "This evidence route requires an authorized staff credential.",
        )


def verify_supervisor_token(provided: str | None, settings: Settings) -> None:
    if not _matches(provided, settings.supervisor_token):
        raise Forbidden(
            "supervisor_auth_required",
            "This approval route requires an authorized supervisor credential.",
        )


def verify_demo_access_token(provided: str | None, settings: Settings) -> None:
    """Protect browser-facing synthetic custody mutations in hosted production."""

    if settings.environment != "production":
        return
    verify_demo_access_token_strict(provided, settings)


def verify_demo_access_token_strict(provided: str | None, settings: Settings) -> None:
    """Verify demo access without the development mutation bypass.

    Runtime credential bootstrap uses this strict variant so a browser cannot
    mark a mistyped demo credential as loaded merely because local mutations
    are intentionally open during development.
    """

    if not _matches(provided, settings.demo_access_token):
        raise Forbidden(
            "demo_auth_required",
            "This synthetic custody mutation requires an authorized demo credential.",
        )


def verify_admin_token(
    provided: str | None,
    settings: Settings,
    *,
    production_only: bool = False,
) -> None:
    """Protect reset/recovery controls with a credential distinct from demo access."""

    if production_only and settings.environment != "production":
        return
    if not _matches(provided, settings.admin_token):
        raise Forbidden(
            "admin_auth_required",
            "This operator route requires an authorized admin credential.",
        )
