"""Canonical hashing and HMAC helpers."""

from __future__ import annotations

from datetime import datetime
import hashlib
import hmac
import json
from typing import Any

from pydantic import BaseModel


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _jsonable(value.model_dump(mode="json"))
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        _jsonable(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def sha256_hex(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def normalize_private_answer(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def secret_digest(value: str, pepper: str) -> str:
    normalized = normalize_private_answer(value)
    return hmac.new(pepper.encode("utf-8"), normalized.encode("utf-8"), hashlib.sha256).hexdigest()


def secure_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left, right)


def signed_body(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
