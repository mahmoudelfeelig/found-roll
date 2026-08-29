# Found Roll custody service

This FastAPI service is the deterministic authority for the synthetic Found Roll camera-pouch demo. It owns Item Passport state, policy gates, application-enforced hash-chained events, idempotency receipts, outbox commands, one-time credential checks, private image-evidence storage, and the final internal-consistency manifest.

The service never determines ownership and never claims that a token, simulator callback, or closed Item Passport proves physical possession. Grand Hall, Metro Loop, Northport Air, Relay Post, and all fixture data are fictional. Relay Post is permanently disclosed as `SIMULATED`.

## Authority boundary

The bounded Case Analyst may inspect already-authorized claimant-safe candidate facts, rank candidates, submit source-linked visible observations, propose one non-leading discriminator, or request manual review. In `vertex_adk` mode, its `search_custodian` and `load_candidate` tools use the separately deployed simulator's inventory HTTP endpoints. The gateway rejects missing `X-Found-Roll-Mode: SIMULATED` disclosure, invalid envelopes, cross-tenant records, version/eTag drift, schema drift, transport failures, and unapproved item IDs. It overlays public simulator facts onto the service's authorized candidate records and returns only the claimant-safe field whitelist. Before committing a proposal, deterministic code re-reads the selected item and requires its live overlay to remain `AVAILABLE`. Its output schema hard-codes `evidence_sufficient_for_claim` to `false`. It cannot see the expected serial answer and has no tool that can accept evidence, attest identity, approve, reserve, release, mint or consume credentials, or write custody state.

The deterministic policy and custody layers enforce these invariants:

- Visual similarity never accepts claim evidence.
- The valuable camera pouch needs an exact restricted-answer match, two visible signals, hard route/time/category/availability filters, a frozen score margin, a staff identity attestation, and supervisor approval.
- Passports/government IDs, payment cards, access badges, medication, suspicious packages, and unknown sensitive categories are stopped before upload. The response selects category-specific retention/action copy and the Northport Air, Metro Loop, or Grand Hall specialist route; it creates no case and calls no model.
- Case state transitions bind the expected current case version and a bounded idempotency key. Intake, evidence ingestion, reset/recovery, task delivery/replay, and signed callbacks use endpoint-specific scope and replay guards rather than all exposing the same pair of fields.
- Reservation and release intents commit an outbox row in the same repository mutation as their custody event.
- In production, ordinary synthetic workflow mutations require `X-Found-Roll-Demo-Token`; rich passport, event, candidate, manifest, and demo-snapshot reads plus staff evidence, identity, and release actions require `X-Found-Roll-Staff-Token`; approval requires `X-Found-Roll-Supervisor-Token`. The service derives the exact configured staff or supervisor actor ID after authentication. Optional legacy actor fields are accepted only when they match that configured ID; conflicting values fail closed.
- Claim evidence requires a separate one-time claimant link bound to the case and exact issued case version. Only its keyed digest, issue/expiry times, and consumed state are persisted. A wrong answer consumes the old link and returns a replacement for the incremented case version; expiry, replay, wrong-case use, and stale-version use fail closed.
- Reset and recovery require the distinct `X-Found-Roll-Admin-Token`. Admin authority is for authenticated terminal/Cloud Shell automation and is never accepted or stored by the browser.
- Publication failures are recorded as `FAILED/PUBLISH` and can be republished by a bounded operator action. Execution failures are `FAILED/EXECUTE` and are never automatically republished.
- Task bodies contain only `schema_version`, `case_id`, and `outbox_id`. A Cloud Tasks publication receipt is payload-free; the explicit local inline receipt includes that opaque body only so the development client can deliver it to `/tasks/outbox`.
- Raw claimant answers and one-time credentials are never written to events, outbox payloads, snapshots, or validation errors.
- Uploaded originals are private staff-only objects. Each preview is separately decoded, orientation-normalized, resized, and re-encoded as JPEG without EXIF, with its source record, transform, SHA-256, generation, MIME type, byte size, visibility, and workflow epoch retained as provenance metadata. The upload idempotency key plus current workflow epoch make an accepted retry return the same pair; conflicting bytes or model consent fail with an idempotency conflict. Analysis and the staff browser select only the latest complete pair from the current epoch, so retained evidence from an earlier reset cannot be sent to the model or substituted into the workspace.
- User filenames and case IDs never enter evidence object names. Evidence bytes have no public route, signed URL, or object ACL; staff reads require `X-Found-Roll-Staff-Token` and return `Cache-Control: no-store, private`.
- Vertex receives only image Parts whose derived record is explicitly `MODEL_AUTHORIZED` and whose storage URI is `gs://`. The private expected answer is never included in the model prompt or tools.
- A replayed or expired credential cannot mutate custody.
- The final manifest checks the application event sequence and hash links only. `physical_transfer_proven` is always `false`.

