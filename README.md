# Found Roll

Found Roll is a policy-bound recovery workflow for lost property that falls between separate custodians. A bounded Gemini/Google ADK analyst searches authorized evidence and asks for the minimum missing private fact; deterministic code owns claim-evidence acceptance, identity and approval gates, custody state, one-time credentials, idempotency, and the final event manifest.

The product is designed like practical early-2010s photo-organizer software rather than a contemporary AI dashboard. The agent is visible through its work and audit trail, not through a chat interface.

## What the demo proves

- One report searches the fictional Grand Hall, Metro Loop, and Northport Air inventories.
- Visual similarity alone is refused. The bounded analyst can rank candidates but cannot accept a claim or mutate custody.
- The valuable camera-pouch fixture needs an exact private serial fragment, a staff identity attestation, and supervisor approval.
- Reservation and release use an outbox boundary, expected versions, remote eTags, and idempotency keys.
- A separately deployable `SIMULATED Relay Post` records two scoped token presentations and returns a signed service attestation.
- Duplicate token or callback delivery cannot create a second custody event.
- The final Item Passport is an internally consistent, application-enforced hash-linked event manifest. It is not independent proof of ownership, identity, possession, or a physical handoff.

Northport Air, Metro Loop, Grand Hall, Relay Post, every inventory row, every route event, and every photo are fictional or synthetic. The relay is always simulated. Live mode uses real Google ADK, Gemini, Cloud Run, Firestore, Cloud Storage, and Cloud Tasks execution only when the required project configuration is present.

## Product surfaces

The staff workspace contains the custodian folder tree, dated evidence library, candidate metadata comparison, staff-only detail, evidence tray, release-policy inspector, credential state, and Item Passport playback in one dense desktop shell. Once authenticated, it loads the active server-derived preview for the current workflow epoch. If that preview is unavailable, the workspace shows an unavailable state rather than substituting unrelated fixture media.

The private claimant proof page exposes one non-leading question and no candidate library or staff-only evidence. Its one-time link is bound to one case version and expiry: only a keyed digest is persisted, while the raw token travels in the URL fragment, is immediately removed from the address bar, and remains in that browser tab's memory. A submission consumes the link; a wrong answer rotates it to the new case version, and expired, replayed, wrong-case, or stale-version links fail closed.

The hosted browser has three reusable runtime credential boundaries, not one shared role: `X-Found-Roll-Demo-Token` for the synthetic demo workflow, `X-Found-Roll-Staff-Token` for production rich reads plus evidence, identity attestation, and release confirmation, and `X-Found-Roll-Supervisor-Token` for approval. Intake, claimant-link issuance, and duplicate release-task delivery require both the demo and staff credentials. Before any role is shown as loaded, one strict, non-mutating probe validates all three values—even in development—and returns the configured staff and supervisor actor IDs. The server records those exact IDs without adding prefixes; conflicting optional legacy actor fields are rejected. All credentials and resulting private session state remain in memory only and are cleared together. Admin reset/recovery authority is never accepted by the browser. The claimant uses a separate purpose-built link projection rather than a staff passport response.

## Local web prototype

Requirements: Node.js 24 and npm.

```powershell
npm ci --prefer-offline --no-audit --no-fund
npm run dev -- --host 127.0.0.1
```

The UI defaults to an explicitly read-only deterministic browser fixture when the custody API is unavailable and labels that state in the status bar. In a combined app image it probes `/healthz` and distinguishes fixture from live Vertex ADK mode.

The deterministic synthetic answer remains in server-side fixture/test material for reproducibility; it is not compiled into the browser. In connected mode, the operator loads the separate demo, staff, and supervisor runtime credentials through the staff control. The browser proves all three through the strict runtime-role probe, then sends each only to its matching boundary and never stores them beyond the tab. Empty, partial, or rejected configuration clears credentials, claimant links, handoff tokens, pending intake state, task receipts, manifest data, and private evidence URLs. The operator then uses the action strip to issue a case/version-scoped claimant link, submit evidence through that private link, record the staff identity attestation, obtain supervisor approval, reserve Relay Post, present both handoff credentials, complete the simulated delivery, and queue one duplicate task delivery. A consumed credential is rejected; the duplicate completed delivery is acknowledged idempotently without appending another event.

The intake safety stop is also deterministic and tenant-aware. Passports or government IDs, payment cards, access badges, medication, suspicious packages, and unknown sensitive categories receive category-specific instructions routed to the selected custodian's specialist desk. Those branches expose no upload control, make no network request, create no case, and call no model.

## Local services

The custody service and simulator are separate Python applications. In connected mode, the bounded analyst reads authorized fictional inventory through the simulator's real HTTP contract; reservation and release use the same separate process through authenticated mutation routes. Their own READMEs contain the exact API contracts and local commands:

- [`service/README.md`](service/README.md) — deterministic authority, Firestore and Cloud Tasks adapters, bounded ADK analyst, policy, outbox, events, manifest.
- [`simulator/README.md`](simulator/README.md) — fictional custodian inventories, Relay Post reservation, credentials, attestations, signed callbacks, replay controls.

