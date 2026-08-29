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
    "latency_ms",
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