## Modes

Local defaults are deliberately obvious fixtures. They are useful for deterministic development and tests, but they do not satisfy the hackathon's live Google execution requirement.

| Boundary | Local default | Canonical Cloud mode |
| --- | --- | --- |
| Repository | Thread-safe in-memory store | Firestore transactions |
| Image evidence | In-memory private fixture store | Private Google Cloud Storage bucket with generation-pinned reads |
| Analyst | `deterministic-fixture-no-model` | Google ADK `LlmAgent` with pinned `gemini-3.5-flash` through Vertex AI |
| Analyst inventory | Deterministic in-process fixture gateway | Claimant-safe reads from the separately deployed simulator over bounded HTTPS |
| Background work | Explicit inline receipt with an opaque body, manually delivered to `/tasks/outbox` | Named Cloud Tasks with opaque body and OIDC; browser-facing receipt contains no body |
| Relay | In-process disclosed simulator attestation | Separately deployed Relay Post simulator over authenticated HTTPS |

`GET /healthz` exposes the active analyst, model, inventory mode, inventory URL and gateway configuration status, bounded inventory timeout, live inventory readiness, relay, and evidence-store modes so a fixture path cannot be mistaken for the canonical live path. In HTTP mode it performs a bounded `/healthz` call to the simulator and validates the `SIMULATED` header plus the exact typed fixture envelope. It returns HTTP 503 if that probe fails or if the configured evidence store becomes unavailable. GCS-mode startup also checks that the configured bucket exists and is reachable. Inventory transport and contract failures fail the analysis operation closed rather than being silently replaced with fixture rows.

For the `data.environment` simulator-health schema rollout, deploy the backward-compatible app revision first. It must accept both the immediately preceding envelope and the new envelope during that ordered rollout, then require the new simulator to report `production`. Deploying the simulator first strands an older strict app on the additional field.

## Run locally

Python 3.11 or newer is required.

```powershell
cd service
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes -r requirements-dev.lock
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

The synthetic case is seeded at startup. Inspect it at `GET http://localhost:8080/api/v1/demo/snapshot` or use the OpenAPI UI at `http://localhost:8080/docs`.

Run the service verification suite:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

Use the fresh command output and checked verification receipts for counts. The suite covers declared state edges, forbidden release skips, deterministic category/tenant no-upload routing, dangerous-item pre-intake termination, scoped claimant-link issue/expiry/replay/wrong-answer rotation, separate demo/staff/supervisor authorization, strict runtime-role bootstrap, server-derived actors, evidence retry/epoch isolation, prompt-injection resistance, claimant-surface privacy, version conflicts, wrong-answer review escalation, opaque tasks, event-chain tampering, duplicate task delivery, one-time handoff-token replay, and the complete camera-pouch path through a closed manifest.

`requirements.lock` and `requirements-dev.lock` freeze the complete runtime and test closures with hashes. Regenerate them deliberately from the corresponding `.txt` inputs with the pinned lock tool; do not hand-edit a resolved version or hash.

## Canonical API path

Case state-transition bodies include `expected_version` and an `idempotency_key` unless they are a signed service callback. Intake, evidence ingestion, reset/reconciliation, task delivery, and release-task replay use the route-specific contracts below and do not all expose `expected_version`.

