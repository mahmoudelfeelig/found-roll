# Found Roll disclosed simulator

This separately runnable service supplies the synthetic custodian inventories and Relay Post boundary for Found Roll. Northport Air, Metro Loop, Grand Hall, their records, and Relay Post are fictional. Every HTTP response and signed callback artifact is permanently marked `SIMULATED`.

The service records fixture state and one-time token presentation only. It does not observe, represent, or prove physical possession, delivery, or transfer. `AVAILABLE`, `HELD`, and `RELEASED` are simulator lifecycle labels, not real-world custody claims.

## HTTP contract

Read-only fixture routes:

- `GET /healthz`
- `GET /v1/custodians`
- `GET /v1/custodians/{custodian_id}/inventory`
- `GET /v1/custodians/{custodian_id}/inventory/{item_id}`
- `GET /v1/relay/reservations/{reservation_id}`

Inventory supports exact `category`, `status`, and `route` filters, inclusive `found_after` and `found_before` timestamps, and a coarse `q` search. Restricted claim evidence is not present in simulator responses.

Every response also returns `X-Found-Roll-Correlation-ID`. A caller may provide an ID containing 8–64 ASCII letters, digits, periods, underscores, colons, or hyphens; invalid or missing values are replaced with a generated opaque ID. The service installs an INFO-level, content-blind JSON handler that emits only `service`, `correlation_id`, `http_method`, the matched route template, `status_code`, and `latency_ms`. Uvicorn's raw access logger is disabled in application configuration and the production command also uses `--no-access-log`. It never logs raw paths, queries, bodies, authorization headers, tokens, private answers, or exception text. This lets the custody service propagate one safe identifier across its inventory and relay calls without leaking request content.

Authenticated mutation routes:

- `POST /v1/admin/reset`
- `POST /v1/relay/reservations`
- `POST /v1/relay/reservations/{reservation_id}/credentials`
- `POST /v1/relay/reservations/{reservation_id}/attestations`
- `POST /v1/relay/reservations/{reservation_id}/handoff-attestation`

All mutations require `Authorization: Bearer <SIMULATOR_API_KEY>`. The service fails closed when that value is unset. Credential issuance also fails closed until `SIMULATOR_TOKEN_SECRET` is configured; callback signing requires the independent `SIMULATOR_CALLBACK_SECRET`.

Set `SIMULATOR_ENV=production` on the deployed revision. In that mode startup fails before serving traffic if any of those three secrets is missing, shorter than 24 characters, an example placeholder, or reused for another purpose. Development mode retains route-level fail-closed checks so an unset API, token, or callback secret disables its protected operation, but it intentionally permits local fixture values.

Each custody-changing request carries an expected resource version, expected eTag, actor, reason, evidence references, and idempotency key. Keys are limited to 8–256 letters, digits, periods, underscores, colons, or hyphens so the custody service can safely forward its scoped, prefixed keys. An exact retry returns the same logical result with `idempotent_replay: true`; this includes returning the same signed final callback artifact when the finalization request is retried under its original key. Reusing a key for another body, re-presenting a consumed token, or trying to finalize an already-attested handoff under a new key is rejected.

The final endpoint accepts only `CALLBACK_READY`, which requires distinct accepted `CUSTODIAN` and `CLAIMANT` token presentations within both time windows. Its callback artifact signs:

```text
<X-Found-Roll-Simulator-Timestamp>.<canonical JSON callback body>
```

The timestamp is Unix seconds. Canonical JSON uses sorted keys, no insignificant whitespace, and UTF-8 characters without ASCII escaping. The signature is HMAC-SHA256 and the response header map contains `X-Found-Roll-Simulator-Signature: v1=<hex digest>`. The application service must reject an invalid signature, stale timestamp, or mismatched case/item/version binding and commit the callback event exactly once. An exact signed callback retry is handled idempotently; a conflicting replay is rejected.

## Run locally

