"""Shared disclosure text for every simulator response and callback artifact."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


SIMULATION_DISCLOSURE: dict[str, str] = {
    "mode": "SIMULATED",
    "fixture": "camera-pouch-v1",
    "notice": (
        "Fictional synthetic fixture only. Status values are simulator records. "
        "Token attestations record presentation to this software; they do not prove "
        "physical possession, delivery, or transfer."
    ),
}


def disclosure() -> dict[str, str]:
    """Return an isolated disclosure mapping safe for response mutation."""

    return deepcopy(SIMULATION_DISCLOSURE)


def callback_disclosure() -> dict[str, str]:
    """Return the exact disclosure shape accepted by the custody service callback."""

    return {
        "mode": SIMULATION_DISCLOSURE["mode"],
        "notice": SIMULATION_DISCLOSURE["notice"],
    }


def envelope(data: Any) -> dict[str, Any]:
    """Wrap successful response data in the permanent simulation disclosure."""

    return {"simulation": disclosure(), "data": data}


def error_envelope(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Wrap an error without echoing request bodies or credential material."""

    return {
        "simulation": disclosure(),
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
        },
    }
