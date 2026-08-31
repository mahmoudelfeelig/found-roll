# Found Roll design QA

Status: **historical visual QA reference; not current release evidence**

## Visual source and comparison

The approved 1488×1058 visual source and historical implementation capture are retained only in the ignored local `artifacts/design-qa/` workspace. They are deliberately excluded from the public repository because the comparison source is not project-owned and the old captures show synthetic answers and QR credentials. The comparison utility accepts the approved source path explicitly and contains no machine-specific source location.

Those local screenshots predate the current runtime-role probe, separate claimant-tab flow, current-workflow-epoch evidence selection, and duplicate-task wording. They remain useful for period styling, hierarchy, and viewport comparison only. They must not be presented as screenshots of the submitted revision or as proof of the current interaction contract; regenerate a privacy-reviewed publication set from the frozen submission build.

## Findings resolved

| Severity | Surface | Finding | Resolution |
| --- | --- | --- | --- |
| P1 | Layout and responsiveness | The first claimant and relay builds inherited the desktop staff shell's 1120px minimum width and overflowed at a 900px viewport. | Scoped the fixed workstation width to the staff surface only, added compact menu behavior, and added stacked claimant/relay layouts below 760px. Recheck found no horizontal overflow or clipped controls at 900px. |
| P1 | States and interactions | A visually complete workspace would still be a false prototype if the claimant-link, private-answer, role-boundary, callback, and replay states did not work. | Exercised the path after authenticated service reset through case/version-scoped claimant-link issue, correct private evidence, separately authenticated staff identity and supervisor approval, simulated reservation, two token attestations, closure, and duplicate delivery handling. Consumed/expired links and credentials reject; wrong answers rotate the claimant link; exact completed callback delivery is idempotent. |
| P2 | Accessibility | State changes were visible but not announced to assistive technology. | Added a polite live region on all three product surfaces while preserving the selected visual composition. |
| P2 | Viewport resilience | At 1120×720 the final quick-filter control starts below the visible portion of the folder pane. | Confirmed the pane is independently scrollable and the control remains keyboard- and scroll-accessible; it is not overlapped or horizontally clipped. |

## Final comparison pass

- Typography: Tahoma/Verdana/Arial system typography, compact sizing, and restrained weights preserve the early-2010s desktop density. No display-font or contemporary landing-page treatment was introduced.
- Layout: menu bar, tool strip, folder tree, dated thumbnail library, three-part compare stage, photo tray, inspector, custody track, and bottom action strip follow the selected source's hierarchy and proportions.
- Color and surfaces: gray Windows-era chrome, 1px dividers, blue selection, orange custody emphasis, and low-radius controls match the source. There are no glass cards, purple gradients, decorative blobs, or generic AI dashboard tiles.
- Images: five public 4:3 raster assets show the same synthetic black camera pouch across judge, staff, intake, and claimant contexts. Images remain sharp at target crops, with no placeholder boxes, CSS illustrations, watermarks, faces, or logos.
- Icons: visible controls use one Phosphor icon family with matching compact weights. QR credentials are generated with a dedicated QR library rather than drawn approximations.
- Copy: the product reads as custody software. AI is confined to the status line and evidence workflow; there are no chat bubbles or model-centric marketing claims.
- Interaction states: selected, hover, focus, disabled, pending, accepted, approval-required, reserved, attested, closed, empty-relay, tenant/category no-upload, missing/expired claimant link, wrong-answer link rotation/manual-review, consumed-token rejection, and idempotent callback delivery are implemented for the core journey.
- Accessibility: semantic buttons and labels, alt text, keyboard focus indicators, live state announcements, reduced-motion handling, and mobile claimant/relay layouts are present.
- Honest boundary: every relay surface permanently says `SIMULATED`, and the interface explicitly says token presentation is not proof of physical possession.

## Historical verification notes

- The archived capture set recorded a successful production build and browser checks at that checkpoint. Exact counts belong to their dated command output, not this living report.
- The relay capture predates the duplicate-task language, and every capture predates later authorization and current-epoch evidence changes. Treat all of them as layout evidence only.
- Current functional status must be taken from a fresh `scripts/verify-all.ps1` run and its receipts on the frozen commit. A new browser capture is still required for judge-facing visual proof.
- Viewports checked: staff at 1488×1058, 1280×800, and 1120×720; claimant and relay at 900×800 and 390×844.
- Horizontal overflow at supported claimant/relay viewports: none after fixes.
