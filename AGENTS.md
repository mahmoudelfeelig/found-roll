# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Durable Found Roll design decisions

- The selected source image is the Picasa-era `Found Roll — Staff Workspace` mock. Match its dense early-2010s desktop-photo-organizer anatomy: menu bar, toolbar, left folder tree, thumbnail library, compare stage, photo tray, right case inspector, and broad bottom action strip.
- Avoid contemporary AI-dashboard conventions, chat bubbles, floating glass cards, oversized rounded corners, purple gradients, and decorative generated copy.
- Use restrained Windows-era chrome, Tahoma/Arial system typography, 1px dividers, compact controls, blue selection, and an orange custody accent.
- The flagship fixture is synthetic: three fictional custodians and one worn black compact-camera pouch. Every relay surface must permanently say `SIMULATED` and must never imply that a token proves physical possession.
- Keep the agent in the workflow rather than the visual metaphor. The interface should read as practical lost-property software, not as an AI product.
