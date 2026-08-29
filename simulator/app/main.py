"""FastAPI entrypoint for the disclosed Found Roll simulator."""

from __future__ import annotations

import hmac
import os
from datetime import datetime
from time import perf_counter
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .correlation import (
    CORRELATION_HEADER,
    bind_correlation_id,
    configure_safe_request_logger,
    normalize_correlation_id,
    reset_correlation_id,
)
from .disclosure import envelope, error_envelope
from .models import (
    CredentialIssueRequest,
    HandoffAttestationRequest,
    ReservationCreateRequest,
    ResetRequest,
    TokenAttestationRequest,
)
from .store import DomainError, FixtureStore


HTTP_LOGGER = configure_safe_request_logger("found_roll_simulator.http")


def _is_placeholder(value: str | None) -> bool:
    if not value:
        return False
    normalized = value.strip().lower().replace("_", "-")
    return (
        normalized.startswith(("replace-with-", "changeme"))
        or "change-me" in normalized
        or normalized in {"placeholder", "todo"}
    )


def _validate_runtime_configuration(
    environment: str,
    *,
    api_key: str | None,
    callback_secret: str | None,
    token_secret: str | None,
) -> None:
    if environment not in {"development", "production"}:
        raise ValueError("SIMULATOR_ENV must be development or production")
    if environment != "production":
        return
    values = {
        "SIMULATOR_API_KEY": api_key,
        "SIMULATOR_CALLBACK_SECRET": callback_secret,
        "SIMULATOR_TOKEN_SECRET": token_secret,
    }
    placeholders = [name for name, value in values.items() if _is_placeholder(value)]
    if placeholders:
        raise ValueError(
            "simulator production configuration contains an example placeholder: "
            + ", ".join(sorted(placeholders))
        )
    weak = [name for name, value in values.items() if not value or len(value) < 24]
    if weak:
        raise ValueError(
            "simulator production secrets must contain at least 24 characters: "
            + ", ".join(sorted(weak))
        )
    if len(set(values.values())) != len(values):
        raise ValueError("simulator production API, token, and callback secrets must be distinct")


