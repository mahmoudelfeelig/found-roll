# Found Roll evaluation plan

Found Roll uses two deliberately separate evidence layers:

- the frozen local suite verifies implemented deterministic policy, domain, API, idempotency, fixture-agent, and publication-privacy behavior; and
- a later canonical suite must verify Gemini, Google ADK, and deployed Google Cloud behavior.

A green local suite is **not** a Gemini-quality result, Cloud deployment result, or submission-complete status. The machine-readable local matrix is `evaluation/fixtures.json`; its results are written to `evaluation/results.json`.

## Frozen local execution boundary

| Component | Local evaluation mode |
| --- | --- |
| Repository | In-memory repository |
| Analyst | Deterministic `FixtureCaseAnalyst`; no model |
| Tasks | Inline task handler |
| Relay | In-process `FixtureRelayGateway`, except FR-015’s injected ambiguous failure |
| Network | FastAPI `TestClient`, in-process |
| Gemini calls | 0 |
| Google Cloud calls | 0 |
| Supported claim | Implemented local safety and contract behavior on 15 synthetic scenarios |

This boundary is embedded in both fixture and result JSON. It must remain visible in any public summary.

## FR-001 through FR-015

| ID | Executed local scenario | Implemented primitive under test | Required observation |
| --- | --- | --- | --- |
| FR-001 | Complete synthetic valuable-item path to closure, then replay the completed release task | Custody service, policy, state machine, fixture analyst/relay, inline outbox, manifest | `CLOSED`; internally consistent 19-event manifest; `physical_transfer_proven=false`; replay adds zero events |
| FR-002 | Walk every declared custody edge and attempt unsafe direct transitions to `RELEASED` | State-transition graph | All declared edges accepted; all five unsafe skips rejected |
| FR-003 | Give visual/candidate evidence but no accepted private evidence | Deterministic release policy | `REQUEST_EVIDENCE`; no handoff authorization |
| FR-004 | Evaluate valuable-item policy without identity, without approval, then with both | Deterministic human gates | Review, review, then `ALLOW_HANDOFF` |
| FR-005 | Mark the item sensitive despite otherwise complete evidence | Risk policy | `DENY` with specialist-policy reason |
| FR-006 | Submit the dangerous branch at pre-intake | Intake API and safety boundary | No accepted intake, record, model call, or passport-count change |
| FR-007 | Submit four wrong private answers through rotated one-time links | Claim-link lifecycle, claim-evidence API, wrong-attempt policy, event response | Every submission consumes its case/version-scoped link; rejected answers receive a replacement for the new version; fourth attempt reaches `MANUAL_REVIEW`; restricted values/digests stay absent |
| FR-008 | Run the canonical candidate packet through the deterministic fixture analyst | Typed local analyst proposal | Canonical candidate selected, claim acceptance remains false, question is non-leading, restricted fields excluded |
| FR-009 | Make the highest-scoring candidate route-incompatible | Deterministic analyst hard filter | Incompatible candidate excluded; eligible runner-up selected; claim acceptance remains false |
| FR-010 | Make every candidate ineligible | Deterministic analyst hard filter | Stable `no_eligible_candidates`; no invented candidate |
| FR-011 | Submit claim evidence with a stale case version | Repository expected-version guard | HTTP 409 `stale_case_version`; zero event delta |
| FR-012 | Deliver the same analysis task twice | Outbox/task idempotency | Second delivery is replayed; zero duplicate events |
| FR-013 | Inject hostile instructions into untrusted evidence, then capture the opaque task plus staff/publication surfaces | Prompt-injection boundary, typed payload, response exclusion | Injected text cannot change ranking or authorize a claim; one bounded discriminator remains; task contains only schema/case/outbox IDs; no private answer or restricted hash/token fields; artifact is `fr-013-staff-publication-surfaces.json` |
| FR-014 | Expire a claimant link, then present and replay a handoff credential | Claim-link expiry, credential consumption, repository mutation | Expired link returns `claim_link_expired` with zero event delta; first handoff presentation succeeds; replay returns `token_replayed` with zero event delta |
| FR-015 | Inject an ambiguous relay outcome after release intent | Outbox failure and reconciliation guard | `RECONCILIATION_REQUIRED`; outbox `FAILED`; automatic retry rejected; relay called once |

The matrix is intentionally implementation-shaped. It does not relabel policy branch tests as independent real-world recovery cases, and it does not count deterministic analyst behavior as Gemini accuracy.

## Local release gates

