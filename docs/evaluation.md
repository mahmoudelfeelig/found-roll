# Found Roll evaluation report

The current model-quality status is **local deterministic PASS; canonical quality evaluation INCOMPLETE**. The latest machine-readable receipt is `evaluation/results.json`. It records 16 passing scenarios and no failures, but it is not a Gemini-quality result or evidence of a real property transfer. Separately, the `v1.0.0` release gate requires five live operational Google Cloud workflows and privacy evidence; those receipts prove execution and boundaries, not accuracy.

## Executed boundary

| Component | What the local suite actually used |
| --- | --- |
| Repository | Fresh in-memory repository per API scenario |
| Analyst | Deterministic `FixtureCaseAnalyst` |
| Tasks | Inline task handler |
| Relay | In-process `FixtureRelayGateway`, with an injected ambiguous outcome in FR-015 |
| Network | FastAPI `TestClient`, in-process |
| Gemini calls | 0 |
| Google Cloud calls | 0 |

The scenarios are synthetic and implementation-shaped. Passing all 16 means the exercised local policy, state, API, idempotency, fixture-agent, abstention-branch, and privacy assertions held for this frozen matrix. It does not mean candidate matching has 100% real-world accuracy.

## Frozen matrix result

| ID | Local observation | Result |
| --- | --- | --- |
| FR-001 | Workflow reached `CLOSED`; 19-event manifest recomputed; `physical_transfer_proven=false`; completed release-task replay added no event | PASS |
| FR-002 | All 27 declared state edges were accepted; five unsafe direct release skips were blocked | PASS |
| FR-003 | Visual-only evidence returned `REQUEST_EVIDENCE` for missing private evidence | PASS |
| FR-004 | Missing identity and approval each required review; both gates produced policy-level `ALLOW_HANDOFF` | PASS |
| FR-005 | Sensitive property returned `DENY` with the specialist-policy reason | PASS |
| FR-006 | Dangerous pre-intake was not accepted and created no record or model work; case-count delta was zero | PASS |
| FR-007 | Each wrong answer consumed and rotated the case/version-scoped claimant link; the fourth reached `MANUAL_REVIEW`; serialized staff event output had no restricted answer/digest fields | PASS |
| FR-008 | Deterministic custody policy selected the canonical fixture candidate; the analyst abstained from claim acceptance, emitted a non-leading question, and preserved the six-call plus 2,048-output-token ADK caps | PASS |
| FR-009 | Deterministic custody policy excluded the route-incompatible top candidate and selected the eligible runner-up; the analyst still abstained | PASS |
| FR-010 | With no eligible candidate, the analyst returned `no_eligible_candidates` and invented none | PASS |
| FR-011 | Stale expected version returned HTTP 409 `stale_case_version` with zero event delta | PASS |
| FR-012 | Duplicate analysis-task delivery reported replay with zero duplicate events | PASS |
| FR-013 | Prompt-injection text remained inert and could not authorize a claim; opaque task contained only schema, case, and outbox IDs; the captured staff/publication surfaces had zero restricted findings | PASS |
| FR-014 | An expired claimant link returned `claim_link_expired` with zero event delta; first handoff-credential presentation succeeded and replay returned `token_replayed` with zero event delta | PASS |
| FR-015 | Ambiguous relay outcome reached `RECONCILIATION_REQUIRED`; outbox was `FAILED/EXECUTE`; terminal redelivery returned a non-retryable 200 acknowledgment without another relay call or event | PASS |
| FR-016 | A deterministic, no-model contract fixture validated the no-selection abstention schema and rejected mutually exclusive selection, signal, discriminator, question, and reason paths; it bound the authorized searches, policy-ranked load, and manual-review reason; the workflow reached `MANUAL_REVIEW` with a completed outbox, no candidate packet/question, and a replay that did not call the analyst again | PASS |

Aggregate: **16 / 16 passed, 0 failed**. The status string is `LOCAL_PASS_CANONICAL_INCOMPLETE` so a local green run cannot be mistaken for completion of the live evaluation.

The receipt also reports two explicitly local fixture metrics:

| Deterministic local metric | Result | Scope and interpretation |
| --- | --- | --- |
| Candidate retrieval in top three | **2/2 descriptive proxy** | Only FR-008 and FR-009 were eligible, versus a required minimum of 12 fixtures. `sample_sufficient=false`; no retrieval threshold was passed. |
| Question-bearing usefulness | **3/3 descriptive proxy** | Only FR-008, FR-009, and FR-013 produced a candidate packet and question. FR-003 and FR-010 are `evaluable=false`, not failures or successes. `threshold_evaluated=false`, `threshold_passed=null`, and the canonical threshold remains `INCOMPLETE`. |

