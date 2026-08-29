"""Environment-derived configuration with safe local defaults."""

from __future__ import annotations

from dataclasses import dataclass
import os
from urllib.parse import urlparse


DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)

LOCAL_DEMO_ACCESS_TOKEN = "found-roll-local-demo-token"
LOCAL_ADMIN_TOKEN = "found-roll-local-admin-token"
LOCAL_SUPERVISOR_TOKEN = "found-roll-local-supervisor-token"
SYNTHETIC_FIRESTORE_NAMESPACE_SUFFIX = "_synthetic_demo"


def _truthy(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _is_placeholder(value: str | None) -> bool:
    if not value:
        return False
    normalized = value.strip().lower().replace("_", "-")
    return normalized.startswith(("replace-with-", "change-me", "changeme")) or normalized in {
        "placeholder",
        "todo",
    }


def _validate_service_url(name: str, value: str | None, *, require_https: bool) -> None:
    if not value:
        raise ValueError(f"{name} is required")
    parsed = urlparse(value)
    allowed_schemes = {"https"} if require_https else {"http", "https"}
    if (
        parsed.scheme not in allowed_schemes
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        scheme_instruction = "an absolute HTTPS URL" if require_https else "an absolute HTTP(S) URL"
        raise ValueError(
            f"{name} must be {scheme_instruction} without credentials, query, or fragment"
        )


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str = "development"
    repository_backend: str = "memory"
    evidence_backend: str = "memory"
    analyst_mode: str = "fixture"
    inventory_mode: str = "fixture"
    inventory_base_url: str | None = None
    inventory_timeout_seconds: float = 3.0
    inventory_allow_legacy_health_without_environment: bool = False
    relay_mode: str = "fixture"
    tasks_mode: str = "inline"
    demo_mode: bool = True
    require_task_header: bool = False
    require_task_oidc: bool = False
    model_name: str = "gemini-3.5-flash"
    google_cloud_project: str | None = None
    google_cloud_location: str = "us-central1"
    firestore_namespace: str = "foundRoll"
    evidence_bucket: str | None = None
    evidence_staff_token: str = "found-roll-local-staff-token"
    supervisor_token: str = LOCAL_SUPERVISOR_TOKEN
    staff_actor_id: str = "staff.northport"
    supervisor_actor_id: str = "supervisor.northport"
    demo_access_token: str = LOCAL_DEMO_ACCESS_TOKEN
    admin_token: str = LOCAL_ADMIN_TOKEN
    evidence_max_upload_bytes: int = 8 * 1024 * 1024
    evidence_preview_max_edge: int = 1600
    claim_link_ttl_seconds: int = 1200
    relay_base_url: str | None = None
    relay_api_key: str | None = None
    relay_custodian_id: str = "northport-air"
    relay_destination: str = "Relay Post secure counter"
    relay_callback_max_age_seconds: int = 300
    public_base_url: str = "http://localhost:8080"
    task_queue: str = "found-roll"
    task_location: str = "us-central1"
    task_service_account: str | None = None
    secret_pepper: str = "found-roll-local-fixture-pepper"
    relay_shared_secret: str = "found-roll-local-relay-secret"
    allowed_origins: tuple[str, ...] = DEFAULT_ALLOWED_ORIGINS

    @classmethod
    def from_env(cls) -> "Settings":
        origins = os.getenv("FOUND_ROLL_ALLOWED_ORIGINS", "")
        settings = cls(
            environment=os.getenv("FOUND_ROLL_ENV", "development").strip().lower(),
            repository_backend=os.getenv("FOUND_ROLL_REPOSITORY", "memory").strip().lower(),
            evidence_backend=os.getenv("FOUND_ROLL_EVIDENCE_STORE", "memory").strip().lower(),
            analyst_mode=os.getenv("FOUND_ROLL_ANALYST_MODE", "fixture").strip().lower(),
            inventory_mode=os.getenv("FOUND_ROLL_INVENTORY_MODE", "fixture").strip().lower(),
            inventory_base_url=os.getenv("FOUND_ROLL_INVENTORY_BASE_URL") or None,
            inventory_timeout_seconds=float(
                os.getenv("FOUND_ROLL_INVENTORY_TIMEOUT_SECONDS", "3.0")
            ),
            inventory_allow_legacy_health_without_environment=_truthy(
                os.getenv("FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT"),
                False,
            ),
            relay_mode=os.getenv("FOUND_ROLL_RELAY_MODE", "fixture").strip().lower(),
            tasks_mode=os.getenv("FOUND_ROLL_TASKS_MODE", "inline").strip().lower(),
            demo_mode=_truthy(os.getenv("FOUND_ROLL_DEMO_MODE"), True),
            require_task_header=_truthy(os.getenv("FOUND_ROLL_REQUIRE_TASK_HEADER"), False),
            require_task_oidc=_truthy(os.getenv("FOUND_ROLL_REQUIRE_TASK_OIDC"), False),
            model_name=os.getenv("FOUND_ROLL_MODEL", "gemini-3.5-flash").strip(),
            google_cloud_project=os.getenv("GOOGLE_CLOUD_PROJECT") or None,
            google_cloud_location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1").strip(),
            firestore_namespace=os.getenv("FOUND_ROLL_FIRESTORE_NAMESPACE", "foundRoll").strip(),
            evidence_bucket=os.getenv("FOUND_ROLL_EVIDENCE_BUCKET") or None,
            evidence_staff_token=os.getenv(
                "FOUND_ROLL_EVIDENCE_STAFF_TOKEN", "found-roll-local-staff-token"
            ),
            supervisor_token=os.getenv(
                "FOUND_ROLL_SUPERVISOR_TOKEN", LOCAL_SUPERVISOR_TOKEN
            ),
            staff_actor_id=os.getenv("FOUND_ROLL_STAFF_ACTOR_ID", "staff.northport").strip(),
            supervisor_actor_id=os.getenv(
                "FOUND_ROLL_SUPERVISOR_ACTOR_ID", "supervisor.northport"
            ).strip(),
            demo_access_token=os.getenv(
                "FOUND_ROLL_DEMO_ACCESS_TOKEN", LOCAL_DEMO_ACCESS_TOKEN
            ),
            admin_token=os.getenv("FOUND_ROLL_ADMIN_TOKEN", LOCAL_ADMIN_TOKEN),
            evidence_max_upload_bytes=int(
                os.getenv("FOUND_ROLL_EVIDENCE_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024))
            ),
            evidence_preview_max_edge=int(
                os.getenv("FOUND_ROLL_EVIDENCE_PREVIEW_MAX_EDGE", "1600")
            ),
            claim_link_ttl_seconds=int(
                os.getenv("FOUND_ROLL_CLAIM_LINK_TTL_SECONDS", "1200")
            ),
            relay_base_url=os.getenv("FOUND_ROLL_RELAY_BASE_URL") or None,
            relay_api_key=os.getenv("FOUND_ROLL_RELAY_API_KEY") or None,
            relay_custodian_id=os.getenv("FOUND_ROLL_RELAY_CUSTODIAN_ID", "northport-air").strip(),
            relay_destination=os.getenv(
                "FOUND_ROLL_RELAY_DESTINATION", "Relay Post secure counter"
            ).strip(),
            relay_callback_max_age_seconds=int(
                os.getenv("FOUND_ROLL_RELAY_CALLBACK_MAX_AGE_SECONDS", "300")
            ),
            public_base_url=os.getenv("FOUND_ROLL_PUBLIC_BASE_URL", "http://localhost:8080").rstrip("/"),
            task_queue=os.getenv("FOUND_ROLL_TASK_QUEUE", "found-roll").strip(),
            task_location=os.getenv("FOUND_ROLL_TASK_LOCATION", "us-central1").strip(),
            task_service_account=os.getenv("FOUND_ROLL_TASK_SERVICE_ACCOUNT") or None,
            secret_pepper=os.getenv("FOUND_ROLL_SECRET_PEPPER", "found-roll-local-fixture-pepper"),
            relay_shared_secret=os.getenv("FOUND_ROLL_RELAY_SHARED_SECRET", "found-roll-local-relay-secret"),
            allowed_origins=tuple(
                origin.strip() for origin in origins.split(",") if origin.strip()
            )
            or DEFAULT_ALLOWED_ORIGINS,
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.environment not in {"development", "production"}:
            raise ValueError("FOUND_ROLL_ENV must be development or production")
        if self.repository_backend not in {"memory", "firestore"}:
            raise ValueError("FOUND_ROLL_REPOSITORY must be memory or firestore")
        if self.evidence_backend not in {"memory", "gcs"}:
            raise ValueError("FOUND_ROLL_EVIDENCE_STORE must be memory or gcs")
        if self.evidence_backend == "gcs" and not self.evidence_bucket:
            raise ValueError("FOUND_ROLL_EVIDENCE_BUCKET is required for the GCS evidence store")
        if not 1 <= self.evidence_max_upload_bytes <= 25 * 1024 * 1024:
            raise ValueError("FOUND_ROLL_EVIDENCE_MAX_UPLOAD_BYTES must be between 1 and 26214400")
        if not 256 <= self.evidence_preview_max_edge <= 4096:
            raise ValueError("FOUND_ROLL_EVIDENCE_PREVIEW_MAX_EDGE must be between 256 and 4096")
        if not 60 <= self.claim_link_ttl_seconds <= 3600:
            raise ValueError("FOUND_ROLL_CLAIM_LINK_TTL_SECONDS must be between 60 and 3600")
        if self.analyst_mode not in {"fixture", "vertex_adk"}:
            raise ValueError("FOUND_ROLL_ANALYST_MODE must be fixture or vertex_adk")
        if self.inventory_mode not in {"fixture", "http"}:
            raise ValueError("FOUND_ROLL_INVENTORY_MODE must be fixture or http")
        if not 0.25 <= self.inventory_timeout_seconds <= 10.0:
            raise ValueError(
                "FOUND_ROLL_INVENTORY_TIMEOUT_SECONDS must be between 0.25 and 10"
            )
        if self.inventory_mode == "http" and not self.inventory_base_url:
            raise ValueError(
                "FOUND_ROLL_INVENTORY_BASE_URL is required for HTTP inventory mode"
            )
        if self.inventory_mode == "http" and self.inventory_base_url:
            parsed_inventory_url = urlparse(self.inventory_base_url)
            if (
                parsed_inventory_url.scheme not in {"http", "https"}
                or not parsed_inventory_url.hostname
                or parsed_inventory_url.username is not None
                or parsed_inventory_url.password is not None
                or parsed_inventory_url.query
                or parsed_inventory_url.fragment
            ):
                raise ValueError(
                    "FOUND_ROLL_INVENTORY_BASE_URL must be an absolute HTTP(S) base URL "
                    "without credentials, query, or fragment"
                )
        if self.relay_mode not in {"fixture", "http"}:
            raise ValueError("FOUND_ROLL_RELAY_MODE must be fixture or http")
        if self.relay_mode == "http":
            _validate_service_url(
                "FOUND_ROLL_RELAY_BASE_URL",
                self.relay_base_url,
                require_https=self.environment == "production",
            )
        if self.environment != "production":
            _validate_service_url(
                "FOUND_ROLL_PUBLIC_BASE_URL",
                self.public_base_url,
                require_https=False,
            )
        if self.tasks_mode not in {"inline", "cloud"}:
            raise ValueError("FOUND_ROLL_TASKS_MODE must be inline or cloud")
        if self.environment == "production":
            configured_values = {
                "FOUND_ROLL_SECRET_PEPPER": self.secret_pepper,
                "FOUND_ROLL_DEMO_ACCESS_TOKEN": self.demo_access_token,
                "FOUND_ROLL_ADMIN_TOKEN": self.admin_token,
                "FOUND_ROLL_EVIDENCE_STAFF_TOKEN": self.evidence_staff_token,
                "FOUND_ROLL_SUPERVISOR_TOKEN": self.supervisor_token,
                "FOUND_ROLL_RELAY_API_KEY": self.relay_api_key,
                "FOUND_ROLL_RELAY_SHARED_SECRET": self.relay_shared_secret,
                "GOOGLE_CLOUD_PROJECT": self.google_cloud_project,
                "FOUND_ROLL_EVIDENCE_BUCKET": self.evidence_bucket,
                "FOUND_ROLL_TASK_SERVICE_ACCOUNT": self.task_service_account,
            }
            placeholders = [name for name, value in configured_values.items() if _is_placeholder(value)]
            if placeholders:
                raise ValueError(
                    "production configuration contains an example placeholder: "
                    + ", ".join(sorted(placeholders))
                )
            if self.secret_pepper == "found-roll-local-fixture-pepper":
                raise ValueError("FOUND_ROLL_SECRET_PEPPER must be replaced in production")
            if self.relay_shared_secret == "found-roll-local-relay-secret":
                raise ValueError("FOUND_ROLL_RELAY_SHARED_SECRET must be replaced in production")
            if self.analyst_mode != "vertex_adk":
                raise ValueError("production requires FOUND_ROLL_ANALYST_MODE=vertex_adk")
            if self.inventory_mode != "http" or not self.inventory_base_url:
                raise ValueError(
                    "production Vertex ADK requires FOUND_ROLL_INVENTORY_MODE=http and "
                    "FOUND_ROLL_INVENTORY_BASE_URL"
                )
            if urlparse(self.inventory_base_url).scheme != "https":
                raise ValueError(
                    "production FOUND_ROLL_INVENTORY_BASE_URL must use HTTPS"
                )
            if self.repository_backend != "firestore":
                raise ValueError("production requires FOUND_ROLL_REPOSITORY=firestore")
            if self.evidence_backend != "gcs" or not self.evidence_bucket:
                raise ValueError(
                    "production requires FOUND_ROLL_EVIDENCE_STORE=gcs and "
                    "FOUND_ROLL_EVIDENCE_BUCKET"
                )
            if len(self.secret_pepper) < 24:
                raise ValueError("FOUND_ROLL_SECRET_PEPPER must contain at least 24 characters in production")
            if self.evidence_staff_token == "found-roll-local-staff-token" or len(self.evidence_staff_token) < 24:
                raise ValueError("FOUND_ROLL_EVIDENCE_STAFF_TOKEN must contain at least 24 characters in production")
            if self.supervisor_token == LOCAL_SUPERVISOR_TOKEN or len(self.supervisor_token) < 24:
                raise ValueError("FOUND_ROLL_SUPERVISOR_TOKEN must contain at least 24 characters in production")
            if self.demo_access_token == LOCAL_DEMO_ACCESS_TOKEN or len(self.demo_access_token) < 24:
                raise ValueError(
                    "FOUND_ROLL_DEMO_ACCESS_TOKEN must be a dedicated secret of at least 24 characters in production"
                )
            if self.admin_token == LOCAL_ADMIN_TOKEN or len(self.admin_token) < 24:
                raise ValueError(
                    "FOUND_ROLL_ADMIN_TOKEN must be a dedicated secret of at least 24 characters in production"
                )
            if not self.relay_api_key or len(self.relay_api_key) < 24:
                raise ValueError("FOUND_ROLL_RELAY_API_KEY must contain at least 24 characters in production")
            if len(self.relay_shared_secret) < 24:
                raise ValueError("FOUND_ROLL_RELAY_SHARED_SECRET must contain at least 24 characters in production")
            security_secrets = {
                self.secret_pepper,
                self.evidence_staff_token,
                self.supervisor_token,
                self.demo_access_token,
                self.admin_token,
                self.relay_api_key,
                self.relay_shared_secret,
            }
            if len(security_secrets) != 7:
                raise ValueError(
                    "production pepper, evidence, supervisor, demo, admin, relay API, and callback credentials must be distinct"
                )
            if (
                len(self.staff_actor_id) < 3
                or len(self.supervisor_actor_id) < 3
                or self.staff_actor_id == self.supervisor_actor_id
            ):
                raise ValueError("production staff and supervisor actor identities must be nonempty and distinct")
            if self.demo_mode and not self.firestore_namespace.endswith(
                SYNTHETIC_FIRESTORE_NAMESPACE_SUFFIX
            ):
                raise ValueError(
                    "production demo reset requires FOUND_ROLL_FIRESTORE_NAMESPACE to end with "
                    f"{SYNTHETIC_FIRESTORE_NAMESPACE_SUFFIX}"
                )
            if self.relay_mode != "http" or not self.relay_base_url:
                raise ValueError("production requires an HTTP relay simulator URL")
            if self.tasks_mode != "cloud":
                raise ValueError("production requires FOUND_ROLL_TASKS_MODE=cloud")
            if not self.require_task_header or not self.require_task_oidc:
                raise ValueError(
                    "production requires FOUND_ROLL_REQUIRE_TASK_HEADER=true and "
                    "FOUND_ROLL_REQUIRE_TASK_OIDC=true"
                )
            if not self.task_service_account:
                raise ValueError("FOUND_ROLL_TASK_SERVICE_ACCOUNT is required in production")
            if not self.google_cloud_project:
                raise ValueError("GOOGLE_CLOUD_PROJECT is required in production")
            _validate_service_url(
                "FOUND_ROLL_PUBLIC_BASE_URL",
                self.public_base_url,
                require_https=True,
            )