| Gate | Pass condition |
| --- | --- |
| Scenario matrix | FR-001 through FR-015 all pass from isolated app instances |
| Dangerous pre-intake | No case, task, or model work created |
| Invalid handoff prevention | Visual-only, missing-human-gate, sensitive, stale, replay, and ambiguous outcomes never close a case |
| Idempotency | Duplicate analysis/release work adds zero events |
| Credential replay | Reuse returns a safe conflict and adds zero events |
| Claimant-link lifecycle | Missing, wrong-case, stale-version, expired, and replayed links fail closed; a wrong answer consumes and rotates the link; no raw token or digest enters the purpose-built claimant projection or staff/publication output |
| Prompt injection | Untrusted instruction text cannot add authority, change the deterministic candidate result, or remove the bounded next-evidence question |
| Reconciliation | Unknown remote outcome does not infer success or automatically call the relay twice |
| Manifest | Closed local case recomputes and explicitly denies physical-transfer proof |
| Publication privacy | Strict text scan has zero findings and zero oversized-file skips; unsupported binaries are counted separately |
| Scanner behavior | Clean fixture passes; deliberately leaky fixture fails; JSX/Mermaid text is scanned; unsupported binaries are reported; neither console nor report contains the raw canary |

The local status is `LOCAL_PASS_CANONICAL_INCOMPLETE` only when every local scenario and scanner gate passes. Any canonical requirement remains incomplete regardless of local status.

## Frozen local metrics

The local runner publishes these deterministic fixture metrics so they cannot be confused with later live-model metrics:

| Metric | Frozen evaluated fixtures | Current result and threshold |
| --- | --- | --- |
| Candidate retrieval in top three | FR-008 and FR-009 | **2/2 descriptive proxy**; required minimum 12 fixtures, `sample_sufficient=false`, threshold `INCOMPLETE` |
| Question-bearing usefulness | FR-008, FR-009, and FR-013 | **3/3 descriptive proxy**; FR-003 and FR-010 have no candidate packet/question and are `evaluable=false`; `threshold_evaluated=false`, `threshold_passed=null`, status `DESCRIPTIVE_PROXY_INSUFFICIENT_SAMPLE` |

For the descriptive usefulness proxy, useful means an actual candidate packet fails closed and asks one actionable private discriminator. Outputs without a candidate packet/question are not evaluable. Model grading cannot satisfy a release gate, these samples are too small to evaluate a threshold, and the local values may not be promoted into canonical Gemini results.

## Privacy scanner scope

`scripts/privacy-scan.py` accepts digest-only canaries: SHA-256, exact character length, and a non-secret label. It hashes same-length windows in artifacts and records rule ID, file, line, and column only. Reports never contain the canary or matched value.

The strict text publication scan covers:

- `src/`;
- text files in `dist/client/`;
- generated staff/publication artifacts under `evaluation/artifacts/publication/`, including `fr-013-staff-publication-surfaces.json`;
- the generated local evaluation receipt at `evaluation/results.json`; and
- existing JSON verification receipts under `artifacts/verification/`.

It checks the synthetic private-answer digest, raw credentials issued during the evaluation run, embedded credential URI shapes, restricted persistence-field shapes, raw authorization-header shapes, and signed-URL secret shapes.

The README and `docs/` receive an additional canary-only scan because technical documents legitimately name forbidden field/pattern classes. Server fixture source and deterministic test/smoke inputs are explicitly allowlisted for the synthetic answer so the suite is reproducible; they are not staff/publication or claimant surfaces. This allowlist does not extend to `src/`, the built client, purpose-built claimant responses, staff/publication artifacts, logs, screenshots, receipts, or README prose advertising the value.

The scanner counts unsupported binary files by extension instead of silently implying that their contents were checked. It does not OCR screenshots or decode QR images. Built-client image assets and existing design-QA screenshots receive a separate visual spot check; recorded submission media and every canonical log, trace, screenshot, video, and deployed receipt still require a publication review and are never represented as text-scan zeroes.

## Reproducible local commands

From the repository root, using the service virtual environment:

```powershell
npm test
service\.venv\Scripts\python.exe -m py_compile evaluation\run_evaluation.py scripts\privacy-scan.py evaluation\test_privacy_scan.py
service\.venv\Scripts\python.exe -m pytest evaluation\test_privacy_scan.py -q
service\.venv\Scripts\python.exe evaluation\run_evaluation.py
service\.venv\Scripts\python.exe scripts\privacy-scan.py --root src --root dist\client --root evaluation\artifacts\publication --root evaluation\results.json --root artifacts\verification --canary-manifest evaluation\privacy-canaries.json --output evaluation\privacy-scan-results.json --fail-on-findings
service\.venv\Scripts\python.exe scripts\privacy-scan.py --root README.md --root docs --canary-manifest evaluation\privacy-canaries.json --output evaluation\privacy-scan-docs-results.json --canaries-only --fail-on-findings
```