## Connected local rehearsal

This rehearsal serves the built React client and custody API together, uses the real loopback HTTP inventory/relay boundary, and keeps the analyst, repository, evidence store, and task delivery in explicit local fixture modes. It is useful for exercising the complete interface, but it is not canonical Gemini or Google Cloud evidence.

Run the one-time setup from the repository root with Node.js 24 and Python 3.11 or newer:

```powershell
npm ci --prefer-offline --no-audit --no-fund
npm run build
python -m venv service\.venv
service\.venv\Scripts\python.exe -m pip install --require-hashes -r service\requirements-dev.lock
python -m venv simulator\.venv
simulator\.venv\Scripts\python.exe -m pip install --require-hashes -r simulator\requirements-dev.lock
```

Start the disclosed simulator in one PowerShell terminal from the repository root. These values are loopback-only development fixtures; never reuse them in a deployment:

```powershell
$env:SIMULATOR_ENV = 'development'
$env:SIMULATOR_API_KEY = 'found-roll-local-simulator-key'
$env:SIMULATOR_TOKEN_SECRET = 'found-roll-local-simulator-token-secret'
$env:SIMULATOR_CALLBACK_SECRET = 'found-roll-local-relay-secret'
simulator\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir simulator --host 127.0.0.1 --port 8091 --no-access-log
```

Start the combined app in a second PowerShell terminal from the repository root:

```powershell
$env:PYTHONPATH = (Resolve-Path .\service).Path
$env:FOUND_ROLL_ENV = 'development'
$env:FOUND_ROLL_REPOSITORY = 'memory'
$env:FOUND_ROLL_EVIDENCE_STORE = 'memory'
$env:FOUND_ROLL_ANALYST_MODE = 'fixture'
$env:FOUND_ROLL_INVENTORY_MODE = 'http'
$env:FOUND_ROLL_INVENTORY_BASE_URL = 'http://127.0.0.1:8091'
$env:FOUND_ROLL_RELAY_MODE = 'http'
$env:FOUND_ROLL_RELAY_BASE_URL = 'http://127.0.0.1:8091'
$env:FOUND_ROLL_RELAY_API_KEY = 'found-roll-local-simulator-key'
$env:FOUND_ROLL_RELAY_SHARED_SECRET = 'found-roll-local-relay-secret'
$env:FOUND_ROLL_DEMO_ACCESS_TOKEN = 'found-roll-local-demo-token'
$env:FOUND_ROLL_EVIDENCE_STAFF_TOKEN = 'found-roll-local-staff-token'
$env:FOUND_ROLL_SUPERVISOR_TOKEN = 'found-roll-local-supervisor-token'
$env:FOUND_ROLL_STAFF_ACTOR_ID = 'staff.northport'
$env:FOUND_ROLL_SUPERVISOR_ACTOR_ID = 'supervisor.northport'
$env:FOUND_ROLL_TASKS_MODE = 'inline'
$env:FOUND_ROLL_DEMO_MODE = 'true'
$env:FOUND_ROLL_PUBLIC_BASE_URL = 'http://127.0.0.1:8080'
$env:PORT = '8080'
service\.venv\Scripts\python.exe -m deployment.serve
```

Open `http://127.0.0.1:8080/`. The status bar must report the connected deterministic fixture analyst; `http://127.0.0.1:8080/healthz` must report `inventory_mode=http`, `inventory_gateway_ready=true`, and `relay_mode=http`. Load the three local demo, staff, and supervisor values above into their matching password fields for this tab; the all-three probe must succeed before the staff projection loads. The UI's **Refresh case** command only reloads authoritative state; it does not reset either service. Restart both local processes for a fresh local repeat. For a deployed canonical run, reset and upload the frozen evidence pair from an authenticated terminal or Cloud Shell with `scripts/prepare-canonical-run.ps1`; no browser reset exists and the admin credential must never enter the frontend.

Local fixture mode is intentionally not acceptable evidence for the canonical hackathon video. The live recording must show the pinned model, the Vertex ADK run, Cloud Run revisions, Firestore mutations, current-epoch Cloud Storage evidence provenance, Cloud Task delivery, the separate simulator request, and one duplicate completed-release task delivery acknowledged without another custody event from the prepared reset run. Consumed-token and callback-idempotency negatives remain machine-receipt evidence; the recording does not promise separate UI controls for them.

## Verification

Frontend, fixture-domain, and Sites packaging:

```powershell
npm run build
npm test
```

Frozen 15-case deterministic evaluation:

```powershell
service\.venv\Scripts\python.exe evaluation\run_evaluation.py
```

Service and simulator verification commands are documented within each service. The final all-in-one verification script is `scripts/verify-all.ps1`. The Python contract smoke in `scripts/http-integration-smoke.py` exercises the service-to-simulator boundary, while `scripts/service-client-http-smoke.mjs` drives the authoritative browser client through the complete HTTP workflow. Their latest identifier-only receipts are stored under `artifacts/verification/`.