The usefulness rubric applies only to an actual question-bearing candidate packet. Within that very small subset, the question must fail closed and request one actionable private discriminator. FR-013 is descriptively useful because injected instructions did not alter ranking or claim authority and the bounded discriminator remained intact. The receipt status is `DESCRIPTIVE_PROXY_INSUFFICIENT_SAMPLE`; neither proxy is a quality-gate result.

FR-016 is deliberately **branch-mechanics evidence**, not a model-quality datapoint: it uses synthetic calls and responses to exercise the typed abstention contract and the in-memory workflow. It makes zero Gemini calls and does not observe a live Google ADK trajectory, model abstention rate, or calibration.

## Publication privacy evidence

The digest-only scanner received SHA-256 digests, exact character lengths, and validated matching modes, never raw canary values. For valid JSON, short numeric answer canaries compare entropy-bearing metadata and numeric scalars exactly, match URI/reference fields only at non-alphanumeric token boundaries, and scan every substring of semantic fields; unstructured text remains an exact-window scan. Findings contain rule IDs and locations only. Its deliberate clean/leaky self-test suite passed, including the negative assertion that neither console output nor JSON reports repeat the raw test canary.

The strict text scan covers `src/`, built-client text files, generated staff/publication artifacts including the redacted local summary `fr-013-staff-publication-surfaces.json`, `evaluation/results.json`, and JSON receipts under `artifacts/verification/`. It checks the synthetic private-answer digest, issued credential digests, credential-URI shapes, restricted persistence-field shapes, raw authorization-header shapes, and signed-URL secret shapes. Exact file and unsupported-binary counts belong to the generated scan receipt because they change with the frozen tree.

The README and `docs/` receive a separate canary-only scan because technical documentation legitimately names restricted field and pattern classes. Its exact scope and counts belong to the generated scan receipt.

Server fixture source and deterministic test/smoke inputs are deliberately allowlisted for the synthetic answer so the project remains reproducible. The allowlist does not extend to `src/`, the built client, purpose-built claimant responses, staff/publication artifacts, logs, screenshots, or receipts, and README prose must not advertise the value.

The scanner is a UTF-8 text scanner. It counts unsupported binary files but does not OCR images or decode QR codes. The `v1.0.0` release therefore pairs full log/receipt scanning with hash-bound human review of the synthetic images, architecture render, historical layout reference, and masked clean-Chrome comparison. The final demo video needs its own privacy review after recording because it cannot be reviewed before it exists.

## Verification evidence

Executed from the repository root with the checked-in local environments:

```powershell
service\.venv\Scripts\python.exe -m py_compile evaluation\run_evaluation.py scripts\privacy-scan.py evaluation\test_privacy_scan.py
service\.venv\Scripts\python.exe -m pytest evaluation\test_privacy_scan.py -q
service\.venv\Scripts\python.exe evaluation\run_evaluation.py
service\.venv\Scripts\python.exe scripts\privacy-scan.py --root src --root dist\client --root evaluation\artifacts\publication --root evaluation\results.json --root artifacts\verification --canary-manifest evaluation\privacy-canaries.json --output evaluation\privacy-scan-results.json --fail-on-findings
service\.venv\Scripts\python.exe scripts\privacy-scan.py --root README.md --root docs --canary-manifest evaluation\privacy-canaries.json --output evaluation\privacy-scan-docs-results.json --canaries-only --fail-on-findings
```

Use the generated scanner and evaluation receipts for exact test/file counts and warnings. Independently run component suites are regression evidence for the browser, authority, and simulator boundaries; their counts belong to frozen-commit verification receipts and do not change the evaluation execution boundary above.

## Live-only release evidence

No local result covers the live model, ADK, or cloud environment. The private `v1.0.0` release record is acceptable only after it includes:

- a live, pinned `gemini-3.5-flash` Vertex AI invocation and actual Google ADK trajectory/run receipt;
- the submitted Cloud Run app and simulator revisions;
- Firestore persistence and real transaction-contention evidence;
- Cloud Storage object generations, derivative provenance, digests, exact-retry behavior, and current-workflow-epoch evidence isolation;
- Cloud Tasks Google-signed OIDC delivery and at-least-once retry evidence;
- authenticated simulator HTTP and signed callback evidence over deployed HTTPS;
- a Cloud Logging/trace privacy export for the exact run window;
- five fresh reset-to-close canonical runs without manual datastore repair; and
- clean-browser behavior against the submitted API revision.

Targets are not results. Any missing model run, cloud receipt, privacy export, or canonical repetition keeps the release gate closed; it is never treated as zero or a pass. The full protocol and allowed claim language are in `docs/evaluation-plan.md`.

For `v1.0.0`, five private canonical receipts, deployed revision/resource evidence, full Cloud Logging windows, and the clean Chrome receipt satisfy the operational release gate while leaving the quality thresholds explicitly incomplete. The research-informed story mode and anonymous repository access are separate confirmations. Recording, privacy-reviewing, and publishing the public demo video—and the final Devpost action—remain outside this evaluation report.