The broader local component suites are run independently. Run the service command from the repository root:

```powershell
service\.venv\Scripts\python.exe -m pytest -o addopts= -q service\tests
```

Run the simulator command from `simulator/` so its `app` package resolves:

```powershell
.venv\Scripts\python.exe -m pytest -q
```

Record component-suite counts only from fresh frozen-commit output and the checked verification receipts. The evaluation result itself is reported from `evaluation/results.json`, not inferred from those component suites.

Do not put a raw answer, one-time credential, bearer key, callback secret, signed URL, or authorization header in a command line or receipt.

## Canonical live-only requirements

The following remain unmeasured until a deployed run produces receipts:

- live pinned `gemini-3.5-flash` invocation through Vertex AI;
- Google ADK tool trajectory, typed output, run ID, and trace correlation;
- submitted Cloud Run app and simulator revisions;
- Firestore durability and real transaction contention;
- Cloud Storage object generation, derivative provenance, evidence digests, exact-retry behavior, and proof that only the complete current-workflow-epoch pair is active;
- Cloud Tasks Google-signed OIDC delivery and at-least-once retry behavior;
- authenticated HTTP simulator calls and signed handoff-attestation artifacts over deployed HTTPS;
- Cloud Logging/trace privacy export for the exact canonical time range;
- five fresh reset-to-close runs without manual database repair; and
- clean-browser hosted UI behavior against the submitted API revision.

The canonical report must list the submitted commit, model/prompt/schema/policy versions, both service revisions, fixture digest, case/task/model-run/trace identifiers, object generations, final event hashes, privacy-scan scope, failures, retries, and exclusions. It must bind `found-roll-case-analyst-prompt-v1` to the SHA-256 of `service/app/agent_contract.py`, `found-roll-analysis-proposal-v1` to `service/app/domain.py`, and `found-roll-release-v1` to `service/app/policy.py`; both the release record and every completed run receipt must agree. It must never store private values or prompt/model content.

## Canonical metrics

Only the deployed suite may report the following as live/canonical metrics. The deterministic local top-three and usefulness values above remain separately labeled and cannot fill these rows:

| Metric | Required reporting |
| --- | --- |
| Live model candidate retrieval | Numerator, denominator, per-fixture outputs, exact model/configuration; no broad accuracy claim |
| Critical abstention | Every ambiguous, missing-evidence, prompt-injection, restricted, and unavailable-tool run disclosed |
| Next-evidence usefulness | Published rubric and actual numerator/denominator; model grading cannot certify release safety |
| ADK trajectory conformance | Actual tool order, permission/schema failures, and run IDs |
| Cloud idempotency | Duplicate task/callback side-effect delta |
| Canonical reliability | Actual completed fresh runs out of five |
| Cloud privacy | Exact log/trace/artifact time range and unresolved finding count |

Targets are not results. A missing live run, trace, Cloud state receipt, or privacy export is `INCOMPLETE`, not zero and not a pass.

## Claim language

Allowed after the local suite passes:

> Fifteen frozen local synthetic scenarios passed against the deterministic policy/domain/API implementation. The run used an in-memory repository, deterministic fixture analyst, inline tasks, and in-process fixture relay; it made no Gemini or Google Cloud calls.

Also allowed when reported with that boundary in the same paragraph:

> On the frozen deterministic fixtures, the descriptive top-three proxy was 2/2 and the descriptive usefulness proxy was 3/3 among question-bearing packets. Both samples were insufficient and their thresholds remain incomplete. Prompt-injection text remained inert, and an expired claimant link failed closed with zero event delta.

Not allowed from the local suite:

- “15 Gemini evaluations passed”;
- “candidate accuracy is 100%”;
- “Cloud retry safety is proven”;
- “production privacy is verified”;
- “ownership, identity, possession, or a physical handoff was proven”; or
- “the submission is fully evaluation-green.”

Even after every local gate passes, publication remains blocked on the live Gemini/ADK and Google Cloud run receipts. The research-informed story mode is confirmed; repository/tag judge access and the verified public video URL are additional submission blockers outside this evaluation protocol.
