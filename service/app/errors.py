"""Sanitized domain errors for API and worker boundaries."""

from __future__ import annotations


class DomainError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class NotFound(DomainError):
    def __init__(self, resource: str) -> None:
        super().__init__("not_found", f"{resource} was not found.", 404)


class Conflict(DomainError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, 409)


class Forbidden(DomainError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, 403)


class Unavailable(DomainError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, 503)