| Method and path | Effect |
| --- | --- |
| `POST /api/v1/demo/reset` | Replace only the frozen synthetic fixture. Production requires `X-Found-Roll-Admin-Token` and a Firestore namespace ending `_synthetic_demo`; invoke it from authenticated terminal/Cloud Shell tooling, not the browser. |
| `POST /api/v1/admin/demo/outbox/reconcile` | With `X-Found-Roll-Admin-Token`, republish at most 25 `PENDING` or `FAILED/PUBLISH` commands for the frozen demo case. `FAILED/EXECUTE` commands remain manual-only. |
| `GET /api/v1/auth/runtime-roles` | Strictly validate the demo, staff, and supervisor headers together without mutation, even in development; return the configured staff and supervisor actor IDs with no-store headers. |
| `POST /api/v1/intakes` | With both demo and staff credentials, run the pre-intake decision. Sensitive or dangerous categories return tenant-specific specialist/no-upload guidance, create no record, and call no model. |
| `POST /api/v1/passports/{id}/analysis-jobs` | Commit `EVIDENCE_READY` then `ANALYZING` with an opaque outbox command. |
| `POST /api/v1/staff/passports/{id}/evidence` | Accept one staff-authenticated multipart JPEG/PNG plus an idempotency key, retain its private original, and create a provenance-linked EXIF-free preview for the current workflow epoch. `authorize_preview_for_model=true` is an explicit model-visibility decision for the preview only. Exact retries return the same pair; changed bytes or consent conflict. |
| `GET /api/v1/staff/passports/{id}/evidence` | Return staff-authenticated evidence metadata only; no bytes. |
| `GET /api/v1/staff/passports/{id}/evidence/{evidence_id}` | Return generation-pinned, SHA-256-verified bytes to an authenticated staff caller with no-store headers. |
| `POST /tasks/outbox` | Process an authenticated analysis/reservation/release delivery idempotently. |
| `POST /api/v1/passports/{id}/claim-links` | With both demo and staff credentials, issue a one-time case/version-scoped proof link during `CLARIFICATION_REQUIRED`; return the raw token once and persist only its keyed digest plus lifecycle metadata. |
| `GET /api/v1/passports/{id}/claim-link` | Inspect the link supplied in `X-Found-Roll-Claim-Link` without returning the raw token. |
| `POST /api/v1/passports/{id}/claim-evidence` | Consume `X-Found-Roll-Claim-Link` and compare the private answer only in deterministic code. A wrong answer rotates the link to the new case version; the answer is never returned. |
| `POST /api/v1/passports/{id}/identity-attestations` | Record only method, staff actor, outcome, and time; no ID media or ID text. |
| `POST /api/v1/passports/{id}/approvals` | Record accountable supervisor approval or rejection with a reason. |
| `POST /api/v1/passports/{id}/reservations` | Commit `RESERVE_REQUESTED`, a handoff record, and an outbox row after a current `ALLOW_HANDOFF` decision. |
| `POST /api/v1/passports/{id}/tokens` | Ask the simulator's reservation-bound credentials route for two short-lived credentials and persist keyed hashes only. |
| `POST /api/v1/passports/{id}/token-attestations` | Present one scoped credential to the simulator, then consume its local keyed hash once; this is not proof of possession. |
| `POST /api/v1/passports/{id}/releases` | Require both credential attestations and staff confirmation, then commit `RELEASE_REQUESTED` plus outbox. |
| `POST /api/v1/passports/{id}/release-task-replays` | With both demo and staff credentials, queue one idempotent duplicate delivery for the already-completed release command; it must not append another custody event. |
| `POST /api/v1/relay/callbacks` | Validate the simulator callback signature and commit the matching remote service attestation once. |
| `POST /api/v1/passports/{id}/close` | Verify the event chain and complete handoff gates, then close the Item Passport. |
| `GET /api/v1/passports/{id}/manifest` | Return the internally consistent application event manifest for a closed case. |

Rich read routes include `GET /api/v1/passports`, `/api/v1/passports/{id}`, `/events`, `/candidates`, `/manifest`, and `/api/v1/demo/snapshot`. They require the staff credential in production; they are neither claimant routes nor unauthenticated public endpoints. Candidate serializers still exclude restricted fields. The claimant never receives those shapes: the one-time link routes return a purpose-built coarse projection containing only the proof question, limited case copy, link lifecycle, and attempt state.

The browser boundary is deliberately split:

