# Third-party notices

Found Roll's original project code is released under the MIT License in `LICENSE`. No third-party package or bundled template material is relicensed by that grant. JavaScript direct and transitive versions are frozen in `package-lock.json`; Python runtime and test closures are version- and hash-locked in each service's `requirements*.lock` files. Upstream licenses and notices continue to apply.

## Direct browser and build dependencies

| Package | Checked version | Declared license |
| --- | ---: | --- |
| `@phosphor-icons/react` | 2.1.10 | MIT |
| `@vitejs/plugin-react` | 5.0.4 | MIT |
| `qrcode.react` | 4.2.0 | ISC |
| `react` | 19.2.0 | MIT |
| `react-dom` | 19.2.0 | MIT |
| `vite` | 6.4.2 | MIT |
| `playwright-core` (development QA only) | 1.62.1 | Apache-2.0 |

## Direct custody-service dependencies

| Package | Checked version | Declared license |
| --- | ---: | --- |
| `fastapi` | 0.140.2 | MIT |
| `uvicorn` | 0.52.4 | BSD-3-Clause |
| `pydantic` | 2.13.5 | MIT |
| `httpx` | 0.28.1 | BSD-3-Clause |
| `google-cloud-firestore` | 2.29.0 | Apache-2.0 |
| `google-cloud-tasks` | 2.24.0 | Apache-2.0 |
| `google-cloud-storage` | 3.13.1 | Apache-2.0 |
| `google-auth` | 2.57.0 | Apache-2.0 |
| `google-adk` | 2.8.0 | Apache Software License classifier and bundled license |
| `google-genai` | 2.20.0 | Apache-2.0 |
| `Pillow` | 12.1.1 | MIT-CMU |
| `python-multipart` | 0.0.32 | Apache-2.0 |
| `pytest` (development only) | 9.1.1 | MIT |
| `pytest-cov` (development only) | 7.1.0 | MIT |

The simulator uses a subset of the same FastAPI/Pydantic/HTTP tooling; its exact versions are pinned separately.

## Bundled prototype template

The initial web structure includes files supplied through OpenAI's bundled Product Design prototype workflow, identified in `NOTICE.md`. The entrant has confirmed the required authorization to publish them. Those files remain subject to the terms under which the tool supplied them, and this repository makes no independent licensing claim for that template material.

The compiled browser client carries the full direct-runtime texts in `public/legal/FOUND-ROLL-LICENSE.txt` and `public/legal/THIRD-PARTY-LICENSES.txt`; Vite copies them into `dist/client/legal/` for the hosted build.

## Generated media

The five public synthetic fixture images are project-specific generated media. Their provenance, intended visibility, byte lengths, and SHA-256 digests are recorded in `public/assets/README.md`. No Google or Picasa logos, proprietary artwork, or real custodian media is included.