Use a dedicated virtual environment and non-production local secrets:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --require-hashes --requirement requirements-dev.lock
$env:SIMULATOR_ENV = 'development'
$env:SIMULATOR_API_KEY = 'replace-with-a-long-local-value'
$env:SIMULATOR_TOKEN_SECRET = 'replace-with-an-independent-long-local-value'
$env:SIMULATOR_CALLBACK_SECRET = 'replace-with-another-independent-long-local-value'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8091
```

The container listens on `PORT` and deliberately runs one worker because this resettable hackathon fixture uses process-local state. A Cloud Run demo deployment must use one maximum instance. This is not a production persistence design.

The custody service's canonical analyst deployment points `FOUND_ROLL_INVENTORY_BASE_URL` at this service, sets `FOUND_ROLL_INVENTORY_MODE=http`, and requires HTTPS. The simulator Cloud Run revision must set `SIMULATOR_ENV=production` and mount the API, token, and callback secrets from their three Secret Manager resources. Inventory GETs remain read-only; all simulator mutations still require the independent `SIMULATOR_API_KEY`, which must never be embedded in browser code.

Roll out the app's backward-compatible health-envelope reader before this simulator revision. This revision adds `data.environment`; an older strict app rejects the added field. After the ordered update, the app must verify that the simulator reports `environment=production`.

## Canonical HTTP run

The following `curl` and `jq` sequence resets the fixture, conditionally holds the canonical Northport item, issues two fixture-only credentials, records both presentations, and obtains the signed callback artifact. Run authenticated reset from a terminal or Cloud Shell (or through `scripts/prepare-canonical-run.ps1`); there is no browser reset control and the simulator API key must never enter the frontend. Update the two expiry timestamps if the fixture is run after the shown demo window.

```bash
export SIM_URL=http://127.0.0.1:8091
export SIM_KEY=replace-with-a-long-local-value

curl -sS -X POST "$SIM_URL/v1/admin/reset" -H "Authorization: Bearer $SIM_KEY" -H 'Content-Type: application/json' -d '{"confirmation":"RESET_SIMULATED_FIXTURE","actor":"demo-reset","reason":"Restore the synthetic camera-pouch scenario."}' | jq

RESERVE=$(curl -sS -X POST "$SIM_URL/v1/relay/reservations" -H "Authorization: Bearer $SIM_KEY" -H 'Content-Type: application/json' -d '{"case_id":"FR-20260829-0042","case_version":12,"custodian_id":"northport-air","item_id":"NA-PCH-231","expected_item_version":5,"expected_item_etag":"\"na-231-v5\"","destination":"Relay Post secure counter","expires_at":"2026-08-30T00:00:00Z","actor":"found-roll:outbox","reason":"Policy-authorized synthetic relay reservation.","evidence_refs":["evt-approval-001"],"idempotency_key":"curl-reserve-001"}')
RSV=$(jq -r '.data.reservation.reservation_id' <<<"$RESERVE"); RVER=$(jq -r '.data.reservation.version' <<<"$RESERVE"); RETAG=$(jq -r '.data.reservation.etag' <<<"$RESERVE")

CREDS=$(jq -n --arg case_id FR-20260829-0042 --arg item_id NA-PCH-231 --arg custodian_id northport-air --arg etag "$RETAG" --argjson version "$RVER" '{case_id:$case_id,case_version:12,item_id:$item_id,custodian_id:$custodian_id,expected_reservation_version:$version,expected_reservation_etag:$etag,actor:"found-roll:credential-issuer",reason:"Issue short-lived fixture-only presentation credentials.",evidence_refs:["evt-reserved-001"],idempotency_key:"curl-credentials-001",token_expires_at:"2026-08-29T23:45:00Z"}' | curl -sS -X POST "$SIM_URL/v1/relay/reservations/$RSV/credentials" -H "Authorization: Bearer $SIM_KEY" -H 'Content-Type: application/json' --data-binary @-)
CLAIMANT_TOKEN=$(jq -r '.data.credentials.claimant_token' <<<"$CREDS"); CUSTODIAN_TOKEN=$(jq -r '.data.credentials.custodian_token' <<<"$CREDS"); RVER=$(jq -r '.data.reservation.version' <<<"$CREDS"); RETAG=$(jq -r '.data.reservation.etag' <<<"$CREDS")

