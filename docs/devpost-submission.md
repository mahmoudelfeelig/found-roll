# Devpost submission draft

This copy is designed for the **Taskmaster** category and the public `v1.0.0` release. Its cloud claims are valid only when the private release verifier passes against that exact tag; never publish a claim from a partial run or a different commit.

## Title

**Found Roll — the recovery network between lost-and-found desks**

## Tagline

A policy-bound recovery agent for the gaps between separate lost-and-found systems.

## Short description

Found Roll turns scattered photos, route clues, and custody events into an accepted claim-evidence packet and a coordinated return. It searches across authorized custodian inventories, asks for the minimum private evidence needed to resolve ambiguity, and—after staff identity attestation and approval—executes a clearly disclosed simulated handoff with an internally checkable Item Passport.

## Inspiration

Found Roll started with a recurring operational gap documented in public recovery guidance. [Heathrow splits responsibility](https://www.heathrow.com/at-the-airport/terminal-facilities/lost-property) between its terminal lost-property database and the airline when something was left onboard. [National Rail similarly directs people](https://www.nationalrail.co.uk/help-and-assistance/contact-us/) to a station operator for station property and a train company for journey issues. The claimant must therefore guess custody before any search can succeed. Once a candidate is found, recovery services ask for distinguishing features, identity, and proof of ownership. Found Roll treats this as a coordination problem, not a better chatbot: one authorized investigation spans separate inventories, asks only for the smallest private discriminator, and returns release authority to staff and policy.

This is deliberately a research-informed story, not a claim that a team member personally experienced the synthetic camera-pouch route. The product's evidence boundary is also informed by published recovery guidance that [detailed item descriptions and proof of ownership are used to identify and release property](https://www.lostproperty.org/faqs.php).

## What it does

Found Roll creates one Item Passport across three fictional custodian namespaces: Grand Hall, Metro Loop, and Northport Air. The flagship synthetic case follows a worn black camera pouch whose route crosses all three.

The hosted root is a public, no-store Judge Walkthrough of that fixed closed synthetic case. It is strictly read-only and accepts no credentials. It shows only redacted case status/timeline, bounded-analyst metadata, and internal manifest consistency; it omits claimant evidence, restricted media, task bodies, raw actor IDs, idempotency keys, and model trace IDs. The protected staff workspace remains separate and is demonstrated in the continuous video.

Staff begin with a local safety screen. Passports/government IDs, payment cards, access badges, medication, suspicious packages, and unknown sensitive categories receive category-specific instructions routed to the selected fictional custodian's specialist desk. Those branches expose no upload, make no network request, create no case, and call no model. For an ordinary intake, Found Roll records provenance and queues a background investigation. A bounded Case Analyst built with Google ADK and Gemini compares authorized multimodal evidence, searches the three custodian adapters, and proposes the next evidence action.

The system deliberately refuses to accept a visual-only match. In the camera-pouch case it asks the claimant one non-leading question about a staff-only serial attribute, without exposing candidate images or the expected answer. The claimant receives a one-time link bound to that case version and expiry. Its raw value exists only in a scrubbed URL fragment and tab memory; the service persists a keyed digest. Answer submission consumes the link, a wrong answer rotates it to the new case version, and expiry or replay fails closed. Deterministic code accepts or rejects that claim evidence. Because the item contains valuable electronics, a separately authenticated staff identity attestation and supervisor approval are still required.

The protected staff workspace keeps three reusable credentials in memory and separates their authority: the demo credential drives the synthetic workflow, the staff credential covers production rich reads plus evidence/identity/release, and the supervisor credential covers approval. Intake, claimant-link issuance, and duplicate release-task delivery require both demo and staff. A strict non-mutating probe validates all three before any role is shown as loaded. The service derives the exact configured actors (`staff.northport` and the distinct `supervisor.northport` in the frozen fixture) and rejects conflicting optional legacy actor fields. The claimant never receives a rich staff response; the one-time link returns a purpose-built coarse projection. Admin reset remains terminal/Cloud Shell only and never enters the browser. Only after those gates can Found Roll reserve Relay Post, a separately deployed and permanently labeled **SIMULATED** handoff service. Short-lived claimant and custodian credentials are consumed once, the simulator returns a signed service attestation, consumed-token replay is rejected, and duplicate completed-task delivery is idempotent without creating a custody event. The closed passport includes a hash-linked application event manifest. That manifest checks internal service-event consistency; it does not prove ownership, physical possession, or a real-world transfer.

## Why it is agentic

Found Roll is not a chat interface wrapped around image similarity. The workflow wakes on an intake event, gathers evidence through permission-scoped tools, searches multiple authorized systems, determines whether the current evidence is insufficient, and proposes the smallest permitted next question for the deterministic policy-selected candidate packet. It pauses for claimant evidence and accountable human approval, then resumes the workflow, dispatches retryable work, and reconciles the remote simulator result into an application state.

The authority boundary is the key design decision. Gemini can inspect evidence and propose an investigation step. It cannot see the expected private answer, accept a claim, attest identity, approve a handoff, issue or consume credentials, or write custody state. Typed policy and state-machine code own those actions.

## How we built it

The staff and claimant experience is a React interface based on the dense interaction grammar of a late-2000s desktop photo organizer: physical folders are custodian inventories, logical albums are cross-custodian cases, the photo tray is the active evidence packet, and playback is the Item Passport history. It uses original branding and synthetic imagery rather than copied product assets, logos, or proprietary icons.

The canonical cloud architecture uses:

- a pinned `gemini-3.5-flash` model through Vertex AI for multimodal evidence planning;
- Google ADK for the bounded Case Analyst and typed proposal-only tools;
- one Cloud Run service for the Found Roll API, deterministic policy/custody engine, and authenticated Cloud Tasks handler;
- a second Cloud Run service for the disclosed custodian and relay simulator;
- Firestore for passports, versions, idempotency records, outbox rows, and application-enforced append-only events;
- Cloud Storage for restricted originals and separately derived previews, with retry-safe idempotency and workflow-epoch selection so only the latest complete current-run pair reaches the staff workspace or model;
- Cloud Tasks with deterministic names, opaque three-field bodies, Google-signed OIDC delivery, and payload-free production publication receipts (the local inline adapter alone returns its opaque body for explicit delivery);
- eight Secret Manager resources for the digest pepper, demo access, admin recovery, staff role, supervisor approval, simulator API, simulator token hashing, and callback HMAC; and
- Cloud Logging for redacted operational events and correlation IDs, with prompt, answer, token, signed-URL, and media capture disabled.

Remote reservation and release use an outbox/saga pattern. The state request and outbox row commit together; a retry-safe dispatcher creates a named task; the task calls the authenticated simulator contract; and a second transaction validates the returned attestation before moving custody. Evidence upload uses the case workflow epoch, content fingerprint, consent decision, and idempotency key so a response-loss retry returns the same original/preview pair while a conflict fails closed. A stale state version, stale eTag, stale evidence epoch, ambiguous remote result, expired credential, or replay cannot advance the case.

## What is real in the canonical demo

The claims below describe the frozen `v1.0.0` release and must agree with the five canonical run receipts and the continuous demo take. If the release verifier does not pass, do not publish this section.

- Live Gemini evidence analysis through the pinned model and a traceable Google ADK tool trajectory.
- Two separately deployed Cloud Run revisions and a real HTTPS call between the Found Roll service and simulator.
- Firestore state and transaction writes, Cloud Storage evidence objects, a real Cloud Task with OIDC, and correlated redacted logs.
- Deterministic policy decisions, expected-version checks, idempotency, one-time credential consumption, callback verification, replay handling, and final event-manifest verification.
- A fresh canonical case that begins from reset and ends in `CLOSED` without manual database repair.

The canonical recording uses that prepared frozen case. It shows the safety/no-upload screen and cancels it, then starts analysis on the already reset case and its current-epoch uploaded preview; it does not create a second dynamic intake after preparation.

## What is simulated

Grand Hall, Metro Loop, Northport Air, their inventory items, the claimant route, and Relay Post are fictional. Fixture media and case history are synthetic. The simulator exercises a real versioned HTTPS contract, credentials, eTags, signed attestations, retries, and replay behavior; it is not an integration with a real venue, transit operator, airport, courier, or locker. Token presentation does not prove physical possession, and the project never claims that it does.

## Challenges

**Asking for evidence without leaking the answer.** A claimant should not be shown the very detail that distinguishes a legitimate claim. We split public/coarse evidence from restricted evidence, give the model an attribute identifier instead of the expected value, and use a one-time case/version-scoped proof link whose raw token is fragment/tab-memory only and digest-only at rest. Wrong answers consume and rotate the link. We snapshot-test every claimant-visible surface.

**Keeping the model useful without granting release authority.** Multimodal reasoning is valuable for choosing what evidence to inspect next, but a probabilistic confidence score is the wrong release control. We made the model output proposal-only and put the hard filters, exact private-fact comparison, identity attestation, approval, and custody transitions in deterministic code.

**Making remote work honest under retries.** Cloud Tasks and service callbacks can arrive more than once. Deterministic task names, expected versions, remote eTags, idempotency fingerprints, one-time credentials, and an outbox/reconciliation path prevent a retry from becoming a second handoff.

**Showing a large product without pretending to have a global network.** The demo uses three fictional custodian namespaces behind one separately deployed, clearly disclosed simulator contract intended for future integrations. That proves the workflow and contract without claiming partnerships or physical custody we do not have.

## Accomplishments

The local measurements below are deliberately separate from live cloud proof. The five canonical receipts establish execution and boundary behavior, not model accuracy or general reliability; never convert deterministic fixture metrics into broader Gemini/ADK claims.

- Fresh component-suite counts must be copied from the frozen release receipt rather than this draft.
- The frozen deterministic evaluation passed **15/15 synthetic scenarios**, with no failed scenario.
- Deterministic local candidate retrieval in the top three was **2/2 as a descriptive proxy**, but the two-fixture sample is below the required minimum of 12 and passes no threshold.
- Usefulness was **3/3 among the only genuinely question-bearing packets**, also only a descriptive insufficient-sample proxy. FR-003 and FR-010 produced no candidate packet/question and are not counted. Canonical retrieval and usefulness thresholds remain **INCOMPLETE**.
- Prompt-injection text remained inert and could not authorize a claim. An expired claimant link returned `claim_link_expired` with zero event delta, and handoff-token replay returned `token_replayed` with zero event delta.
- The local run made **0 Gemini calls and 0 Google Cloud calls**. Separately, the frozen release completed **five consecutive live canonical workflows** from authenticated reset to `CLOSED`; each bound the same commit, frontend artifact, app/simulator revisions, live Gemini/ADK trajectory, deliberate task and callback replay proofs, and full Cloud Logging privacy window.

The result we value most is architectural: the most impressive part of the agent is where it stops. It can carry a messy investigation forward, but evidence acceptance, identity, approval, and custody remain explicit and inspectable.

## What we learned

The best next action is often more valuable than another similarity score. Once the candidate set is small, a single private discriminator can resolve ambiguity more safely than a long questionnaire or a higher model confidence.

We also learned to separate three ideas that are easy to blur in a demo: a plausible match, accepted claim evidence, and authorization to release. They are different states with different owners. The model can help with the first; deterministic evidence gates support the second; accountable people and policy control the third.

Finally, “audit trail” needs careful wording. A hash-linked event chain is useful for detecting internal inconsistency, but it is still maintained inside our Google Cloud project. It is not a third-party immutable ledger and cannot prove that a physical handoff occurred.

## What is next

The next credible step is not a larger fictional network. It is one real pilot with a venue, campus, or multi-building operator, a single production adapter, and an operator-specific policy pack. From there we would add role-aware staff authentication, retention/deletion jobs, staff-requested evidence angles, operational monitoring, and a formal security/privacy review before accepting any real claimant data.

Broader work could add hotel, transit, airport, ticketing, and courier connectors behind the same contract. Sensitive categories—passports, payment cards, access badges, medication, and dangerous items—would remain specialist workflows rather than ordinary automated returns.

## Limitations and safety disclosures

- This is a hackathon prototype evaluated with synthetic fixtures, not a deployed lost-property operator.
- It does not verify legal ownership, perform biometric identification, inspect personal devices, or autonomously release valuable or sensitive property.
- It has no real airport, transit, venue, hotel, courier, or locker integration.
- The canonical demo must use live Google services, but local and automated tests also include explicitly named deterministic fixture modes.
- The demo/staff/supervisor browser secrets, strict bootstrap probe, and configured fixture actor IDs are hackathon controls, not a production identity provider or role system. The admin reset credential is terminal-only.
- Firestore Admin/IAM access can bypass browser rules. The event chain is application-enforced and only internally checkable.
- Published evaluation results apply only to the frozen synthetic fixture set and must not be generalized to real-world accuracy.

## License and asset provenance

The product name, interface composition, code, copy, fixture world, and item imagery were created for this project during the hackathon build. The interface uses a period-authentic desktop photo-organizer grammar but no Google/Picasa branding, logo, copied icon, or implied endorsement.

| Asset or dependency | Provenance | License/status |
| --- | --- | --- |
| Found Roll application code and original wordmark | Created for this entry | Original project code is released under the MIT License in `LICENSE`. Third-party dependencies and bundled template material retain their upstream terms as recorded in `NOTICE.md` and `THIRD_PARTY_NOTICES.md`. |
| Five public camera-pouch and claimant fixture images in `public/assets/` | Synthetic images generated specifically for Found Roll; no real claimant or personal data | Project fixture use; generation method disclosed. Preserve the frozen SHA-256 manifest below. |
| Phosphor Icons React 2.1.10 | `@phosphor-icons/react` | MIT |
| QRCode React 4.2.0 | `qrcode.react` | ISC |
| React 19.2.0 and React DOM 19.2.0 | Meta open-source packages | MIT |
| Vite 6.4.2 | Vite open-source package | MIT |
| Tahoma/Arial fallbacks | User system fonts; no font files redistributed | Referenced through CSS only |
| Google ADK, Google Gen AI SDK, and Google Cloud client libraries | Installed from the exact versions in the service requirements | Apache-2.0 or Apache Software License metadata as recorded in `THIRD_PARTY_NOTICES.md`; use is also subject to applicable Google service terms |

Fixture hashes recorded during drafting; regenerate and compare them at release freeze:

| File | SHA-256 |
| --- | --- |
| `public/assets/claimant-match.jpg` | `e5f8f907e9fcc2e21415b41218faea6ef11f783827aa6409aaba32defb6e64ed` |
| `public/assets/northport-intake.jpg` | `460bce72c0d68f8f26ae7f5f4d03b6cfc8975f239815580de511be3933d062ed` |
| `public/assets/pouch-front.jpg` | `7eecc012b0f8638fc59f2979ea0cdd3888e6cf5e9659eea2f30f0388bcea6d42` |
| `public/assets/pouch-interior.jpg` | `5a2dc95289981af12a057c3754d5df6140b67de842dc803a5092f5e9d1fb6b1e` |
| `public/assets/pouch-rear.jpg` | `1768db7c0249316c55877a73d91bd09689118f800e7a40ff339d2cfea6a6b159` |

## Final links

| Submission field | Final value |
| --- | --- |
| Hosted project | [Found Roll Judge Walkthrough](https://found-roll-app-1061926987746.us-central1.run.app/?view=walkthrough), a public read-only redacted synthetic case; the protected flow is shown in the continuous demo |
| Repository and judge access | [Public MIT repository](https://github.com/mahmoudelfeelig/found-roll), anonymously reachable at the published `v1.0.0` tag |
| Architecture | [Architecture and authority boundaries](https://github.com/mahmoudelfeelig/found-roll/blob/main/docs/architecture.md) and the [rendered diagram](https://github.com/mahmoudelfeelig/found-roll/blob/main/docs/architecture-diagram.png) |
| Evaluation report | [Local evaluation with explicit canonical limits](https://github.com/mahmoudelfeelig/found-roll/blob/main/docs/evaluation.md) |
| Demo video | Supplied through Devpost's dedicated video field as the privacy-reviewed public YouTube/Vimeo player, verified under four minutes |
| Submitted commit | The immutable commit resolved by the public `v1.0.0` Git tag |
| Cloud Run revisions | The exact app and simulator revisions bound by all five private canonical receipts and shown in the continuous demo |
| Fixture version | `camera-pouch-v1`, bound to the frozen fixture digest in the release record |
| Eligibility and story provenance | Confirmed by the entrant: entrant/team eligibility, official rules, ownership, required authorizations, new-project status, and research-informed story mode. |
| Google Cloud readiness | Dedicated active `Free trial account` project with remaining credit/time, required APIs/IAM/quota, EUR 10 Cloud Run and EUR 5 Agent Platform caps, and no paid activation or upgrade, verified by the release gate |

## Pre-submit consistency check

The README, hosted UI, demo narration, architecture diagram, evaluation report, and this Devpost copy agree on the release boundary: one bounded Case Analyst; deterministic release authority; three fictional custodians; a separately deployed simulated relay; case/version-scoped one-time claimant links; distinct demo, staff, supervisor, and terminal-only admin boundaries; live canonical Gemini/ADK/Google Cloud execution; synthetic fixture data; research-informed rather than first-person inspiration; no ownership or physical-possession claim; and only the measured results from `v1.0.0`. The video URL belongs in Devpost's dedicated field after its separate privacy and runtime checks; the final Devpost submission remains an entrant action.
