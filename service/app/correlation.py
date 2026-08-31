"""Safe request correlation without request-content logging."""

from __future__ import annotations

from contextvars import ContextVar, Token
import json
import logging
import re
from uuid import uuid4


CORRELATION_HEADER = "X-Found-Roll-Correlation-ID"
_SAFE_CORRELATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$")
_current_correlation_id: ContextVar[str | None] = ContextVar(
    "found_roll_correlation_id",
    default=None,
)
_LOG_FIELDS = (
    "service",
    "correlation_id",
    "http_method",
    "route_template",
    "status_code",
    "error_code",
    "latency_ms",
)

# Only stable, source-controlled analysis codes may enter request logs. Domain
# error messages and unrecognized codes can contain runtime or adapter detail,
# so they remain excluded even though the HTTP caller receives its own error.
_SAFE_ANALYSIS_ERROR_CODES = frozenset(
    {
        "adk_dependency_missing",
        "adk_empty_response",
        "adk_invalid_response",
        "adk_llm_call_limit_exceeded",
        "adk_runtime_unavailable",
        "agent_candidate_packet_invalid",
        "agent_candidate_unavailable",
        "agent_custodian_search_incomplete",
        "agent_discriminator_invalid",
        "agent_discriminator_tool_binding_invalid",
        "agent_invocation_evidence_invalid",
        "agent_observation_tool_binding_invalid",
        "agent_scope_violation",
        "agent_selected_tool_binding_invalid",
        "agent_selection_missing",
        "agent_tool_pairing_invalid",
        "agent_tool_scope_violation",
        "agent_tool_trajectory_incomplete",
        "agent_tool_trajectory_invalid",
        "agent_trace_evidence_invalid",
        "candidate_evidence_insufficient",
        "evidence_store_unavailable",
        "inventory_contract_invalid",
        "inventory_contract_mismatch",
        "inventory_disclosure_missing",
        "inventory_scope_mismatch",
        "inventory_unavailable",
        "inventory_url_missing",
        "inventory_version_mismatch",
        "no_eligible_candidates",
        "vertex_project_missing",
    }
)


class SafeRequestFormatter(logging.Formatter):
    """Serialize only the approved request-completion identifiers."""

    def format(self, record: logging.LogRecord) -> str:
        return json.dumps(
            {field: getattr(record, field, None) for field in _LOG_FIELDS},
            separators=(",", ":"),
            sort_keys=True,
        )


def configure_safe_request_logger(name: str) -> logging.Logger:
    """Install one content-blind handler and suppress raw dependency access logs."""

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not any(
        getattr(handler, "_found_roll_safe_request_handler", False)
        for handler in logger.handlers
    ):
        handler = logging.StreamHandler()
        handler.setLevel(logging.INFO)
        handler.setFormatter(SafeRequestFormatter())
        handler._found_roll_safe_request_handler = True  # type: ignore[attr-defined]
        logger.addHandler(handler)
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    return logger


def safe_analysis_error_code(code: str) -> str | None:
    """Return a stable analyst diagnostic code, never runtime-supplied text."""

    return code if code in _SAFE_ANALYSIS_ERROR_CODES else None


def new_correlation_id() -> str:
    return f"fr-{uuid4().hex}"


def normalize_correlation_id(provided: str | None) -> str:
    if provided and _SAFE_CORRELATION_ID.fullmatch(provided):
        return provided
    return new_correlation_id()


def bind_correlation_id(value: str) -> Token:
    return _current_correlation_id.set(normalize_correlation_id(value))


def reset_correlation_id(token: Token) -> None:
    _current_correlation_id.reset(token)


def get_or_create_correlation_id() -> str:
    value = _current_correlation_id.get()
    if value is not None:
        return value
    value = new_correlation_id()
    _current_correlation_id.set(value)
    return value