The checked design report is [`design-qa.md`](design-qa.md). Its screenshots and findings are a historical period-style and layout reference, not evidence for the current release workflow. Regenerate the viewports from the frozen submission build before using them in publication.

Use fresh command output and the checked machine-readable receipts for component-test counts. The current frozen evaluation report records **15/15 local synthetic scenarios**, while candidate retrieval in the top three is only a **2/2 descriptive proxy** and usefulness is only **3/3 among question-bearing packets**. Both proxy samples are insufficient; their canonical thresholds remain `INCOMPLETE`, not passed. The deterministic run made **0 Gemini calls and 0 Google Cloud calls** and does not satisfy the canonical live gate.

Synthetic media provenance and dependency notices are recorded in [`public/assets/README.md`](public/assets/README.md), [`NOTICE.md`](NOTICE.md), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

The canonical reset and model-evidence gate is automated by [`scripts/prepare-canonical-run.ps1`](scripts/prepare-canonical-run.ps1). It reads credentials only from the process environment and writes live identifiers to the ignored `artifacts/private/` area. Preparation resets the frozen case, confirms canonical health including the prompt/schema/policy contract versions and `inventory_legacy_health_compatibility=false`, creates a workflow-epoch-scoped idempotency key, proves exact upload replay and changed-command conflict behavior, and verifies that exactly one complete current-epoch original/preview pair is active before analysis. Run it separately before each of the five canonical executions so every execution has a unique preparation receipt and workflow epoch. The checked local rehearsal receipt under [`artifacts/verification/`](artifacts/verification/local-canonical-preparation-receipt.json) exercises the analogous loopback boundary without claiming a canonical cloud run.

The final offline freeze gate is [`scripts/verify-submission-readiness.mjs`](scripts/verify-submission-readiness.mjs). Copy [`docs/submission-release.template.json`](docs/submission-release.template.json) to ignored `artifacts/private/submission-release.json`, fill it only from verified release evidence, and run:

```powershell
node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json
```

It fails closed unless the release binds the clean tagged Git tree, required file and source hashes, the deterministic `dist/client` build manifest, five unique preparation/run/chain-audit triples, canonical privacy coverage, filmed run, clean-browser receipt, repository access, video limits, and explicit human attestations. It recomputes each 19-event chain and closure manifest, performs no network calls, and never upgrades local fixture evidence into a canonical result.

## Architecture and submission material

- [`docs/architecture.md`](docs/architecture.md) — system diagram, authority boundary, event flow, state model, real-versus-simulated table.
- [`docs/architecture-diagram.png`](docs/architecture-diagram.png) — rendered judge-facing architecture image with the simulator boundary permanently labeled.
- [`docs/deployment.md`](docs/deployment.md) — two-service Cloud Run setup, service accounts, Firestore, Storage, Tasks, secrets, verification, and rollback.
- [`docs/threat-and-privacy.md`](docs/threat-and-privacy.md) — staff, claimant, and restricted evidence boundaries, logging rules, token and callback threats, IAM limits.
- [`docs/evaluation-plan.md`](docs/evaluation-plan.md) — frozen fixtures, metrics, failure cases, and live-run evidence requirements.
- [`docs/evaluation.md`](docs/evaluation.md) — verified local results with explicit limits and canonical cloud evidence still required.
- [`docs/demo-script.md`](docs/demo-script.md) — a 3:35 recording plan with visible Google Cloud proof.
- [`docs/devpost-submission.md`](docs/devpost-submission.md) — submission copy with unverified fields explicitly blocked.
- [`docs/canonical-run.template.json`](docs/canonical-run.template.json), [`docs/chain-audit.template.json`](docs/chain-audit.template.json), [`docs/canonical-privacy.template.json`](docs/canonical-privacy.template.json), and [`docs/clean-browser.template.json`](docs/clean-browser.template.json) — fail-closed private receipt shapes for the five live executions, recomputable event chains, and final publication review.

## Submission blockers that cannot be fabricated

The repository deliberately does not invent a hosted Google Cloud URL or revision evidence, live Gemini/Google ADK traces, a submitted commit SHA, a repository URL and release tag with verified judge access, a public video URL and verified duration, or live-model evaluation numbers. The entrant has confirmed entrant/team eligibility, official rules, ownership, required authorizations, new-project status, and the research-informed—not first-person—inspiration mode. A dedicated Google Cloud project on an active no-charge Free Trial, required APIs, IAM authority, and quota still require direct account verification. Every remaining field stays blocked until it is filled from verified accounts and five fresh, frozen canonical Google Cloud runs.

Found Roll's original project code is released under the [MIT License](LICENSE). Third-party dependencies and the bundled prototype-template boundary retain their upstream terms as recorded in [`NOTICE.md`](NOTICE.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the MIT grant does not relicense those materials.
