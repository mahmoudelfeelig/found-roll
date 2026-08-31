# Found Roll

Found Roll is a policy-bound recovery workflow for lost property that falls between separate custodians. Deterministic policy fixes the eligible candidate packet and allowed private discriminator. A bounded Gemini/Google ADK analyst may inspect that authorized packet and propose source-linked observations plus one non-leading question; deterministic code owns claim-evidence acceptance, identity and approval gates, custody state, one-time credentials, idempotency, and the final event manifest.

The product is designed like practical early-2010s photo-organizer software rather than a contemporary AI dashboard. The agent is visible through its work and audit trail, not through a chat interface.

Public source: [github.com/mahmoudelfeelig/found-roll](https://github.com/mahmoudelfeelig/found-roll). Found Roll's original project code is MIT-licensed; bundled-template and third-party boundaries are recorded in `NOTICE.md` and `THIRD_PARTY_NOTICES.md`.

## What the demo proves

- One report begins with a fictional Grand Hall → Metro Loop → Northport Air route; the custody engine sends the analyst only to the currently eligible custodian inventories.
- An ordinary intake is armed only after the combined demo-and-staff boundary accepts it. Once staff explicitly authorizes a derived model preview, the service itself commits the bounded-analysis outbox command for that immutable pair and queues it; the browser only observes and polls the result. The public manual-analysis route refuses armed intakes.
- Visual similarity alone is refused. The deterministic custody engine fixes the candidate ordering and allowed private discriminator; the bounded analyst can only formulate a typed, source-linked question proposal within that boundary. It cannot assert claim sufficiency, accept a claim, or mutate custody.
- The valuable camera-pouch fixture needs an exact private serial fragment, a staff identity attestation, and supervisor approval.
- Reservation and release use an outbox boundary, expected versions, remote eTags, and idempotency keys.
- A separately deployable `SIMULATED Relay Post` records two scoped token presentations and returns a signed service attestation.
- Duplicate token or callback delivery cannot create a second custody event.
- The final Item Passport is an internally consistent, application-enforced hash-linked event manifest. It is not independent proof of ownership, identity, possession, or a physical handoff.

Northport Air, Metro Loop, Grand Hall, Relay Post, every inventory row, every route event, and every photo are fictional or synthetic. The relay is always simulated. Live mode uses real Google ADK, Gemini, Cloud Run, Firestore, Cloud Storage, and Cloud Tasks execution only when the required project configuration is present.

## Product surfaces

The hosted root is a public, non-mutating Judge Walkthrough for the fixed completed synthetic case. It accepts no credentials and exposes only a redacted status/timeline, bounded-analyst metadata, and internal manifest-consistency summary. It omits claimant evidence, restricted media, task bodies, raw actor IDs, idempotency keys, and model trace IDs; it neither proves ownership nor possession nor performs a physical handoff.

No public proof-of-action receipt is implemented or published. A future public artifact is a release-checklist item only and requires explicit authorization plus a separate privacy review before it can be designed, exposed, or described as evidence. It would not replace the private five-run evidence set, an independent ledger, model-quality evidence, or proof of ownership, identity, possession, or physical handoff.

The staff workspace contains the custodian folder tree, dated evidence library, candidate metadata comparison, staff-only detail, evidence tray, release-policy inspector, credential state, and Item Passport playback in one dense desktop shell. Before all three runtime roles authenticate and the service returns an authoritative projection, that URL is a neutral locked shell with no case, candidate, timeline, or agent-run data. Once authenticated, it loads the active server-derived preview for the current workflow epoch. If that preview is unavailable, the workspace shows an unavailable state rather than substituting unrelated fixture media.

The private claimant proof page exposes one non-leading question and no candidate library or staff-only evidence. Its one-time link is bound to one case version and expiry: only a keyed digest is persisted, while the raw token travels in the URL fragment, is immediately removed from the address bar, and remains in that browser tab's memory. A submission consumes the link; a wrong answer rotates it to the new case version, and expired, replayed, wrong-case, or stale-version links fail closed.

The hosted browser has three reusable runtime credential boundaries, not one shared role: `X-Found-Roll-Demo-Token` for the synthetic demo workflow, `X-Found-Roll-Staff-Token` for production rich reads plus evidence, identity attestation, and release confirmation, and `X-Found-Roll-Supervisor-Token` for approval. Intake, claimant-link issuance, and duplicate release-task delivery require both the demo and staff credentials. Before any role is shown as loaded, one strict, non-mutating probe validates all three values—even in development—and returns the configured staff and supervisor actor IDs. The server records those exact IDs without adding prefixes; conflicting optional legacy actor fields are rejected. All credentials and resulting private session state remain in memory only and are cleared together. Admin reset/recovery authority is never accepted by the browser. The claimant uses a separate purpose-built link projection rather than a staff passport response.

## Judge testing

The public [Judge Walkthrough](https://found-roll-app-1061926987746.us-central1.run.app/?view=walkthrough) is the quickest no-credential check: it proves that the hosted root is read-only, redacted, and visually grounded in a closed synthetic case. It cannot mutate a case, reveal protected media, or stand in for the protected workflow.

For a free local review, install the locked dependencies described below and run `npm test` plus `service\.venv\Scripts\python.exe -m pytest service\tests`. Those checks exercise the deterministic fixture, evidence/consent boundaries, auto-queue contract, state transitions, retries, and privacy surfaces without Google Cloud credentials, paid APIs, user media, or a billing account. They prove local contracts only; live Google Cloud claims require a separately frozen tagged release and its private evidence gate.

## 90-second judge route

| Window | Open or verify | What it establishes |
| --- | --- | --- |
| 0:00–0:20 | The public Judge Walkthrough | The hosted surface is synthetic, redacted, read-only, and does not expose credentials or protected media. |
| 0:20–0:40 | The walkthrough's timeline and limitation copy | The fixed case is synthetic and public access remains a redacted, non-mutating product surface rather than workflow evidence. |
| 0:40–1:05 | The [architecture diagram](docs/architecture-diagram.png) and its [authority explanation](docs/architecture.md) | The agent is confined to a deterministic packet and proposal tools; policy and humans own evidence acceptance and release. |
| 1:05–1:30 | The public repository's evaluation and release disclosures | Local results remain local; the private five-run gate and recorded Google Cloud evidence carry the operational release claim. |

No public proof-of-action artifact belongs in this route until it has separately received explicit authorization and privacy review.

## Local web prototype

Requirements: Node.js 24 and npm.

```powershell
npm ci --prefer-offline --no-audit --no-fund
npm run dev -- --host 127.0.0.1
```

The root defaults to the public Judge Walkthrough and uses only the non-mutating public `/api/v1/healthz` and `/api/v1/judge-walkthrough` reads; if the read-only service projection is unavailable, it shows an unavailable state rather than private fixture data. The protected staff workspace is at `?view=staff`. In a combined app image it probes `/api/v1/healthz` and distinguishes fixture from live Vertex ADK mode. The namespaced route avoids the Google Frontend 404 observed at the exact `/healthz` path on the deployed Cloud Run service; `/healthz` remains available for container-local probes.

The deterministic synthetic answer remains in server-side fixture/test material for reproducibility; it is not compiled into the browser. In connected mode, the operator loads the separate demo, staff, and supervisor runtime credentials through the staff control. The browser proves all three through the strict runtime-role probe, then sends each only to its matching boundary and never stores them beyond the tab.

Empty, partial, or rejected configuration clears credentials, claimant links, handoff tokens, pending intake state, task receipts, manifest data, and private evidence URLs. For an ordinary intake, the service queues the bounded analyst only after staff authorizes the derived preview; the browser receives the queue receipt and observes it rather than creating an analysis job itself.

The operator then uses the action strip to issue a case/version-scoped claimant link, submit evidence through that private link, record the staff identity attestation, obtain supervisor approval, reserve Relay Post, present both handoff credentials, complete the simulated delivery, and queue one duplicate task delivery. A consumed credential is rejected; the duplicate completed delivery is acknowledged idempotently without appending another event.

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

Open `http://127.0.0.1:8080/` to inspect the public redacted walkthrough, or `http://127.0.0.1:8080/?view=staff` for the protected staff workspace. The staff status bar must report the connected deterministic fixture analyst; `http://127.0.0.1:8080/api/v1/healthz` must report `inventory_mode=http`, `inventory_gateway_ready=true`, and `relay_mode=http`. Load the three local demo, staff, and supervisor values above into their matching password fields for this tab; the all-three probe must succeed before the staff projection loads. The UI's **Refresh case** command only reloads authoritative state; it does not reset either service. Restart both local processes for a fresh local repeat. For a deployed canonical run, reset and upload the frozen evidence pair from an authenticated terminal or Cloud Shell with `scripts/prepare-canonical-run.ps1`; no browser reset exists and the admin credential must never enter the frontend.

Local fixture mode is intentionally not acceptable evidence for the canonical hackathon video. The live recording keeps one prepared synthetic case legible while correlating it to the serving Cloud Run revision, its Firestore state, its Cloud Task, and its bounded Gemini/ADK evidence. It also shows the separate simulator request and one duplicate completed-release task delivery acknowledged without another custody event. Consumed-token and callback-idempotency negatives remain machine-receipt evidence rather than promised UI controls. A public proof-of-action artifact is not part of the current UI or recording scope.

## Verification

Frontend, fixture-domain, and Sites packaging:

```powershell
npm run build
npm test
```

Frozen 16-case deterministic evaluation:

```powershell
service\.venv\Scripts\python.exe evaluation\run_evaluation.py
```

Service and simulator verification commands are documented within each service. The final all-in-one verification script is `scripts/verify-all.ps1`. The Python contract smoke in `scripts/http-integration-smoke.py` exercises the service-to-simulator boundary, while `scripts/service-client-http-smoke.mjs` drives the authoritative browser client through the complete HTTP workflow. Their latest identifier-only receipts are stored under `artifacts/verification/`.

The checked design report is [`design-qa.md`](design-qa.md). Its screenshots and findings are a historical period-style and layout reference, not evidence for the current release workflow. Regenerate the viewports from the frozen submission build before using them in publication.

Use fresh command output and the checked machine-readable receipts for component-test counts. The current frozen evaluation report records **16/16 local synthetic scenarios**, including a deterministic abstention-branch mechanics check. Candidate retrieval in the top three is only a **2/2 descriptive proxy** and usefulness is only **3/3 among question-bearing packets**. Both proxy samples are insufficient; their canonical thresholds remain `INCOMPLETE`, not passed. The deterministic run made **0 Gemini calls and 0 Google Cloud calls** and does not satisfy the canonical live gate.

Synthetic media provenance and dependency notices are recorded in [`public/assets/README.md`](public/assets/README.md), [`NOTICE.md`](NOTICE.md), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

The canonical reset and model-evidence gate is automated by [`scripts/prepare-canonical-run.ps1`](scripts/prepare-canonical-run.ps1). It reads credentials only from the process environment and writes live identifiers to the ignored `artifacts/private/` area. Capture the canonical run start immediately before invoking preparation; the run interval intentionally includes the reset event. Preparation resets the frozen case, confirms canonical health including the prompt/schema/policy contract versions and `inventory_legacy_health_compatibility=false`, creates a workflow-epoch-scoped idempotency key, proves exact upload replay and changed-command conflict behavior, and verifies that exactly one complete current-epoch original/preview pair is active before analysis. Run it separately inside each of the five canonical executions so every execution has a unique preparation receipt and workflow epoch. The checked local rehearsal receipt under [`artifacts/verification/`](artifacts/verification/local-canonical-preparation-receipt.json) exercises the analogous loopback boundary without claiming a canonical cloud run.

The final offline freeze gate is [`scripts/verify-submission-readiness.mjs`](scripts/verify-submission-readiness.mjs). Copy [`docs/submission-release.template.json`](docs/submission-release.template.json) to ignored `artifacts/private/submission-release.json`, fill it only from verified release evidence, and run:

```powershell
node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json
```

It fails closed unless the release binds the clean tagged Git tree, required file and source hashes, the deterministic `dist/client` build manifest, a current schema-v2 direct entrant Free Trial/service-cap attestation plus live CLI billing-link/open-account evidence, five unique preparation/run/chain-audit triples, canonical privacy coverage, filmed run, clean-browser receipt, repository access, video limits, and explicit human attestations. It recomputes each 19-event chain and closure manifest, performs no network calls, and never upgrades local fixture evidence into a canonical result. Before deployment APIs are enabled, the checked preflight refresh script performs the live CLI reads and runs the narrower `--preflight-only` gate.

## Architecture and submission material

- [`docs/architecture.md`](docs/architecture.md) — system diagram, authority boundary, event flow, state model, real-versus-simulated table.
- [`docs/architecture-diagram.png`](docs/architecture-diagram.png) — rendered judge-facing architecture image with the simulator boundary permanently labeled.
- [`docs/deployment.md`](docs/deployment.md) — two-service Cloud Run setup, service accounts, Firestore, Storage, Tasks, secrets, verification, and rollback.
- [`docs/threat-and-privacy.md`](docs/threat-and-privacy.md) — staff, claimant, and restricted evidence boundaries, logging rules, token and callback threats, IAM limits.
- [`docs/evaluation-plan.md`](docs/evaluation-plan.md) — frozen fixtures, metrics, failure cases, and live-run evidence requirements.
- [`docs/evaluation.md`](docs/evaluation.md) — verified local results with explicit limits and a separate account of operational cloud-release evidence.
- [`docs/demo-script.md`](docs/demo-script.md) — a 3:48 recording plan that keeps one matching Cloud Run/case/task/model proof legible.
- [`docs/devpost-submission.md`](docs/devpost-submission.md) — release-bound submission copy whose cloud claims are valid only for the public `v1.0.0` tag.
- [`docs/google-cloud-billing-preflight.template.json`](docs/google-cloud-billing-preflight.template.json) and [`docs/google-cloud-spend-cap.template.json`](docs/google-cloud-spend-cap.template.json) — fail-closed schema-v2 private receipt shapes for direct entrant Free Trial/service-cap attestation and live CLI billing-link/open-account binding; public APIs do not expose the Preview spend-cap enforcement state.
- [`docs/canonical-run.template.json`](docs/canonical-run.template.json), [`docs/chain-audit.template.json`](docs/chain-audit.template.json), [`docs/canonical-privacy.template.json`](docs/canonical-privacy.template.json), and [`docs/clean-browser.template.json`](docs/clean-browser.template.json) — fail-closed private receipt shapes for the five live executions, recomputable event chains, and final publication review.

## Submission blockers that cannot be fabricated

The repository never converts the 16/16 deterministic suite into a live-model accuracy claim. For public `v1.0.0`, the stable hosted URL, exact source-deployed app/simulator revisions, five live Gemini/Google ADK workflows, Free Trial boundary, required APIs/IAM/quota, storage ceiling, log privacy, clean Chrome behavior, and immutable Git commit are all bound by fail-closed private receipts before the tag is published. The entrant has confirmed entrant/team eligibility, official rules, ownership, required authorizations, new-project status, and the research-informed—not first-person—inspiration mode. A public video URL and its verified duration can exist only after the continuous take is recorded and uploaded, and the final Devpost action remains deliberately manual; neither is fabricated in repository history.

Found Roll's original project code is released under the [MIT License](LICENSE). Third-party dependencies and the bundled prototype-template boundary retain their upstream terms as recorded in [`NOTICE.md`](NOTICE.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the MIT grant does not relicense those materials.