| Browser credential | Allowed boundary | Actor binding |
| --- | --- | --- |
| `X-Found-Roll-Demo-Token` | Analysis, reservation, handoff-token issue/presentation, and close in hosted production; intake and claimant-link issuance only when the staff credential is also present | Synthetic workflow only; not a staff identity |
| `X-Found-Roll-Staff-Token` | Production rich reads, evidence upload/list/read, identity attestation, release confirmation, and the staff co-gate for intake, claimant-link issuance, and release-task replay | Server records exactly `FOUND_ROLL_STAFF_ACTOR_ID` (`staff.northport` in the frozen fixture); a conflicting optional legacy `staff_user_id` is rejected |
| `X-Found-Roll-Supervisor-Token` | Valuable-item approval/rejection | Server records exactly `FOUND_ROLL_SUPERVISOR_ACTOR_ID` (`supervisor.northport`); a conflicting optional legacy `supervisor_user_id` is rejected |
| `X-Found-Roll-Claim-Link` | Inspect and submit one claimant proof for one case/version before expiry | No reusable staff role; raw value is loaded from `#claim=…`, scrubbed from the URL, and retained only in tab memory |

The browser submits all three reusable runtime values to the non-mutating runtime-role probe before it marks any role loaded or fetches the staff projection. That probe is strict even though local development skips the demo-token check on ordinary synthetic mutations. Empty, partial, or rejected configuration clears the full in-memory session, including claimant links, issued handoff credentials, pending intake state, task/outbox receipts, manifest data, and evidence object URLs. Do not compile credentials into browser JavaScript or persist them in browser storage. The admin token is excluded from the frontend entirely.

The Firestore reset does not delete a database or a namespace. In one transaction it reads and replaces only `FR-20260829-0042`, its nested events, the three exact fixture inventory IDs, and outbox/handoff/token/idempotency rows whose stored case scope matches that ID. It preserves unrelated cases and inventory, fails above a 200-document bound, and conflicts with concurrent writes through Firestore transaction retries. Stored image evidence is retained rather than broadly deleted, but every reset creates a new workflow epoch; only a complete pair uploaded for that epoch can become active for browser display or model analysis.

## Configuration