def create_app(
    *,
    store: FixtureStore | None = None,
    api_key: str | None = None,
    callback_secret: str | None = None,
    token_secret: str | None = None,
    environment: str | None = None,
) -> FastAPI:
    resolved_environment = (
        environment if environment is not None else os.getenv("SIMULATOR_ENV", "development")
    ).strip().lower()
    resolved_api_key = api_key if api_key is not None else os.getenv("SIMULATOR_API_KEY")
    resolved_callback_secret = (
        callback_secret if callback_secret is not None else os.getenv("SIMULATOR_CALLBACK_SECRET")
    )
    resolved_token_secret = (
        token_secret if token_secret is not None else os.getenv("SIMULATOR_TOKEN_SECRET")
    )
    _validate_runtime_configuration(
        resolved_environment,
        api_key=resolved_api_key,
        callback_secret=resolved_callback_secret,
        token_secret=resolved_token_secret,
    )
    app = FastAPI(
        title="Found Roll SIMULATED Custodian and Relay",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.store = store or FixtureStore()
    app.state.environment = resolved_environment
    app.state.api_key = resolved_api_key
    app.state.callback_secret = resolved_callback_secret
    app.state.token_secret = resolved_token_secret

    def disclosed_json(*, status_code: int, content: dict[str, Any]) -> JSONResponse:
        return JSONResponse(
            status_code=status_code,
            content=content,
            headers={"X-Found-Roll-Mode": "SIMULATED", "Cache-Control": "no-store"},
        )

    @app.middleware("http")
    async def simulation_headers(request: Request, call_next: Any) -> Any:
        correlation_id = normalize_correlation_id(
            request.headers.get(CORRELATION_HEADER)
        )
        context_token = bind_correlation_id(correlation_id)
        started = perf_counter()
        status_code = 500
        try:
            try:
                response = await call_next(request)
            except Exception:
                response = disclosed_json(
                    status_code=500,
                    content=error_envelope(
                        "SIMULATOR_INTERNAL_ERROR",
                        "The simulator could not complete the request. No custody claim was created.",
                    ),
                )
            status_code = response.status_code
            response.headers["X-Found-Roll-Mode"] = "SIMULATED"
            response.headers["Cache-Control"] = "no-store"
            response.headers[CORRELATION_HEADER] = correlation_id
            return response
        finally:
            route = request.scope.get("route")
            HTTP_LOGGER.info(
                "request_complete",
                extra={
                    "service": "found-roll-simulator",
                    "correlation_id": correlation_id,
                    "http_method": request.method,
                    "route_template": getattr(route, "path", "__unmatched__"),
                    "status_code": status_code,
                    "latency_ms": round((perf_counter() - started) * 1000, 3),
                },
            )
            reset_correlation_id(context_token)

    @app.exception_handler(DomainError)
    async def domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
        return disclosed_json(
            status_code=exc.status_code,
            content=error_envelope(exc.code, exc.message, details=exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {
                "location": [str(part) for part in error.get("loc", ())],
                "type": error.get("type", "validation_error"),
                "message": error.get("msg", "Invalid value"),
            }
            for error in exc.errors()
        ]
        return disclosed_json(
            status_code=422,
            content=error_envelope(
                "REQUEST_VALIDATION_FAILED",
                "The simulator request did not match the versioned contract.",
                details={"fields": fields},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "ROUTE_NOT_FOUND" if exc.status_code == 404 else "HTTP_REQUEST_REJECTED"
        message = "No simulator route exists at this path." if exc.status_code == 404 else "The simulator rejected this HTTP request."
        return disclosed_json(status_code=exc.status_code, content=error_envelope(code, message))

    @app.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
        return disclosed_json(
            status_code=500,
            content=error_envelope(
                "SIMULATOR_INTERNAL_ERROR",
                "The simulator could not complete the request. No custody claim was created.",
            ),
        )

    def require_mutation_auth(
        authorization: Annotated[str | None, Header(alias="Authorization")] = None,
    ) -> None:
        configured_key = app.state.api_key
        if not configured_key:
            raise DomainError(
                503,
                "SIMULATOR_AUTH_NOT_CONFIGURED",
                "Mutation routes are disabled until SIMULATOR_API_KEY is configured.",
            )
        if not authorization or not authorization.startswith("Bearer "):
            raise DomainError(401, "SIMULATOR_AUTH_REQUIRED", "A bearer credential is required for simulator mutations.")
        supplied_key = authorization.removeprefix("Bearer ")
        if not hmac.compare_digest(supplied_key, configured_key):
            raise DomainError(403, "SIMULATOR_AUTH_REJECTED", "The simulator bearer credential was rejected.")

    def require_token_secret() -> str:
        if not app.state.token_secret:
            raise DomainError(
                503,
                "TOKEN_SECRET_NOT_CONFIGURED",
                "Credential issuance is disabled until SIMULATOR_TOKEN_SECRET is configured.",
            )
        return app.state.token_secret

    def require_callback_secret() -> str:
        if not app.state.callback_secret:
            raise DomainError(
                503,
                "CALLBACK_SECRET_NOT_CONFIGURED",
                "Callback signing is disabled until SIMULATOR_CALLBACK_SECRET is configured.",
            )
        return app.state.callback_secret

    @app.get("/")
    def service_root() -> dict[str, Any]:
        return envelope(
            {
                "service": "Found Roll custodian and Relay Post simulator",
                "api_version": "v1",
                "fixture_version": app.state.store.fixture_version,
                "environment": app.state.environment,
                "mutation_auth_configured": bool(app.state.api_key),
                "callback_signing_configured": bool(app.state.callback_secret),
                "token_derivation_configured": bool(app.state.token_secret),
            }
        )

    @app.get("/healthz")
    def health() -> dict[str, Any]:
        return envelope(
            {
                "status": "ok",
                "service": "found-roll-simulator",
                "api_version": "v1",
                "fixture_version": app.state.store.fixture_version,
                "environment": app.state.environment,
                "mutation_auth_configured": bool(app.state.api_key),
                "callback_signing_configured": bool(app.state.callback_secret),
                "token_derivation_configured": bool(app.state.token_secret),
            }
        )

    @app.get("/v1/custodians")
    def list_custodians() -> dict[str, Any]:
        custodians = app.state.store.list_custodians()
        return envelope({"custodians": custodians, "count": len(custodians)})

    @app.get("/v1/custodians/{custodian_id}/inventory")
    def list_inventory(
        custodian_id: str,
        category: Annotated[str | None, Query(min_length=2, max_length=64)] = None,
        status: Annotated[str | None, Query(pattern=r"^(?i:AVAILABLE|HELD|RELEASED)$")] = None,
        route: Annotated[str | None, Query(min_length=2, max_length=64)] = None,
        found_after: datetime | None = None,
        found_before: datetime | None = None,
        q: Annotated[str | None, Query(min_length=2, max_length=100)] = None,
    ) -> dict[str, Any]:
        items = app.state.store.list_inventory(
            custodian_id,
            category=category,
            status=status,
            route=route,
            found_after=found_after,
            found_before=found_before,
            query=q,
        )
        return envelope({"custodian_id": custodian_id, "items": items, "count": len(items)})

    @app.get("/v1/custodians/{custodian_id}/inventory/{item_id}")
    def get_inventory_item(custodian_id: str, item_id: str) -> dict[str, Any]:
        return envelope({"item": app.state.store.get_inventory_item(custodian_id, item_id)})

    @app.post("/v1/admin/reset", dependencies=[Depends(require_mutation_auth)])
    def reset_fixture(request: ResetRequest) -> dict[str, Any]:
        summary = app.state.store.reset()
        return envelope(
            {
                **summary,
                "actor": request.actor,
                "reason": request.reason,
                "result": "SIMULATED_FIXTURE_RESET",
            }
        )

    @app.post("/v1/relay/reservations", status_code=201, dependencies=[Depends(require_mutation_auth)])
    def create_reservation(request: ReservationCreateRequest) -> dict[str, Any]:
        return envelope(app.state.store.create_reservation(request))

    @app.get("/v1/relay/reservations/{reservation_id}")
    def get_reservation(reservation_id: str) -> dict[str, Any]:
        return envelope(app.state.store.get_reservation(reservation_id))

    @app.post(
        "/v1/relay/reservations/{reservation_id}/credentials",
        status_code=201,
        dependencies=[Depends(require_mutation_auth)],
    )
    def issue_credentials(reservation_id: str, request: CredentialIssueRequest) -> dict[str, Any]:
        token_secret_value = require_token_secret()
        return envelope(
            app.state.store.issue_credentials(
                reservation_id,
                request,
                token_secret=token_secret_value,
            )
        )

    @app.post(
        "/v1/relay/reservations/{reservation_id}/attestations",
        status_code=201,
        dependencies=[Depends(require_mutation_auth)],
    )
    def record_attestation(reservation_id: str, request: TokenAttestationRequest) -> dict[str, Any]:
        return envelope(app.state.store.record_attestation(reservation_id, request))

    @app.post(
        "/v1/relay/reservations/{reservation_id}/handoff-attestation",
        status_code=201,
        dependencies=[Depends(require_mutation_auth)],
    )
    def finalize_handoff_attestation(
        reservation_id: str,
        request: HandoffAttestationRequest,
    ) -> dict[str, Any]:
        callback_secret_value = require_callback_secret()
        return envelope(
            app.state.store.finalize_handoff_attestation(
                reservation_id,
                request,
                callback_secret=callback_secret_value,
            )
        )

    return app


app = create_app()
