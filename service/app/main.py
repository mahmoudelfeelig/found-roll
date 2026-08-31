"""FastAPI application and public/task/callback routes."""

from __future__ import annotations

from datetime import datetime
from time import perf_counter
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .agent import FixtureCaseAnalyst, VertexAdkCaseAnalyst
from .auth import (
    verify_admin_token,
    verify_demo_access_token,
    verify_demo_access_token_strict,
    verify_staff_token,
    verify_supervisor_token,
)
from .config import Settings
from .correlation import (
    CORRELATION_HEADER,
    bind_correlation_id,
    configure_safe_request_logger,
    normalize_correlation_id,
    reset_correlation_id,
    safe_analysis_error_code,
)
from .custody_service import CustodyService
from .domain import (
    CustodyState,
    EvidenceVisibility,
    OpaqueTaskPayload,
    RiskTier,
    SimulatorHandoffCallback,
    TokenPurpose,
)
from .evidence import (
    EvidenceStore,
    GoogleCloudStorageEvidenceStore,
    InMemoryEvidenceStore,
    store_upload_pair,
)
from .errors import DomainError, Forbidden, NotFound
from .fixtures import DEMO_CASE_ID, reset_demo_repository
from .inventory import FixtureInventoryGateway, HttpInventoryGateway, InventoryGateway
from .outbox import CloudTasksPublisher, InlineTaskPublisher
from .policy import POLICY_VERSION
from .relay import (
    FixtureRelayGateway,
    HttpRelayGateway,
    callback_canonical_json,
    verify_callback_signature,
)
from .repository import FirestoreRepository, InMemoryRepository, Repository


HTTP_LOGGER = configure_safe_request_logger("found_roll.http")


class ActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")


class ClaimEvidenceRequest(ActionRequest):
    answer: str = Field(min_length=1, max_length=64)


class IdentityAttestationRequest(ActionRequest):
    staff_user_id: str | None = Field(default=None, min_length=3, max_length=80)
    method: Literal["government_id_visual_check", "booking_record_check", "employee_badge_check"]


class ApprovalRequest(ActionRequest):
    supervisor_user_id: str | None = Field(default=None, min_length=3, max_length=80)
    approved: bool
    reason: str = Field(min_length=8, max_length=300)


class ReservationRequest(ActionRequest):
    expected_remote_etag: str = Field(min_length=3, max_length=120)


class TokenIssueRequest(ActionRequest):
    pass


class TokenAttestationRequest(ActionRequest):
    handoff_id: str = Field(min_length=8, max_length=100)
    purpose: TokenPurpose
    token: str = Field(min_length=20, max_length=160)


class ReleaseRequest(ActionRequest):
    staff_user_id: str | None = Field(default=None, min_length=3, max_length=80)


class IntakeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    safety_result: Literal["ORDINARY_ITEM", "SUSPICIOUS_OR_DANGEROUS"]
    category: str = Field(min_length=2, max_length=80)
    risk_tier: RiskTier
    assigned_tenant: str = Field(min_length=2, max_length=80)
    current_holder: str = Field(min_length=2, max_length=120)
    public_description: str = Field(min_length=8, max_length=500)
    found_at: datetime
    found_zone: str = Field(min_length=2, max_length=120)
    report_route: list[str] = Field(min_length=1, max_length=12)
    actor: str | None = Field(default=None, min_length=3, max_length=100)
    idempotency_key: str = Field(min_length=8, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")


class OutboxReconcileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_items: int = Field(default=10, ge=1, le=25)


class TaskReplayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    idempotency_key: str = Field(min_length=8, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")


def _verify_task_oidc(authorization: str | None, settings: Settings) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise Forbidden("task_oidc_required", "A Google-signed Cloud Tasks OIDC token is required.")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        from google.auth.transport import requests as google_requests
        from google.oauth2 import id_token

        claims = id_token.verify_oauth2_token(
            token,
            google_requests.Request(),
            audience=settings.public_base_url,
        )
    except Exception as exc:
        raise Forbidden("task_oidc_invalid", "The Cloud Tasks OIDC token is invalid.") from exc
    issuer = claims.get("iss")
    email = claims.get("email")
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise Forbidden("task_oidc_issuer_invalid", "The Cloud Tasks OIDC issuer is invalid.")
    if not settings.task_service_account or email != settings.task_service_account:
        raise Forbidden("task_oidc_principal_invalid", "The Cloud Tasks principal is not authorized.")
    if claims.get("email_verified") is not True:
        raise Forbidden("task_oidc_principal_invalid", "The Cloud Tasks principal is not verified.")


def _components(
    settings: Settings,
    repository: Repository | None = None,
    evidence_store: EvidenceStore | None = None,
    inventory_gateway: InventoryGateway | None = None,
    analyst=None,
    relay=None,
    task_publisher=None,
):
    repo = repository
    if repo is None:
        repo = (
            FirestoreRepository(
                project=settings.google_cloud_project,
                namespace=settings.firestore_namespace,
            )
            if settings.repository_backend == "firestore"
            else InMemoryRepository()
        )
    store = evidence_store
    if store is None:
        store = (
            GoogleCloudStorageEvidenceStore(
                bucket_name=settings.evidence_bucket or "",
                project=settings.google_cloud_project,
            )
            if settings.evidence_backend == "gcs"
            else InMemoryEvidenceStore()
        )
    resolved_inventory = inventory_gateway
    if resolved_inventory is None:
        resolved_inventory = (
            HttpInventoryGateway(settings)
            if settings.inventory_mode == "http"
            else FixtureInventoryGateway()
        )
    if (
        settings.environment == "production"
        and settings.analyst_mode == "vertex_adk"
        and resolved_inventory.mode != "http"
    ):
        raise ValueError("production Vertex ADK requires the HTTP inventory gateway")
    resolved_analyst = analyst
    if resolved_analyst is None:
        resolved_analyst = (
            VertexAdkCaseAnalyst(
                project=settings.google_cloud_project,
                location=settings.google_cloud_location,
                model_name=settings.model_name,
                evidence_store=store,
                inventory_gateway=resolved_inventory,
            )
            if settings.analyst_mode == "vertex_adk"
            else FixtureCaseAnalyst()
        )
    resolved_relay = relay
    if resolved_relay is None:
        resolved_relay = (
            HttpRelayGateway(settings)
            if settings.relay_mode == "http"
            else FixtureRelayGateway()
        )
    publisher = task_publisher
    if publisher is None:
        publisher = (
            CloudTasksPublisher(settings)
            if settings.tasks_mode == "cloud"
            else InlineTaskPublisher()
        )
    return repo, store, resolved_inventory, resolved_analyst, resolved_relay, publisher


def create_app(
    *,
    settings: Settings | None = None,
    repository: Repository | None = None,
    evidence_store: EvidenceStore | None = None,
    inventory_gateway: InventoryGateway | None = None,
    analyst=None,
    relay=None,
    task_publisher=None,
    seed_demo: bool = True,
) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.validate()
    (
        repo,
        store,
        resolved_inventory,
        default_analyst,
        default_relay,
        default_publisher,
    ) = _components(
        settings,
        repository,
        evidence_store,
        inventory_gateway,
        analyst,
        relay,
        task_publisher,
    )
    service = CustodyService(
        repository=repo,
        evidence_store=store,
        analyst=default_analyst,
        relay=default_relay,
        task_publisher=default_publisher,
        settings=settings,
    )
    if seed_demo and settings.demo_mode and settings.repository_backend == "memory":
        reset_demo_repository(
            repo,
            settings.secret_pepper,
            occurred_at=service.clock(),
        )

    application = FastAPI(
        title="Found Roll Custody Service",
        version="0.1.0",
        description=(
            "Policy-bound synthetic lost-property recovery. Relay operations are SIMULATED and never prove ownership or possession."
        ),
    )
    application.state.custody_service = service
    application.state.evidence_store = store
    application.state.inventory_gateway = resolved_inventory
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        expose_headers=[CORRELATION_HEADER],
        allow_headers=[
            "Content-Type",
            "Authorization",
            "X-Found-Roll-Staff-Token",
            "X-Found-Roll-Supervisor-Token",
            "X-Found-Roll-Demo-Token",
            "X-Found-Roll-Claim-Link",
            "X-Found-Roll-Admin-Token",
            CORRELATION_HEADER,
            "X-CloudTasks-TaskName",
            "X-Found-Roll-Simulator-Timestamp",
            "X-Found-Roll-Simulator-Signature",
        ],
    )

    @application.middleware("http")
    async def safe_request_correlation(request: Request, call_next):
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
                response = JSONResponse(
                    status_code=500,
                    content={
                        "error": {
                            "code": "internal_error",
                            "message": "The custody service could not complete the request.",
                        }
                    },
                )
            status_code = response.status_code
            is_claim_link_inspection = (
                request.url.path.startswith("/api/v1/passports/")
                and request.url.path.endswith("/claim-link")
            )
            if request.url.path == "/api/v1/judge-walkthrough" or is_claim_link_inspection:
                # Preserve the public and claimant projection cache boundaries
                # for every outcome, including authorization failures.
                response.headers["Cache-Control"] = "no-store, private"
            response.headers[CORRELATION_HEADER] = correlation_id
            return response
        finally:
            route = request.scope.get("route")
            route_template = getattr(route, "path", "__unmatched__")
            HTTP_LOGGER.info(
                "request_complete",
                extra={
                    "service": "found-roll-custody",
                    "correlation_id": correlation_id,
                    "http_method": request.method,
                    "route_template": route_template,
                    "status_code": status_code,
                    "error_code": getattr(request.state, "safe_error_code", None),
                    "latency_ms": round((perf_counter() - started) * 1000, 3),
                },
            )
            reset_correlation_id(context_token)

    def require_demo_mutation(
        demo_token: str | None = Header(default=None, alias="X-Found-Roll-Demo-Token"),
    ) -> None:
        verify_demo_access_token(demo_token, settings)

    def require_admin(
        admin_token: str | None = Header(default=None, alias="X-Found-Roll-Admin-Token"),
    ) -> None:
        verify_admin_token(admin_token, settings)

    def require_staff_action(
        staff_token: str | None = Header(default=None, alias="X-Found-Roll-Staff-Token"),
    ) -> None:
        verify_staff_token(staff_token, settings)

    def require_production_staff_read(
        staff_token: str | None = Header(default=None, alias="X-Found-Roll-Staff-Token"),
    ) -> None:
        if settings.environment == "production":
            verify_staff_token(staff_token, settings)

    def require_supervisor_action(
        supervisor_token: str | None = Header(default=None, alias="X-Found-Roll-Supervisor-Token"),
    ) -> None:
        verify_supervisor_token(supervisor_token, settings)

    def require_production_reset_admin(
        admin_token: str | None = Header(default=None, alias="X-Found-Roll-Admin-Token"),
    ) -> None:
        verify_admin_token(admin_token, settings, production_only=True)

    @application.exception_handler(DomainError)
    async def domain_error_handler(request: Request, exc: DomainError):
        request.state.safe_error_code = safe_analysis_error_code(exc.code)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        # Do not echo request bodies, claimant answers, or one-time tokens.
        issues = [
            {"path": ".".join(str(part) for part in issue["loc"]), "message": issue["msg"]}
            for issue in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "request_invalid", "message": "Request validation failed.", "issues": issues}},
        )

    @application.get("/healthz")
    @application.get("/api/v1/healthz")
    def healthz(response: Response):
        evidence_ready = store.is_ready()
        inventory_ready = resolved_inventory.is_ready()
        if not evidence_ready or not inventory_ready:
            response.status_code = 503
        return {
            "status": "ok" if evidence_ready and inventory_ready else "unavailable",
            "service": "found-roll-custody",
            "environment": settings.environment,
            "demo_mode": settings.demo_mode,
            "demo_mutation_auth_required": settings.environment == "production",
            "admin_reset_auth_required": settings.environment == "production",
            "staff_read_auth_required": settings.environment == "production",
            "task_header_required": settings.require_task_header,
            "task_oidc_required": settings.require_task_oidc,
            "analyst_mode": service.analyst.mode,
            "model_name": service.analyst.model_name,
            "prompt_version": service.analyst.prompt_version,
            "output_schema_version": service.analyst.output_schema_version,
            "policy_version": POLICY_VERSION,
            "inventory_mode": resolved_inventory.mode,
            "inventory_base_url_configured": bool(settings.inventory_base_url),
            "inventory_gateway_configured": (
                resolved_inventory.mode == "fixture"
                or bool(settings.inventory_base_url)
            ),
            "inventory_gateway_ready": inventory_ready,
            "inventory_timeout_seconds": settings.inventory_timeout_seconds,
            "inventory_legacy_health_compatibility": (
                settings.inventory_allow_legacy_health_without_environment
            ),
            "repository": settings.repository_backend,
            "relay_mode": service.relay.mode,
            "tasks_mode": settings.tasks_mode,
            "evidence_store": store.mode,
            "evidence_store_ready": evidence_ready,
            "evidence_bucket_configured": bool(store.bucket_name),
            "simulator_disclosed": True,
        }

    @application.get("/api/v1/auth/runtime-roles")
    def probe_runtime_roles(
        response: Response,
        demo_token: str | None = Header(default=None, alias="X-Found-Roll-Demo-Token"),
        staff_token: str | None = Header(default=None, alias="X-Found-Roll-Staff-Token"),
        supervisor_token: str | None = Header(
            default=None,
            alias="X-Found-Roll-Supervisor-Token",
        ),
    ):
        """Strictly authenticate every browser runtime role without mutation."""

        verify_demo_access_token_strict(demo_token, settings)
        verify_staff_token(staff_token, settings)
        verify_supervisor_token(supervisor_token, settings)
        response.headers["Cache-Control"] = "no-store, private"
        return {
            "authenticated": True,
            "staff_actor_id": settings.staff_actor_id,
            "supervisor_actor_id": settings.supervisor_actor_id,
        }

    def judge_actor_label(actor: str) -> str:
        """Project a synthetic event actor without publishing role identifiers."""

        if actor.startswith("agent:"):
            return "bounded case analyst"
        if actor.startswith("staff:") or actor.startswith("staff."):
            return "staff custody action"
        if actor.startswith("supervisor:") or actor.startswith("supervisor."):
            return "supervisor approval"
        if actor.startswith("simulator:"):
            return "SIMULATED relay service"
        if actor.startswith("service:"):
            return "custody service"
        if actor.startswith("fixture:"):
            return "synthetic fixture system"
        return "system actor"

    @application.get("/api/v1/judge-walkthrough")
    def judge_walkthrough(response: Response):
        """Return a non-mutating, safe projection of the completed synthetic case.

        The public page is intentionally limited to the fixed synthetic fixture.
        It never returns claimant answers, credentials, restricted evidence,
        task bodies, raw actor IDs, idempotency keys, or model trace IDs.
        """

        if not settings.demo_mode:
            # The unauthenticated route is intentionally limited to the
            # configured synthetic demo namespace. Never project a colliding
            # case from a non-demo deployment.
            raise NotFound("Judge walkthrough")

        case = repo.get_case(DEMO_CASE_ID)
        response.headers["Cache-Control"] = "no-store, private"
        if case.state != CustodyState.CLOSED:
            return {
                "schema_version": "1",
                "kind": "found-roll-judge-walkthrough",
                "available": False,
                "read_only": True,
                "synthetic": True,
                "case": {"id": case.id},
                "reason": "The redacted completed-case walkthrough is available after the synthetic Item Passport closes.",
            }

        manifest = service.build_manifest(case.id)
        events = repo.list_events(case.id)
        return {
            "schema_version": "1",
            "kind": "found-roll-judge-walkthrough",
            "available": True,
            "read_only": True,
            "synthetic": True,
            "case": {
                "id": case.id,
                "state": case.state,
                "version": case.version,
                "category": case.category,
                "risk_tier": case.risk_tier,
                "reported_route_count": len(case.report_route),
            },
            "agentic": {
                "mode": case.model_mode or "not_recorded",
                "model_name": case.model_name or "not_recorded",
                "model_run_recorded": bool(case.model_run_id),
                "bounded_tool_step_count": len(case.model_tool_trajectory),
            },
            "passport": {
                "event_count": manifest.event_count,
                "hash_chain_valid": service.verify_event_chain(case.id),
                "manifest_id": manifest.manifest_id,
                "final_event_hash": manifest.final_event_hash,
                "internally_consistent": manifest.internally_consistent,
                "physical_transfer_proven": manifest.physical_transfer_proven,
            },
            "timeline": [
                {
                    "sequence": event.sequence,
                    "type": event.type,
                    "from_state": event.from_state,
                    "to_state": event.to_state,
                    "actor_label": judge_actor_label(event.actor),
                    "occurred_at": event.occurred_at,
                    "event_hash": event.event_hash,
                }
                for event in events
            ],
            "disclosure": (
                "This is a read-only projection of a closed synthetic case. It omits private claimant evidence, "
                "restricted media, credentials, task bodies, raw actor identifiers, and model trace identifiers. "
                "The event manifest is internally consistent application evidence; it does not prove ownership, "
                "physical possession, or a real-world transfer."
            ),
        }

    @application.get("/api/v1/passports")
    def list_passports(_authorized: None = Depends(require_production_staff_read)):
        return {"items": [service.snapshot(case.id)["case"] for case in repo.list_cases()]}

    @application.get("/api/v1/passports/{case_id}")
    def get_passport(
        case_id: str,
        _authorized: None = Depends(require_production_staff_read),
    ):
        return service.snapshot(case_id)

    @application.get("/api/v1/passports/{case_id}/events")
    def get_events(
        case_id: str,
        _authorized: None = Depends(require_production_staff_read),
    ):
        repo.get_case(case_id)
        return {"items": repo.list_events(case_id), "hash_chain_valid": service.verify_event_chain(case_id)}

    @application.get("/api/v1/passports/{case_id}/candidates")
    def get_candidates(
        case_id: str,
        _authorized: None = Depends(require_production_staff_read),
    ):
        case = repo.get_case(case_id)
        return {"items": repo.list_candidates(case.candidate_ids), "restricted_fields_included": False}

    @application.get("/api/v1/passports/{case_id}/manifest")
    def get_manifest(
        case_id: str,
        _authorized: None = Depends(require_production_staff_read),
    ):
        return service.build_manifest(case_id)

    @application.post("/api/v1/staff/passports/{case_id}/evidence")
    async def upload_evidence(
        case_id: str,
        file: UploadFile = File(...),
        authorize_preview_for_model: bool = Form(False),
        idempotency_key: str = Form(
            ...,
            min_length=8,
            max_length=160,
            pattern=r"^[A-Za-z0-9._:-]+$",
        ),
        staff_token: str | None = Header(default=None, alias="X-Found-Roll-Staff-Token"),
    ):
        verify_staff_token(staff_token, settings)
        case = repo.get_case(case_id)
        original, preview = await store_upload_pair(
            store,
            case_id=case_id,
            workflow_epoch=case.workflow_epoch,
            idempotency_key=idempotency_key,
            upload=file,
            authorize_preview_for_model=authorize_preview_for_model,
            max_bytes=settings.evidence_max_upload_bytes,
            preview_max_edge=settings.evidence_preview_max_edge,
        )
        active_pair = store.latest_complete_pair(case_id, case.workflow_epoch)
        return {
            "original": original,
            "preview": preview,
            "workflow_epoch": case.workflow_epoch,
            "active_for_analysis": bool(
                active_pair
                and active_pair[0].id == original.id
                and active_pair[1].id == preview.id
                and active_pair[1].visibility == EvidenceVisibility.MODEL_AUTHORIZED
            ),
            "restricted_bytes_included": False,
        }

    @application.get("/api/v1/staff/passports/{case_id}/evidence")
    def list_evidence(
        case_id: str,
        staff_token: str | None = Header(default=None, alias="X-Found-Roll-Staff-Token"),
    ):
        verify_staff_token(staff_token, settings)
        case = repo.get_case(case_id)
        active_pair = store.latest_complete_pair(case_id, case.workflow_epoch)
        return {
            "items": store.list_records(case_id),
            "workflow_epoch": case.workflow_epoch,
            "active_pair_ids": [record.id for record in active_pair] if active_pair else [],
            "restricted_bytes_included": False,
        }

    @application.get("/api/v1/staff/passports/{case_id}/evidence/{evidence_id}")
    def read_evidence(
        case_id: str,
        evidence_id: str,
        staff_token: str | None = Header(default=None, alias="X-Found-Roll-Staff-Token"),
    ):
        verify_staff_token(staff_token, settings)
        repo.get_case(case_id)
        record = store.get_record(evidence_id)
        if record.case_id != case_id:
            raise DomainError("not_found", "Evidence was not found.", 404)
        suffix = ".jpg" if record.mime_type == "image/jpeg" else ".png"
        return Response(
            content=store.read(evidence_id),
            media_type=record.mime_type,
            headers={
                "Cache-Control": "no-store, private",
                "Content-Disposition": f'attachment; filename="{record.id}{suffix}"',
                "X-Content-Type-Options": "nosniff",
                "X-Found-Roll-Evidence-SHA256": record.sha256,
            },
        )

    @application.post("/api/v1/intakes")
    def create_intake(
        payload: IntakeRequest,
        _demo_authorized: None = Depends(require_demo_mutation),
        _staff_authorized: None = Depends(require_staff_action),
    ):
        if payload.actor is not None and payload.actor != settings.staff_actor_id:
            raise Forbidden(
                "staff_actor_mismatch",
                "The intake actor must match the authenticated staff role.",
            )
        return service.create_intake(
            **payload.model_dump(exclude={"actor"}),
            actor=settings.staff_actor_id,
        )

    @application.post("/api/v1/passports/{case_id}/analysis-jobs")
    def begin_analysis(
        case_id: str,
        payload: ActionRequest,
        _authorized: None = Depends(require_demo_mutation),
    ):
        return service.begin_analysis(case_id, **payload.model_dump())

    @application.post("/api/v1/passports/{case_id}/claim-links")
    def issue_claim_link(
        case_id: str,
        payload: ActionRequest,
        _demo_authorized: None = Depends(require_demo_mutation),
        _staff_authorized: None = Depends(require_staff_action),
    ):
        return service.issue_claim_link(case_id, **payload.model_dump())

    @application.get("/api/v1/passports/{case_id}/claim-link")
    def inspect_claim_link(
        case_id: str,
        response: Response,
        claim_link_token: str | None = Header(default=None, alias="X-Found-Roll-Claim-Link"),
    ):
        response.headers["Cache-Control"] = "no-store, private"
        return service.inspect_claim_link(case_id, claim_link_token or "")

    @application.post("/api/v1/passports/{case_id}/claim-evidence")
    def submit_claim_evidence(
        case_id: str,
        payload: ClaimEvidenceRequest,
        claim_link_token: str | None = Header(default=None, alias="X-Found-Roll-Claim-Link"),
    ):
        result = service.submit_claim_evidence(
            case_id,
            claim_link_token or "",
            **payload.model_dump(),
        )
        if not result["accepted"] and result["case"].state.value == "CLARIFICATION_REQUIRED":
            result["replacement_claim_link"] = service.issue_claim_link(
                case_id,
                expected_version=result["case"].version,
                idempotency_key=f"rotate:{payload.idempotency_key}",
            )
        return result

    @application.post("/api/v1/passports/{case_id}/identity-attestations")
    def record_identity(
        case_id: str,
        payload: IdentityAttestationRequest,
        _authorized: None = Depends(require_staff_action),
    ):
        if payload.staff_user_id is not None and payload.staff_user_id != settings.staff_actor_id:
            raise Forbidden("staff_actor_mismatch", "The staff actor does not match the authenticated role.")
        return service.record_identity_attestation(
            case_id,
            **payload.model_dump(exclude={"staff_user_id"}),
            staff_user_id=settings.staff_actor_id,
        )

    @application.post("/api/v1/passports/{case_id}/approvals")
    def record_approval(
        case_id: str,
        payload: ApprovalRequest,
        _authorized: None = Depends(require_supervisor_action),
    ):
        if (
            payload.supervisor_user_id is not None
            and payload.supervisor_user_id != settings.supervisor_actor_id
        ):
            raise Forbidden(
                "supervisor_actor_mismatch",
                "The supervisor actor does not match the authenticated role.",
            )
        return service.record_approval(
            case_id,
            **payload.model_dump(exclude={"supervisor_user_id"}),
            supervisor_user_id=settings.supervisor_actor_id,
        )

    @application.post("/api/v1/passports/{case_id}/reservations")
    def begin_reservation(
        case_id: str,
        payload: ReservationRequest,
        _authorized: None = Depends(require_demo_mutation),
    ):
        return service.begin_reservation(case_id, **payload.model_dump())

    @application.post("/api/v1/passports/{case_id}/tokens")
    def issue_tokens(
        case_id: str,
        payload: TokenIssueRequest,
        _authorized: None = Depends(require_demo_mutation),
    ):
        return service.issue_tokens(case_id, **payload.model_dump())

    @application.post("/api/v1/passports/{case_id}/token-attestations")
    def attest_token(
        case_id: str,
        payload: TokenAttestationRequest,
        _authorized: None = Depends(require_demo_mutation),
    ):
        return service.attest_token(case_id, **payload.model_dump())

    @application.post("/api/v1/passports/{case_id}/releases")
    def begin_release(
        case_id: str,
        payload: ReleaseRequest,
        _authorized: None = Depends(require_staff_action),
    ):
        if payload.staff_user_id is not None and payload.staff_user_id != settings.staff_actor_id:
            raise Forbidden("staff_actor_mismatch", "The staff actor does not match the authenticated role.")
        return service.begin_release(
            case_id,
            **payload.model_dump(exclude={"staff_user_id"}),
            staff_user_id=settings.staff_actor_id,
        )

    @application.post("/api/v1/passports/{case_id}/close")
    def close_passport(
        case_id: str,
        payload: ActionRequest,
        _authorized: None = Depends(require_demo_mutation),
    ):
        return service.close_case(case_id, **payload.model_dump())

    @application.post("/api/v1/passports/{case_id}/release-task-replays")
    def replay_release_task(
        case_id: str,
        payload: TaskReplayRequest,
        _demo_authorized: None = Depends(require_demo_mutation),
        _staff_authorized: None = Depends(require_staff_action),
    ):
        return service.queue_release_task_replay(case_id, **payload.model_dump())

    @application.post("/tasks/outbox")
    def task_outbox(
        payload: OpaqueTaskPayload,
        x_cloudtasks_taskname: str | None = Header(
            default=None,
            alias="X-CloudTasks-TaskName",
            max_length=1024,
        ),
        authorization: str | None = Header(default=None, alias="Authorization"),
    ):
        if settings.require_task_header and not x_cloudtasks_taskname:
            raise Forbidden("task_auth_required", "This route accepts authenticated Cloud Tasks delivery only.")
        if settings.require_task_oidc:
            _verify_task_oidc(authorization, settings)
        return service.process_outbox(payload, delivery_task_name=x_cloudtasks_taskname)

    @application.post("/api/v1/relay/callbacks")
    async def relay_callback(
        request: Request,
        simulator_timestamp: str | None = Header(
            default=None, alias="X-Found-Roll-Simulator-Timestamp"
        ),
        simulator_signature: str | None = Header(
            default=None, alias="X-Found-Roll-Simulator-Signature"
        ),
    ):
        body = await request.body()
        try:
            callback = SimulatorHandoffCallback.model_validate_json(body)
        except ValueError as exc:
            raise DomainError("relay_callback_invalid", "The relay callback contract is invalid.", 422) from exc
        if not simulator_timestamp or not simulator_signature:
            raise Forbidden("relay_signature_required", "The simulator callback signature is required.")
        canonical_body = callback_canonical_json(callback.model_dump(mode="json"))
        verify_callback_signature(
            body=canonical_body,
            timestamp=simulator_timestamp,
            signature=simulator_signature,
            secret=settings.relay_shared_secret,
            now=service.clock(),
            max_age_seconds=settings.relay_callback_max_age_seconds,
        )
        return service.commit_simulator_callback(callback)

    @application.get("/api/v1/demo/snapshot")
    def demo_snapshot(_authorized: None = Depends(require_production_staff_read)):
        return service.snapshot(DEMO_CASE_ID)

    @application.post("/api/v1/demo/reset")
    def demo_reset(_authorized: None = Depends(require_production_reset_admin)):
        return service.reset_demo()

    @application.post("/api/v1/admin/demo/outbox/reconcile")
    def reconcile_demo_outbox(
        payload: OutboxReconcileRequest,
        _authorized: None = Depends(require_admin),
    ):
        return service.reconcile_demo_outbox(max_items=payload.max_items)

    return application


app = create_app()