| Variable | Purpose |
| --- | --- |
| `FOUND_ROLL_ENV` | `development` or `production`; production activates strict configuration checks. |
| `FOUND_ROLL_REPOSITORY` | `memory` or `firestore`. |
| `FOUND_ROLL_EVIDENCE_STORE` | `memory` or `gcs`; production requires `gcs`. |
| `FOUND_ROLL_EVIDENCE_BUCKET` | Existing private GCS bucket. Required whenever the evidence store is `gcs`; startup fails if it is missing or unreachable. |
| `FOUND_ROLL_EVIDENCE_STAFF_TOKEN` | Staff-only API credential for upload, metadata, byte reads, identity attestation, and release confirmation. Inject from Secret Manager; the local fixture value is rejected in production. |
| `FOUND_ROLL_SUPERVISOR_TOKEN` | Independent approval credential used only by `X-Found-Roll-Supervisor-Token`. Inject from its own Secret Manager resource; the local fixture value is rejected in production. |
| `FOUND_ROLL_STAFF_ACTOR_ID` | Exact server-derived actor recorded for staff identity/release actions; frozen demo value `staff.northport`. |
| `FOUND_ROLL_SUPERVISOR_ACTOR_ID` | Exact, distinct server-derived actor recorded for approval actions; frozen demo value `supervisor.northport`. |
| `FOUND_ROLL_DEMO_ACCESS_TOKEN` | Credential required in `X-Found-Roll-Demo-Token` for general hosted synthetic-workflow mutations. It cannot authorize staff, supervisor, claimant, or admin routes and must be a non-default dedicated secret of at least 24 characters. |
| `FOUND_ROLL_ADMIN_TOKEN` | Separate credential required in `X-Found-Roll-Admin-Token` for production reset and all environments' outbox recovery route. Must be a non-default dedicated secret of at least 24 characters in production. |
| `FOUND_ROLL_EVIDENCE_MAX_UPLOAD_BYTES` | Maximum multipart image body, default 8 MiB and hard-capped at 25 MiB. |
| `FOUND_ROLL_EVIDENCE_PREVIEW_MAX_EDGE` | Longest preview edge after normalization, default 1600 pixels. |
| `FOUND_ROLL_CLAIM_LINK_TTL_SECONDS` | Claimant-link lifetime, default 1200 seconds and accepted range 60–3600; the issued link is also invalidated by case-version change or consumption. |
| `FOUND_ROLL_ANALYST_MODE` | `fixture` or `vertex_adk`. |
| `FOUND_ROLL_INVENTORY_MODE` | `fixture` or `http`. Production requires `http`; the fixture analyst remains deterministic and network-free. |
| `FOUND_ROLL_INVENTORY_BASE_URL` | Base URL for the separately deployed simulator inventory reads. Required in HTTP mode and required to use HTTPS in production. |
| `FOUND_ROLL_INVENTORY_TIMEOUT_SECONDS` | Total inventory request timeout, default 3 seconds, accepted range 0.25–10 seconds; connect time is capped at 2 seconds. |
| `FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT` | Narrow ordered-rollout compatibility flag for the immediately preceding simulator health envelope. The canonical frozen revision and preparation receipt must report `false`. |
| `FOUND_ROLL_RELAY_MODE` | `fixture` or `http`. |
| `FOUND_ROLL_TASKS_MODE` | `inline` or `cloud`. |
| `FOUND_ROLL_MODEL` | Exact Vertex model ID; canonical default is `gemini-3.5-flash`. |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud project for Firestore, Vertex AI, and Cloud Tasks. |
| `GOOGLE_CLOUD_LOCATION` | Vertex location, default `us-central1`. |
| `FOUND_ROLL_FIRESTORE_NAMESPACE` | Prefix for service-owned collections. A production deployment with demo reset enabled must end in `_synthetic_demo`. |
| `FOUND_ROLL_PUBLIC_BASE_URL` | Exact HTTPS origin used as the Cloud Tasks OIDC audience and callback base. |
| `FOUND_ROLL_TASK_QUEUE` / `FOUND_ROLL_TASK_LOCATION` | Cloud Tasks queue coordinates. |
| `FOUND_ROLL_TASK_SERVICE_ACCOUNT` | Exact service-account email accepted from the verified task ID token. |
| `FOUND_ROLL_REQUIRE_TASK_HEADER` | Require the Cloud Tasks task-name/correlation header as defense in depth. Production must set `true`. |
| `FOUND_ROLL_REQUIRE_TASK_OIDC` | Verify the Google-signed bearer ID token, audience, issuer, verified email, and exact principal. Production must set `true`. |
| `FOUND_ROLL_RELAY_BASE_URL` | HTTPS base URL of the separately deployed simulator. |
| `FOUND_ROLL_RELAY_API_KEY` | Bearer credential; its value must equal the simulator's `SIMULATOR_API_KEY`. |
| `FOUND_ROLL_RELAY_CUSTODIAN_ID` | Canonical relay custodian namespace, `northport-air`. |
| `FOUND_ROLL_RELAY_DESTINATION` | Disclosed simulated destination label. |
| `FOUND_ROLL_RELAY_CALLBACK_MAX_AGE_SECONDS` | Maximum signed-callback timestamp skew, default 300 seconds. |
| `FOUND_ROLL_SECRET_PEPPER` | HMAC pepper for private-answer and local credential hashes. |
| `FOUND_ROLL_RELAY_SHARED_SECRET` | Simulator callback verification secret. |
| `FOUND_ROLL_ALLOWED_ORIGINS` | Comma-separated browser origins. |
| `FOUND_ROLL_DEMO_MODE` | Enables the local synthetic reset endpoint. |

Inject the pepper, demo, admin, staff, supervisor, simulator API, simulator token, and callback values from eight explicit Secret Manager resources as mapped in `docs/deployment.md`. Do not place their values in source, Docker build arguments, deployment manifests, screenshots, or logs. The inventory URL and actor IDs are configuration, not credentials; no raw secret belongs in compiled browser code.

Production startup fails closed unless Firestore, an explicitly synthetic reset namespace, a reachable private GCS evidence bucket, mutually distinct non-default pepper/demo/admin/staff/supervisor/relay-API/callback values, distinct staff and supervisor actor IDs, Vertex ADK with the HTTP inventory gateway and an HTTPS simulator URL, HTTP relay, Cloud Tasks, task OIDC checks, a task service account, an exact HTTPS `FOUND_ROLL_PUBLIC_BASE_URL`, and a Google Cloud project are configured. The public base URL must be supplied on the first production revision; a localhost default followed by a post-start update cannot work.

## Safe request correlation

Every HTTP response returns `X-Found-Roll-Correlation-ID`. A caller may provide an ID containing 8–64 ASCII letters, digits, periods, underscores, colons, or hyphens; invalid or absent values are replaced with an opaque generated ID. The same bounded ID is propagated on service-to-simulator inventory and relay requests.