CUSTODIAN=$(jq -n --arg token "$CUSTODIAN_TOKEN" --arg etag "$RETAG" --argjson version "$RVER" '{case_id:"FR-20260829-0042",case_version:12,item_id:"NA-PCH-231",custodian_id:"northport-air",expected_reservation_version:$version,expected_reservation_etag:$etag,actor:"relay-terminal:custodian",reason:"Record synthetic custodian token presentation.",evidence_refs:["evt-token-custodian-001"],idempotency_key:"curl-attest-custodian-001",role:"CUSTODIAN",token:$token}' | curl -sS -X POST "$SIM_URL/v1/relay/reservations/$RSV/attestations" -H "Authorization: Bearer $SIM_KEY" -H 'Content-Type: application/json' --data-binary @-)
RVER=$(jq -r '.data.reservation.version' <<<"$CUSTODIAN"); RETAG=$(jq -r '.data.reservation.etag' <<<"$CUSTODIAN")

CLAIMANT=$(jq -n --arg token "$CLAIMANT_TOKEN" --arg etag "$RETAG" --argjson version "$RVER" '{case_id:"FR-20260829-0042",case_version:12,item_id:"NA-PCH-231",custodian_id:"northport-air",expected_reservation_version:$version,expected_reservation_etag:$etag,actor:"relay-terminal:claimant",reason:"Record synthetic claimant token presentation.",evidence_refs:["evt-token-claimant-001"],idempotency_key:"curl-attest-claimant-001",role:"CLAIMANT",token:$token}' | curl -sS -X POST "$SIM_URL/v1/relay/reservations/$RSV/attestations" -H "Authorization: Bearer $SIM_KEY" -H 'Content-Type: application/json' --data-binary @-)
RVER=$(jq -r '.data.reservation.version' <<<"$CLAIMANT"); RETAG=$(jq -r '.data.reservation.etag' <<<"$CLAIMANT")

jq -n --arg etag "$RETAG" --argjson version "$RVER" '{case_id:"FR-20260829-0042",case_version:12,item_id:"NA-PCH-231",custodian_id:"northport-air",expected_reservation_version:$version,expected_reservation_etag:$etag,actor:"found-roll:release-dispatcher",reason:"Finalize the simulator callback artifact after both token presentations.",evidence_refs:["evt-staff-confirmed-001"],idempotency_key:"curl-handoff-001"}' | curl -sS -X POST "$SIM_URL/v1/relay/reservations/$RSV/handoff-attestation" -H "Authorization: Bearer $SIM_KEY" -H 'Content-Type: application/json' --data-binary @- | jq
```

## Deterministic fixture

Reset recreates nine items and clears all reservations, token hashes, attestations, and idempotency records. The three camera-pouch candidates align with the Found Roll service fixture:

| Custodian | Item | Version | eTag |
| --- | --- | ---: | --- |
| Northport Air | `NA-PCH-231` | 5 | `"na-231-v5"` |
| Metro Loop | `ML-PCH-219` | 2 | `"ml-219-v2"` |
| Grand Hall | `GH-PCH-104` | 3 | `"gh-104-v3"` |

## Test

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The current tree passes **19/19 simulator tests**. They cover disclosure on success and errors, real TestClient inventory reads, bounded correlation acceptance/replacement and safe structured logging, tenant isolation and filtering, production-startup secret rejection, route-level fail-closed auth, conditional reservation, stale versions/eTags, service-prefixed idempotency keys and misuse, token-role and binding mismatches, token replay, expiry rollback, callback-ready gating, exact finalization retry, conflicting finalization replay rejection, callback schema compatibility, and HMAC verification.

`requirements.lock` and `requirements-dev.lock` freeze the complete runtime and test closures with hashes. Regenerate them deliberately from the corresponding `.txt` inputs with the pinned lock tool; do not hand-edit a resolved version or hash.

This local result is not proof of the live boundary. The Devpost/video claim remains blocked until the exact submitted simulator revision is separately deployed on Cloud Run with `SIMULATOR_ENV=production`, called over authenticated HTTPS by the app revision, and tied to the canonical receipt.