The request completion logger installs its own INFO-level, content-blind JSON handler and emits only `service`, `correlation_id`, `http_method`, the FastAPI route template, `status_code`, and `latency_ms`. Uvicorn's raw access logger is disabled in application configuration and the production command also uses `--no-access-log`; HTTPX request logging is held at warning level. The safe logger never records the raw path, query string, body, authorization or operator headers, claimant answer, one-time token, model prompt, model response, or remote exception text. Invalid correlation values are not echoed or logged.

Cloud Tasks uses task names that are deterministic within one committed workflow epoch. Each synthetic reset creates a new internal epoch so Cloud Tasks' task-name retention window cannot strand the next demo run. If the initial `create_task` response is ambiguous, the operator reconciler republishes the opaque row; a Google `AlreadyExists` response within that epoch is treated as an idempotent enqueue success. Cloud publication and replay receipts expose identifiers and sanitized status only, never the task body. The local inline adapter alone returns the three-field opaque body for explicit in-process delivery. Neither mode returns claimant answers, one-time credentials, or exception messages.

The stable simulator boundary reads `/v1/custodians/{custodian_id}/inventory` and its item route for live analyst tools, then uses `POST /v1/relay/reservations` and reservation-scoped `/credentials`, `/attestations`, and `/handoff-attestation` routes for custody work. Inventory responses must carry both the `SIMULATED` header and the typed disclosure envelope. Every mutation carries `Authorization: Bearer <FOUND_ROLL_RELAY_API_KEY>`, optimistic versions/eTags, an idempotency key, actor, reason, and non-empty evidence references. The callback verifier reserializes the parsed artifact body as sorted compact UTF-8 JSON and verifies `X-Found-Roll-Simulator-Signature: v1=<HMAC-SHA256>` over `<X-Found-Roll-Simulator-Timestamp>.<canonical body>`. The timestamp is Unix epoch seconds and is subject to the configured freshness window. `FOUND_ROLL_RELAY_SHARED_SECRET` must equal the simulator's `SIMULATOR_CALLBACK_SECRET`; the service never receives the simulator's separate `SIMULATOR_TOKEN_SECRET`.

## Google integrations

The live adapter is pinned to `google-adk==2.8.0` and `google-genai==2.20.0` and uses `LlmAgent`, a typed Pydantic `output_schema`, `Runner.run_async`, an ephemeral `InMemorySessionService`, and `RunConfig(max_llm_calls=8)`. Its exact instruction and structured request builder are isolated in `app/agent_contract.py` as `found-roll-case-analyst-prompt-v1`; the typed proposal is `found-roll-analysis-proposal-v1`, and deterministic custody policy is `found-roll-release-v1`. Health and snapshots expose those non-secret identifiers so canonical receipts can match them to the submitted source hashes. It sets ADK's current `GOOGLE_GENAI_USE_ENTERPRISE=TRUE` selector and the pinned Gen AI SDK's `GOOGLE_GENAI_USE_VERTEXAI=true` selector before the run. Authorized GCS previews are supplied with `google.genai.types.Part.from_uri`; staff-only originals, non-GCS records, and the restricted expected answer are omitted. The evidence boundary additionally pins `google-cloud-storage==3.13.1`, `Pillow==12.1.1`, and `python-multipart==0.0.32`. Firestore mutation bundles transact the case version, event, idempotency receipt, and any outbox/handoff/token records together. Cloud Tasks uses a deterministic task name and OIDC service account; the app then verifies the Google-signed ID token again at `/tasks/outbox`.

Relevant primary documentation:

- [ADK project structure and typed agent setup](https://google.github.io/agents-cli/guide/project-structure/)
- [ADK session and runner model](https://google.github.io/adk-docs/sessions/session/)
- [ADK runner interface](https://github.com/google/adk-python/blob/main/.agents/skills/adk-architecture/references/interfaces/runner.md)
- [Firestore transaction client](https://docs.cloud.google.com/python/docs/reference/firestore/latest/google.cloud.firestore_v1.transaction.Transaction)
- [Cloud Tasks HTTP targets](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks)

The fixture analyst is never acceptable for the canonical video. Before making a live claim, verify fresh Vertex traces, the pinned model ID, Firestore documents, Cloud Tasks OIDC delivery, the separate relay HTTPS call, and callback replay behavior in the deployed revision.
