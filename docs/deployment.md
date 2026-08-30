# Found Roll Google Cloud deployment runbook

This runbook deploys exactly two Cloud Run services:

- `found-roll-app`: FastAPI application API, deterministic policy/custody engine, Google ADK/Vertex integration, and authenticated `/tasks/outbox` handler from `service/`;
- `found-roll-simulator`: three fictional custodian namespaces and the permanently disclosed Relay Post simulator from `simulator/`.

The React client is the hosted Found Roll experience and must point to the submitted app revision. Do not describe a local Vite server, fixture analyst, inline task receipt, in-process relay, or Sites preview as the canonical Google Cloud deployment.

Commands below use PowerShell. Run them from the repository root. Replace every angle-bracket value; never paste a secret into a command argument, repository file, shell history, build substitution, or Cloud Run plain environment variable.

## Deployment gates

Do not deploy or record the canonical demo until all gates are satisfied:

- `service/` production validation requires Firestore, `vertex_adk`, the simulator-backed HTTP inventory gateway, Cloud Tasks, remote HTTP relay, a task service-account identity, pinned model, project, and non-default secrets.
- `/tasks/outbox` verifies the Google-signed OIDC bearer token at application level: issuer, audience, signature, expiry, and exact expected service-account email. `X-CloudTasks-TaskName` is defense in depth only and is not authentication.
- Simulator mutation routes fail closed without their bearer API key. Callback artifacts use a timestamped HMAC-SHA256 signature, reject stale or invalid requests, acknowledge an exact duplicate idempotently, and reject conflicting replay.
- The service and simulator agree on the final versioned paths, request/response schemas, auth header, callback headers, expected eTag, and idempotency behavior through a contract test.
- The Cloud Storage evidence adapter is wired to a configured bucket, stores originals and derivatives separately, and records object generation plus SHA-256. If this is not implemented and exercised, remove Cloud Storage from the product and demo claims.
- Browser authority is split three ways: the synthetic workflow uses the demo credential, production rich reads plus staff evidence/identity/release use an independent staff credential, and approval uses an independent supervisor credential. One strict, non-mutating endpoint validates all three before the browser marks them loaded. The service derives the exact configured staff/supervisor actor IDs; conflicting optional legacy IDs fail closed. Claim evidence uses a one-time case/version-scoped purpose-built projection instead of any reusable role credential or rich staff response. Reset and recovery require a fourth, admin-only credential that is never accepted by the browser.
- Local component and deterministic-evaluation results make zero Gemini and zero Google Cloud calls and do not satisfy this deployment gate. Take exact counts only from fresh frozen-commit output and checked receipts.
- All fixture data is synthetic, every simulator response says `SIMULATED`, and the deployment has no service-account key file.

## Preflight and variables

Use a dedicated hackathon project, not a shared production project.

### Zero-real-money guardrail

This deployment is **not Always Free**. The pinned Gemini model is priced usage, eight active Secret Manager versions exceed the six-version billing-account allowance, public Cloud Run traffic can consume billable resources, and `gcloud run deploy --source` creates Cloud Build, Cloud Storage, and Artifact Registry artifacts. Any nominal product free tier is a possible credit reduction, not the authorization boundary.

The hard zero-real-money boundary is an active, unexpired, **unupgraded Google Cloud Free Trial**. Before enabling deployment APIs, open Billing Overview in Chrome and capture a redacted manual receipt that proves all of the following for the account linked to this dedicated project:

- the account type literally says **Free trial account**;
- remaining trial credit is greater than zero;
- remaining trial time is greater than zero; and
- paid activation or upgrade has not occurred.

Stop if the account is paid, upgraded, expired, absent, or cannot be distinguished from a paid account. Never click **Activate** or **Upgrade**, add a payment, make a deposit, or convert the account for this project. `gcloud billing projects describe` can confirm that billing is linked, but it cannot prove the account is an unupgraded Free Trial; the Billing Overview receipt is mandatory. The private release record must say `billing_account_type: "free_trial"` exactly and confirm remaining credit, remaining time, and absence of paid activation.

Before API enablement, create two separate project-and-service spend caps in the Cloud Billing console's Preview spend-cap flow, each at the lowest practical demo target: one scoped to Cloud Run and one scoped to the Gemini/Agent Platform service used by the Vertex AI call. Capture a redacted receipt for each cap and do not set the corresponding release-record confirmations until both are enabled. These caps are defense in depth only: enforcement is delayed, in-flight work or overage can still be charged, and persistent or storage resources outside the capped service can keep accruing. Ordinary budget alerts remain informational. Spend caps do not make a paid account acceptable and do not replace the unupgraded Free Trial boundary.

Use one dedicated project in `us-central1`. Keep both Cloud Run services request-based with service-level and revision-level zero minimum instances, one maximum instance, one CPU, 512 MiB memory, CPU throttling, and no startup CPU boost. Do not add a VPC connector, load balancer, custom domain, GPU, Cloud SQL, paid support, Firestore backup/PITR/TTL, Artifact Analysis scanning, or any resource not listed in this runbook. Delete noncanonical build artifacts as you go and delete the dedicated project after judging. If the Free Trial receipt or either service spend-cap receipt is missing, do not enable deployment APIs or deploy.

```powershell
$ProjectId = "<google-cloud-project-id>"
$Region = "us-central1"
$ModelLocation = "global"
$FirestoreLocation = "nam5"
$AppService = "found-roll-app"
$SimulatorService = "found-roll-simulator"
$Queue = "found-roll"
$Bucket = "$ProjectId-found-roll-evidence"
$AppServiceAccount = "found-roll-app@$ProjectId.iam.gserviceaccount.com"
$SimulatorServiceAccount = "found-roll-simulator@$ProjectId.iam.gserviceaccount.com"
$TaskServiceAccount = "found-roll-tasks@$ProjectId.iam.gserviceaccount.com"
$FirestoreNamespace = "foundRoll_submission_v1_synthetic_demo"
$Model = "gemini-3.5-flash"
$StaffActorId = "staff.northport"
$SupervisorActorId = "supervisor.northport"
$AppUrl = "<reserved-or-existing-exact-found-roll-https-origin>"
$SimulatorUrl = "<reserved-or-existing-exact-simulator-https-origin>"
$HostedClientOrigin = $AppUrl
```

Both service origins must be known before the first production revision starts. Use stable existing Cloud Run service URLs or reserved/mapped HTTPS origins. Do not deploy a production app with the localhost default and plan to patch `FOUND_ROLL_PUBLIC_BASE_URL` afterward: production validation rejects that revision before it can become ready, and the Cloud Tasks audience would be wrong. On a genuinely new project with no reservable mapping, a two-stage bootstrap may create the service names in an explicitly non-production configuration solely to discover their stable URLs; label those revisions noncanonical, send them no claimant data, then deploy the production revisions in the compatibility order below. Never record the bootstrap as Google Cloud evidence.

Authenticate an operator account with permission to create the resources below and set the project:

```powershell
gcloud auth login
gcloud config set project $ProjectId
gcloud config set run/region $Region
gcloud auth list
gcloud config list project
```

Application Default Credentials are acceptable for local development under an individual account. Cloud Run uses attached service-account identity. Never run `gcloud iam service-accounts keys create`, download a JSON key, or set `GOOGLE_APPLICATION_CREDENTIALS` to a repository file.

Enable only the APIs used by the submitted architecture:

```powershell
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable artifactregistry.googleapis.com
gcloud services enable aiplatform.googleapis.com
gcloud services enable firestore.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable cloudtasks.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable iamcredentials.googleapis.com
gcloud services enable logging.googleapis.com
```

## Service accounts and least privilege

Create three dedicated identities:

```powershell
gcloud iam service-accounts create found-roll-app --display-name="Found Roll application runtime"
gcloud iam service-accounts create found-roll-simulator --display-name="Found Roll disclosed simulator runtime"
gcloud iam service-accounts create found-roll-tasks --display-name="Found Roll Cloud Tasks caller"
```

Grant the application only the roles needed by the canonical path:

```powershell
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/cloudtasks.enqueuer"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/aiplatform.user"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/logging.logWriter"
gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$SimulatorServiceAccount" --role="roles/logging.logWriter"
gcloud iam service-accounts add-iam-policy-binding $TaskServiceAccount --member="serviceAccount:$AppServiceAccount" --role="roles/iam.serviceAccountUser"
```

After the app service exists, allow only the task caller to invoke it through Google IAM in deployments where the entire service can remain private. If the hosted client requires the app service to be public, application-layer OIDC validation on `/tasks/outbox` remains mandatory because Cloud Run IAM is service-wide rather than route-specific.

The Cloud Tasks service agent must be able to mint an OIDC token for the task caller. Compute its principal and bind it on the task service account:

```powershell
$ProjectNumber = gcloud projects describe $ProjectId --format="value(projectNumber)"
$TasksServiceAgent = "service-$ProjectNumber@gcp-sa-cloudtasks.iam.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding $TaskServiceAccount --member="serviceAccount:$TasksServiceAgent" --role="roles/iam.serviceAccountTokenCreator"
```

The deploying operator also needs permission to act as the runtime service accounts. Grant that narrowly through your organization’s normal deployer role; do not give the runtime accounts Owner or Editor.

## Firestore, Storage, and Cloud Tasks

Create a Firestore Native database only if the project does not already have one. Database location is effectively permanent, so confirm it before running the create command:

```powershell
gcloud firestore databases list
gcloud firestore databases create --location=$FirestoreLocation --type=firestore-native
```

Create a private evidence bucket with uniform bucket-level access, public-access prevention, and soft delete disabled. Google Cloud Storage otherwise applies a default seven-day soft-delete policy whose retained bytes can continue to consume storage after ordinary deletion.

```powershell
gcloud storage buckets create "gs://$Bucket" --location=$Region --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
# If the bucket already existed, clear any inherited/default soft-delete policy before uploading evidence:
gcloud storage buckets update "gs://$Bucket" --clear-soft-delete
```

Configure lifecycle deletion for a date safely after the announced judging period. Replace the date with the first UTC date on which retaining demo evidence is no longer required; do not choose a date during judging. This is a forgotten-data backstop, not an immediate spending stop, so explicit teardown remains mandatory.

```powershell
$EvidenceDeleteBeforeDate = "<YYYY-MM-DD-after-judging>"
$LifecyclePath = Join-Path ([System.IO.Path]::GetTempPath()) "found-roll-evidence-lifecycle.json"
$Lifecycle = @{
    rule = @(
        @{
            action = @{ type = "Delete" }
            condition = @{ createdBefore = $EvidenceDeleteBeforeDate }
        }
    )
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($LifecyclePath, $Lifecycle, [System.Text.UTF8Encoding]::new($false))
try {
    gcloud storage buckets update "gs://$Bucket" --lifecycle-file=$LifecyclePath
} finally {
    Remove-Item -LiteralPath $LifecyclePath -Force -ErrorAction SilentlyContinue
}
gcloud storage buckets describe "gs://$Bucket" --format="yaml(name,location,iamConfiguration,lifecycle,versioning,softDeletePolicy)"
```

The bucket description must show no enabled `softDeletePolicy` retention duration. Stop if a positive soft-delete duration remains. Do not enable object versioning, retention locks, backups, or another persistence feature for the synthetic evidence bucket. Before each canonical preparation and again after it, measure all stored versions and fail closed at 5 GiB. This byte check does not discover soft-deleted objects, which is why the policy check is separate and mandatory:

```powershell
$EvidenceUsage = gcloud storage du --summarize --all-versions "gs://$Bucket"
$EvidenceMatch = [regex]::Match(($EvidenceUsage -join "`n"), '^\s*(\d+)')
if (-not $EvidenceMatch.Success) { throw 'Could not verify evidence-bucket byte usage.' }
$EvidenceBytes = [int64]$EvidenceMatch.Groups[1].Value
if ($EvidenceBytes -ge 5GB) { throw "Evidence bucket is not under 5 GiB: $EvidenceBytes bytes." }
$EvidenceBytes
```

The 5 GiB ceiling is a conservative resource bound, not an assertion that this deployment is Always Free.

Only after the bucket exists, grant the app service account object access on that bucket rather than project-wide storage administration:

```powershell
gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --member="serviceAccount:$AppServiceAccount" --role="roles/storage.objectUser"
```

Create the queue in the same region as the app with a fully bounded demo retry policy. If it already exists, run the update command instead so an old default—up to 100 attempts—cannot survive:

```powershell
gcloud tasks queues create $Queue --location=$Region --max-concurrent-dispatches=1 --max-dispatches-per-second=1 --max-attempts=3 --max-retry-duration=1s --min-backoff=10s --max-backoff=60s --max-doublings=2
# Use this instead when the queue already exists:
gcloud tasks queues update $Queue --location=$Region --max-concurrent-dispatches=1 --max-dispatches-per-second=1 --max-attempts=3 --max-retry-duration=1s --min-backoff=10s --max-backoff=60s --max-doublings=2
gcloud tasks queues describe $Queue --location=$Region --format="yaml(state,rateLimits,retryConfig)"
```

Cloud Tasks stops only after both the attempt count and retry duration are satisfied; `0s` means unlimited duration and must not be used here. The positive `1s` duration is already satisfied before the first retry because the minimum backoff is 10 seconds, so `--max-attempts=3` becomes the effective hard dispatch-attempt bound. The attempt that first discovers an ambiguous relay result durably records `FAILED/EXECUTE` and returns non-2xx. A redelivery that observes that already-terminal state returns a 2xx non-retryable acknowledgment without invoking the relay or appending an event. Completed deliveries are also acknowledged with 2xx.

Cloud Task bodies must contain only `schema_version`, `case_id`, and `outbox_id`. Private answers, model text, evidence, claimant links, tokens, and signed URLs never belong in task payloads or task names. Production Cloud Tasks publication/replay receipts are payload-free; only the explicit local inline adapter returns that opaque body for manual development delivery.

## Secrets

Create eight secret resources. The demo workflow, admin recovery, staff evidence/identity/release, supervisor approval, simulator bearer API, simulator token hashing, callback HMAC, and service-side digest pepper are independent boundaries. One callback value is mapped to different environment names in the app and simulator so both validate the same HMAC contract.

```powershell
gcloud secrets create found-roll-secret-pepper --replication-policy=automatic
gcloud secrets create found-roll-demo-access-token --replication-policy=automatic
gcloud secrets create found-roll-admin-token --replication-policy=automatic
gcloud secrets create found-roll-simulator-api-key --replication-policy=automatic
gcloud secrets create found-roll-simulator-token-secret --replication-policy=automatic
gcloud secrets create found-roll-simulator-callback-secret --replication-policy=automatic
gcloud secrets create found-roll-evidence-staff-token --replication-policy=automatic
gcloud secrets create found-roll-supervisor-token --replication-policy=automatic
```

Collect each value interactively, validate the production invariants, and upload exact UTF-8 bytes with no trailing newline. Do not pipe `Read-Host` directly to `gcloud`: PowerShell's native pipeline appends CRLF, which changes the stored credential and makes browser-trimmed headers fail to match the mounted value.

```powershell
$SecretPrompts = [ordered]@{
    'found-roll-secret-pepper' = 'Secret pepper'
    'found-roll-demo-access-token' = 'Synthetic demo access token'
    'found-roll-admin-token' = 'Admin reset and recovery token'
    'found-roll-simulator-api-key' = 'Simulator API key'
    'found-roll-simulator-token-secret' = 'Simulator token secret'
    'found-roll-simulator-callback-secret' = 'Simulator callback secret'
    'found-roll-evidence-staff-token' = 'Evidence staff bearer token'
    'found-roll-supervisor-token' = 'Supervisor approval bearer token'
}
$SecretValues = [ordered]@{}
$SecretVersions = [ordered]@{}
$SeenValues = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

foreach ($Entry in $SecretPrompts.GetEnumerator()) {
    $Value = Read-Host -MaskInput $Entry.Value
    if ($Value.Length -lt 24 -or $Value -ne $Value.Trim() -or $Value -match '(?i)(replace|change|example|placeholder|your-|local-)') {
        throw "$($Entry.Key) must be at least 24 characters, contain no leading/trailing whitespace, and not be a placeholder."
    }
    if (-not $SeenValues.Add($Value)) { throw 'Every secret resource must use a distinct value.' }
    $SecretValues[$Entry.Key] = $Value
}

try {
    foreach ($Entry in $SecretValues.GetEnumerator()) {
        $TempPath = Join-Path ([System.IO.Path]::GetTempPath()) ("found-roll-secret-$([guid]::NewGuid().ToString('N')).bin")
        try {
            $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$Entry.Value)
            [System.IO.File]::WriteAllBytes($TempPath, $Bytes)
            $VersionName = gcloud secrets versions add $Entry.Key --data-file=$TempPath --format="value(name)"
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($VersionName)) { throw "Secret upload failed for $($Entry.Key)." }
            $VersionNumber = ([string]$VersionName -split '/')[-1]
            if ($VersionNumber -notmatch '^\d+$') { throw "Secret version was not a numeric resource version for $($Entry.Key)." }
            $SecretVersions[$Entry.Key] = $VersionNumber
        } finally {
            if (Test-Path -LiteralPath $TempPath) {
                $Length = (Get-Item -LiteralPath $TempPath).Length
                [System.IO.File]::WriteAllBytes($TempPath, [byte[]]::new([int]$Length))
                Remove-Item -LiteralPath $TempPath -Force
            }
        }
    }
} finally {
    $SecretValues.Clear()
    $SeenValues.Clear()
}
```

Prefer an ephemeral, encrypted operator environment such as Cloud Shell. Temporary-file overwrite and deletion is best effort on modern storage; do not use this workflow on a shared or untrusted host.

Grant only the consuming runtime identity access:

```powershell
gcloud secrets add-iam-policy-binding found-roll-secret-pepper --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-demo-access-token --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-admin-token --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-simulator-api-key --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-simulator-callback-secret --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-simulator-api-key --member="serviceAccount:$SimulatorServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-simulator-token-secret --member="serviceAccount:$SimulatorServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-simulator-callback-secret --member="serviceAccount:$SimulatorServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-evidence-staff-token --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding found-roll-supervisor-token --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
```

Do not print secret values during verification. Numeric version identifiers are non-secret deployment metadata; retain them only in the private deployment receipt and pin every Cloud Run mapping to the captured numeric version rather than `latest`.

Each secret should have exactly one active version after initial setup. During rotation, deploy and verify the replacement numeric version first, then destroy every superseded numeric version; leaving an old version `DISABLED` still counts it as active for Secret Manager pricing. Destruction is irreversible. Before running it, enumerate every traffic-serving and retained rollback revision and prove none references the old version.

```powershell
$SecretName = "found-roll-secret-pepper"
$SupersededVersion = "<numeric-version-after-replacement-is-serving>"
if ($SupersededVersion -notmatch '^\d+$') { throw 'Set the exact superseded numeric secret version.' }
gcloud secrets versions list $SecretName --format="table(name,state,createTime)"
# First inspect every protected revision's exported secretKeyRef entries and stop if any still use $SupersededVersion.
gcloud secrets versions destroy $SupersededVersion --secret=$SecretName
gcloud secrets versions list $SecretName --format="table(name,state,createTime)"
```

Eight current versions still mean this deployment is not Always Free; the unupgraded Free Trial, not the Secret Manager allowance, is the zero-real-money boundary.

## Prepare the simulator contract

Run the simulator tests now, but do not roll out the new simulator response before the transitional app revision. The new health payload adds `data.environment`; the transition below gives the app one narrowly bounded compatibility window for the previously deployed payload that omits this field.

```powershell
Push-Location .\simulator
try { & .\.venv\Scripts\python.exe -m pytest tests -q } finally { Pop-Location }
```

The stable simulator contract is:

- health and reads: `GET /healthz`, `/v1/custodians`, `/v1/custodians/{custodian}/inventory`, `/v1/custodians/{custodian}/inventory/{item}`, `/v1/relay/reservations/{id}`;
- authenticated mutations: `POST /v1/admin/reset`, `/v1/relay/reservations`, `/v1/relay/reservations/{id}/credentials`, `/v1/relay/reservations/{id}/attestations`, `/v1/relay/reservations/{id}/handoff-attestation`;
- callback artifact headers: `X-Found-Roll-Simulator-Timestamp` and `X-Found-Roll-Simulator-Signature: v1=<hex>`.

Verify the local contract tests before deploying the app. If the service adapter uses different paths or headers, stop and reconcile the typed contract; do not paper over the mismatch in the demo.

## Deploy the backward-compatible Found Roll app

Run local deterministic verification first:

```powershell
npm test
service\.venv\Scripts\python.exe -m pytest -o addopts= -q service\tests
npm run build
npm run test:sites
```

Record the independently executed suite counts from this frozen commit in the release receipt. Do not copy prose-era counts into the receipt.

### Inventory source-build artifacts

Every `--source` deploy invokes Cloud Build and can create a staging object plus an Artifact Registry image. Inventory the dedicated project before the first deploy and after every deploy; do not assume an Artifact Registry or Cloud Storage allowance will absorb accumulation.

```powershell
gcloud builds list --project=$ProjectId --sort-by=~createTime
$ProjectBuckets = @(gcloud storage buckets list --project=$ProjectId --format="value(name)")
foreach ($ProjectBucket in $ProjectBuckets) {
    gcloud storage du --summarize --all-versions "gs://$ProjectBucket"
    gcloud storage ls --recursive --long "gs://$ProjectBucket/**"
}
gcloud artifacts repositories list --project=$ProjectId --location=$Region
```

After the first source deploy creates the standard repository, inventory every image digest and tag:

```powershell
$SourceRepository = "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy"
gcloud artifacts docker images list $SourceRepository --include-tags --sort-by=~UPDATE_TIME
```

After both services are verified, protect every revision receiving traffic, each latest-ready revision, and every explicitly retained last-good rollback revision. Never infer safety from only the latest revision. For every older or untagged digest, prove it is absent from the complete protected-image set before deleting that exact digest rather than a repository or wildcard:

```powershell
$RetainedRollbackRevisions = @() # Add exact last-good app/simulator revision names before cleanup when they exist.
$ProtectedRevisions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Service in @($AppService, $SimulatorService)) {
    $ServiceState = gcloud run services describe $Service --region=$Region --format=json | ConvertFrom-Json
    [void]$ProtectedRevisions.Add([string]$ServiceState.status.latestReadyRevisionName)
    foreach ($TrafficTarget in @($ServiceState.status.traffic)) {
        if (-not [string]::IsNullOrWhiteSpace($TrafficTarget.revisionName)) {
            [void]$ProtectedRevisions.Add([string]$TrafficTarget.revisionName)
        }
    }
}
foreach ($Revision in $RetainedRollbackRevisions) {
    if (-not [string]::IsNullOrWhiteSpace($Revision)) { [void]$ProtectedRevisions.Add([string]$Revision) }
}

$ProtectedImages = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Revision in $ProtectedRevisions) {
    $Image = gcloud run revisions describe $Revision --region=$Region --format="value(spec.containers[0].image)"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Image)) { throw "Could not resolve protected revision $Revision." }
    [void]$ProtectedImages.Add(([string]$Image).Trim())
}

$CandidateImage = "<exact-non-serving-image>@sha256:<digest>"
if ($CandidateImage -match '[<>]' -or $CandidateImage -notmatch '@sha256:[a-f0-9]{64}$') { throw 'Set one exact digest-qualified cleanup candidate.' }
if ($ProtectedImages.Contains($CandidateImage)) { throw "Refusing to delete protected image $CandidateImage." }
gcloud artifacts docker images delete $CandidateImage --delete-tags
```

Use a filled `$CompletedBuildId` with `gcloud builds describe $CompletedBuildId --format="yaml(id,status,source,images,artifacts)"` to bind each staging object to a completed build. Delete only an exact, completed, noncanonical source object with a filled `$StagingObject` and `gcloud storage rm $StagingObject`. Repeat the untruncated build list, recursive object inventory, bucket byte totals, and image inventory afterward and preserve the redacted result. Never delete a protected serving/rollback digest or use automated wildcard deletion.

Deploy the app revision before changing the simulator. On this transitional revision only, set `FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT=true`. That flag accepts a missing legacy field but still rejects an explicit `environment=development`. The exact HTTPS app and simulator origins are supplied on the first production deploy, not discovered by a follow-up update:

```powershell
gcloud run deploy $AppService `
    --source . `
    --region=$Region `
    --service-account=$AppServiceAccount `
    --allow-unauthenticated `
    --scaling=auto `
    --min=0 `
    --max=1 `
    --min-instances=0 `
    --max-instances=1 `
    --timeout=120s `
    --cpu=1 `
    --memory=512Mi `
    --cpu-throttling `
    --no-cpu-boost `
    --concurrency=8 `
    --set-env-vars="FOUND_ROLL_ENV=production,FOUND_ROLL_REPOSITORY=firestore,FOUND_ROLL_EVIDENCE_STORE=gcs,FOUND_ROLL_ANALYST_MODE=vertex_adk,FOUND_ROLL_INVENTORY_MODE=http,FOUND_ROLL_INVENTORY_BASE_URL=$SimulatorUrl,FOUND_ROLL_INVENTORY_TIMEOUT_SECONDS=3.0,FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT=true,FOUND_ROLL_RELAY_MODE=http,FOUND_ROLL_TASKS_MODE=cloud,FOUND_ROLL_DEMO_MODE=true,FOUND_ROLL_REQUIRE_TASK_HEADER=true,FOUND_ROLL_REQUIRE_TASK_OIDC=true,FOUND_ROLL_MODEL=$Model,GOOGLE_CLOUD_PROJECT=$ProjectId,GOOGLE_CLOUD_LOCATION=$ModelLocation,FOUND_ROLL_FIRESTORE_NAMESPACE=$FirestoreNamespace,FOUND_ROLL_RELAY_BASE_URL=$SimulatorUrl,FOUND_ROLL_TASK_QUEUE=$Queue,FOUND_ROLL_TASK_LOCATION=$Region,FOUND_ROLL_TASK_SERVICE_ACCOUNT=$TaskServiceAccount,FOUND_ROLL_EVIDENCE_BUCKET=$Bucket,FOUND_ROLL_STAFF_ACTOR_ID=$StaffActorId,FOUND_ROLL_SUPERVISOR_ACTOR_ID=$SupervisorActorId,FOUND_ROLL_PUBLIC_BASE_URL=$AppUrl,FOUND_ROLL_ALLOWED_ORIGINS=$HostedClientOrigin" `
    --set-secrets="FOUND_ROLL_SECRET_PEPPER=found-roll-secret-pepper:$($SecretVersions['found-roll-secret-pepper']),FOUND_ROLL_DEMO_ACCESS_TOKEN=found-roll-demo-access-token:$($SecretVersions['found-roll-demo-access-token']),FOUND_ROLL_ADMIN_TOKEN=found-roll-admin-token:$($SecretVersions['found-roll-admin-token']),FOUND_ROLL_EVIDENCE_STAFF_TOKEN=found-roll-evidence-staff-token:$($SecretVersions['found-roll-evidence-staff-token']),FOUND_ROLL_SUPERVISOR_TOKEN=found-roll-supervisor-token:$($SecretVersions['found-roll-supervisor-token']),FOUND_ROLL_RELAY_API_KEY=found-roll-simulator-api-key:$($SecretVersions['found-roll-simulator-api-key']),FOUND_ROLL_RELAY_SHARED_SECRET=found-roll-simulator-callback-secret:$($SecretVersions['found-roll-simulator-callback-secret'])"
gcloud run services describe $AppService --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.containers[0].env)"
```

Confirm the described service URL or mapped origin is the configured `$AppUrl`, and that the compatible app revision is ready before continuing. A temporary 503 inventory-readiness result against an absent bootstrap simulator is acceptable only during a new-project rollout; the app process itself must start, and no canonical case may begin yet.

### Deploy the production simulator after the compatible app

Only after the compatible app revision is serving, deploy the simulator with production fail-closed validation:

```powershell
gcloud run deploy $SimulatorService `
    --source .\simulator `
    --region=$Region `
    --service-account=$SimulatorServiceAccount `
    --allow-unauthenticated `
    --scaling=auto `
    --min=0 `
    --max=1 `
    --min-instances=0 `
    --max-instances=1 `
    --timeout=20s `
    --cpu=1 `
    --memory=512Mi `
    --cpu-throttling `
    --no-cpu-boost `
    --concurrency=8 `
    --set-env-vars="SIMULATOR_ENV=production" `
    --set-secrets="SIMULATOR_API_KEY=found-roll-simulator-api-key:$($SecretVersions['found-roll-simulator-api-key']),SIMULATOR_TOKEN_SECRET=found-roll-simulator-token-secret:$($SecretVersions['found-roll-simulator-token-secret']),SIMULATOR_CALLBACK_SECRET=found-roll-simulator-callback-secret:$($SecretVersions['found-roll-simulator-callback-secret'])"
gcloud run services describe $SimulatorService --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.containers[0].env)"
Invoke-RestMethod "$SimulatorUrl/healthz"
Invoke-RestMethod "$AppUrl/healthz"
gcloud run services update $AppService --region=$Region --scaling=auto --min=0 --max=1 --min-instances=0 --max-instances=1 --timeout=120s --update-env-vars="FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT=false"
gcloud run services describe $AppService --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.containers[0].env)"
Invoke-RestMethod "$AppUrl/healthz"
```

The observed simulator URL or mapped origin must equal the already configured `$SimulatorUrl`. Its health payload must report `data.environment=production`; the app health probe must accept that exact envelope and return ready both before and after the compatibility flag is removed. The frozen release receipt must show the flag as `false`. `--allow-unauthenticated` makes the fictional simulator read API and health route reachable for the demo; every mutation still fails closed on its bearer API key. `SIMULATOR_ENV=production` also makes startup fail if the API, token, or callback secret is missing, shorter than 24 characters, a placeholder, or reused across purposes. `--scaling=auto` prevents inherited manual scaling. Both service-level `--max=1` and revision-level `--max-instances=1` are mandatory because this resettable simulator keeps process-local fixture state; `--min=0` and `--min-instances=0` prevent idle instances, and `--timeout=20s` bounds each simulator request. Concurrency eight limits simultaneous requests within the one allowed instance; it is not an instance cap. This is acceptable only for one synthetic demonstration and is not a persistence or scalability design. A real custodian integration must be private, durable, and use workload identity/OIDC rather than a long-lived bearer key.

The public origin does not make rich custody data public. In production, passport snapshots, events, candidates, manifests, and the demo snapshot require `X-Found-Roll-Staff-Token`. General demo mutations use `X-Found-Roll-Demo-Token`; staff evidence, identity attestation, and release also use the staff credential; intake, claimant-link issuance, and duplicate release-task delivery require both; approval uses `X-Found-Roll-Supervisor-Token`; and claimant evidence uses the one-time `X-Found-Roll-Claim-Link` against a purpose-built coarse projection. Before loading any rich projection, the browser calls `GET /api/v1/auth/runtime-roles` with all three reusable headers; the endpoint validates them strictly even in development, mutates nothing, and returns the configured actor IDs with no-store headers. The server records those exact actors and rejects a conflicting optional legacy actor field. Empty, partial, or rejected browser configuration clears the whole in-memory private session. Reset and outbox reconciliation use `X-Found-Roll-Admin-Token` from authenticated terminal/Cloud Shell tooling only. Keep the deployment in the dedicated `_synthetic_demo` namespace, use narrow CORS, cap instances, and disclose that these demo credentials are not production identity.

If the frontend is hosted separately, run the production build and freeze `artifacts/verification/frontend-build-manifest.json`, which deterministically binds every regular file below `dist/client` by path, byte length, and SHA-256. Record that manifest digest in every canonical run and the clean-browser receipt. The deployed frontend must call the exact submitted `$AppUrl`. The bundle contains an explicitly labeled, read-only offline fixture for failure presentation; it cannot verify private evidence or mutate custody and is not canonical proof. The judge-visible recording must remain connected to the submitted service and show its live health/status rather than relying on that fallback.

### Prepare a fresh model-evidence run

From an authenticated local terminal or Cloud Shell, load the five operator-only values into the current process environment without echoing them, then use the checked preparation script. The script uses the admin, staff, demo, and relay values to reset both isolated synthetic services, verify live-mode health with inventory legacy compatibility `false`, read the new workflow epoch, upload the frozen pouch source with an epoch-scoped idempotency key, and verify exactly one complete current-epoch original/preview pair is active. It checks the original checksum and GCS generation and confirms that the derivative is explicitly `MODEL_AUTHORIZED`, then emits an identifier-only receipt before analysis begins. The supervisor value is retained only for the later approval step. There is no browser reset action; **Refresh case** only reloads state.

```powershell
$env:FOUND_ROLL_DEMO_ACCESS_TOKEN = gcloud secrets versions access latest --secret=found-roll-demo-access-token
$env:FOUND_ROLL_ADMIN_TOKEN = gcloud secrets versions access latest --secret=found-roll-admin-token
$env:FOUND_ROLL_EVIDENCE_STAFF_TOKEN = gcloud secrets versions access latest --secret=found-roll-evidence-staff-token
$env:FOUND_ROLL_SUPERVISOR_TOKEN = gcloud secrets versions access latest --secret=found-roll-supervisor-token
$env:FOUND_ROLL_RELAY_API_KEY = gcloud secrets versions access latest --secret=found-roll-simulator-api-key
./scripts/prepare-canonical-run.ps1 -AppUrl $AppUrl -SimulatorUrl $SimulatorUrl -ReceiptPath artifacts/private/canonical-preparation-1.json
```

Repeat the preparation and reset-to-close workflow with receipt suffixes `2` through `5`. Never reuse a preparation receipt across runs: each reset must produce a distinct workflow epoch, evidence pair, and run receipt.

For each execution, copy `docs/canonical-run.template.json` and `docs/chain-audit.template.json` into ignored `artifacts/private/`. Fill the run receipt only with sanitized identifiers, digests, counts, modes, and booleans. Fill the chain audit from the authenticated event-list and manifest responses for that exact case, run, workflow epoch, commit, and tree. Change the run status to `CANONICAL_PASS` and the chain-audit status to `PASS` only when every field is proven. The offline verifier recomputes every event hash, previous-hash link, evidence digest, manifest ID, and manifest digest rather than trusting those labels. After all five runs, create the shared private privacy and clean-browser receipts from `docs/canonical-privacy.template.json` and `docs/clean-browser.template.json`. Never paste raw logs, prompts, responses, request bodies, media, tokens, signed URLs, or private object names into the sanitized run, privacy, or browser receipts; the private chain audit contains only the service event and manifest schema.

Never commit `artifacts/private/`. Clear the admin and relay values immediately after preparation. The demo, staff, and supervisor values may remain only long enough to load their matching in-memory browser fields for the recorded run; clear all three from the process environment immediately afterward.

```powershell
Remove-Item Env:FOUND_ROLL_ADMIN_TOKEN
Remove-Item Env:FOUND_ROLL_RELAY_API_KEY
# After loading the browser fields:
Remove-Item Env:FOUND_ROLL_DEMO_ACCESS_TOKEN
Remove-Item Env:FOUND_ROLL_EVIDENCE_STAFF_TOKEN
Remove-Item Env:FOUND_ROLL_SUPERVISOR_TOKEN
```

## Verification

Capture command output to a redacted release receipt. A canonical deployment is not verified until every check below passes from a clean browser and a fresh reset.

Health and revision identity:

```powershell
Invoke-RestMethod "$AppUrl/healthz"
Invoke-RestMethod "$SimulatorUrl/healthz"
gcloud run services describe $AppService --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.serviceAccountName,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources)"
gcloud run services describe $SimulatorService --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.serviceAccountName,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources)"
```

For each service, the service metadata must show `run.googleapis.com/scalingMode: automatic` and `run.googleapis.com/maxScale: '1'`; `run.googleapis.com/minScale` must be absent or `0`, which is the service default produced by `--min=0`. The revision-template annotations must show `autoscaling.knative.dev/minScale: '0'`, `autoscaling.knative.dev/maxScale: '1'`, `run.googleapis.com/cpu-throttling: 'true'`, and `run.googleapis.com/startup-cpu-boost: 'false'`. The app revision must show `timeoutSeconds: 120`; the simulator must show `timeoutSeconds: 20`. Also confirm one CPU, 512 MiB, and concurrency eight. Save these complete redacted descriptions with the release evidence. Concurrency is only the within-instance request limit; service-level `maxScale` is the true service instance cap. A service cap can briefly be exceeded while Cloud Run handles traffic spikes, which is why the separate Cloud Run spend cap and the unupgraded Free Trial remain mandatory.

The app health response must report `environment=production`, `demo_mode=true`, `vertex_adk`, `gemini-3.5-flash`, `prompt_version=found-roll-case-analyst-prompt-v1`, `output_schema_version=found-roll-analysis-proposal-v1`, `policy_version=found-roll-release-v1`, `firestore`, `cloud`, `inventory_mode=http`, `inventory_gateway_ready=true`, `inventory_legacy_health_compatibility=false`, `relay_mode=http`, and every production auth/task guard enabled. Inventory readiness is a bounded live probe that validates the simulator's exact `SIMULATED` header and health envelope; a configured URL alone is not ready. The simulator health response must permanently disclose `SIMULATED` and must not echo any secret.

Resource state:

```powershell
gcloud tasks queues describe $Queue --location=$Region --format="yaml(state,rateLimits,retryConfig)"
gcloud firestore databases describe --database="(default)"
gcloud storage buckets describe "gs://$Bucket" --format="yaml(name,location,iamConfiguration,lifecycle,versioning,softDeletePolicy)"
gcloud storage du --summarize --all-versions "gs://$Bucket"
gcloud builds list --project=$ProjectId --sort-by=~createTime
$ProjectBuckets = @(gcloud storage buckets list --project=$ProjectId --format="value(name)")
foreach ($ProjectBucket in $ProjectBuckets) {
    gcloud storage du --summarize --all-versions "gs://$ProjectBucket"
    gcloud storage ls --recursive --long "gs://$ProjectBucket/**"
}
gcloud artifacts repositories list --project=$ProjectId --location=$Region
gcloud artifacts docker images list $SourceRepository --include-tags --sort-by=~UPDATE_TIME
```

The queue receipt must show one concurrent dispatch, one dispatch per second, three maximum attempts, a positive one-second maximum retry duration, 10-second minimum backoff, 60-second maximum backoff, and two doublings. Re-run the numeric under-5-GiB assertion from the storage section rather than relying on the human-readable output. The bucket receipt must show the after-judging deletion lifecycle, no versioning, and no positive soft-delete retention. The build/artifact inventory must retain only the protected serving/rollback images plus any exact staging object still needed for a protected completed build.

Keep the redacted Billing Overview, Cloud Run spend-cap, and Gemini/Agent Platform spend-cap receipts alongside the private release evidence. The offline verifier intentionally does not query Billing; it fails closed unless the entrant explicitly confirms exact `free_trial` account type, remaining credit, remaining time, no paid activation, and both enabled spend caps.

Security negatives must all fail safely:

- call each general demo mutation with no `X-Found-Roll-Demo-Token` and an incorrect token;
- call the runtime-role probe with each missing/wrong/cross-used reusable credential, including in development, and confirm that it performs no mutation;
- call rich reads, evidence, identity, and release with missing/wrong staff credentials and the supervisor/demo credentials; omit `staff_user_id` and confirm the configured actor is recorded, then send a conflicting optional legacy value and reject it;
- call approval with missing/wrong supervisor credentials and the staff/demo credentials; omit `supervisor_user_id` and confirm the configured actor is recorded, then send a conflicting optional legacy value and reject it;
- submit claim evidence with no link, wrong-case, stale-version, expired, and replayed links; confirm a wrong answer consumes and rotates the link without returning either digest;
- call reset and outbox reconciliation with no `X-Found-Roll-Admin-Token`, an incorrect token, and the demo token;
- call `/tasks/outbox` with no token, wrong audience, wrong issuer, expired token, and wrong service-account email;
- call each simulator mutation with no API key and an incorrect API key;
- start a production-configured simulator with each secret missing, short, placeholder, or duplicated and confirm startup fails;
- tamper with the simulator’s returned signed handoff-attestation artifact using missing, stale, malformed, and invalid HMAC headers; if the submitted path also delivers that artifact to the callback endpoint, run the same negatives over HTTP;
- replay a consumed claimant/custodian credential;
- replay a completed task and a valid callback;
- submit a stale case version and stale simulator eTag;
- verify that validation errors never echo the submitted answer or token.

Canonical behavior:

- reset the simulator and Found Roll fixture through the checked terminal/Cloud Shell preparation script and authenticated reset routes, never through a browser control;
- upload `public/assets/pouch-front.jpg` through the staff evidence route with `authorize_preview_for_model=true` and the preparation script's case/workflow-epoch idempotency key; verify exact retry returns the same pair, a changed byte/consent conflicts, and only the complete current-epoch derivative is `MODEL_AUTHORIZED` and active for analysis;
- run the prepared frozen camera-pouch case from reset to `CLOSED` five consecutive times; the filmed safety/no-upload branch must be canceled and must not create a replacement dynamic intake;
- confirm one live model run and the required ADK tool trajectory per run;
- confirm exactly one reservation, release attestation, and closure per run despite deliberate duplicate delivery;
- recompute every event chain and final manifest;
- inspect Firestore and the Cloud Task created for the same case;
- invoke `/api/v1/admin/demo/outbox/reconcile` after a deliberate publish interruption and verify it republishes only eligible `PENDING` or `FAILED/PUBLISH` commands while leaving `FAILED/EXECUTE` work for manual review;
- export the matching redacted log range and run the privacy scan in `threat-and-privacy.md`;
- save case ID, task name, trace ID, model run ID, final event hash, and both Cloud Run revisions—identifiers only.

Bind the live version identifiers to the submitted source bytes: the prompt instruction and request-packet builder are frozen in `service/app/agent_contract.py`, the typed proposal and its schema version are in `service/app/domain.py`, and the deterministic release policy and version are in `service/app/policy.py`. Record each relative path and SHA-256 in the private release record; do not copy prompt text or model content into a receipt.

Do not mark the deployment green if a task was processed inline, a model result came from fixture mode, the simulator ran in-process, Firestore required manual repair, or a secret appeared in logs.

## Rollback and incident stop

Before each deploy, record the currently serving revisions:

```powershell
gcloud run services describe $AppService --region=$Region --format="value(status.traffic.revisionName)"
gcloud run services describe $SimulatorService --region=$Region --format="value(status.traffic.revisionName)"
```

If a new revision fails health, security negatives, contract tests, or a canonical reset, send all traffic back to the last verified revision:

```powershell
gcloud run services update-traffic $AppService --region=$Region --to-revisions="<last-good-app-revision>=100"
gcloud run services update-traffic $SimulatorService --region=$Region --to-revisions="<last-good-simulator-revision>=100"
```

For a privacy leak, token/callback validation defect, or unknown duplicate side effect, stop work rather than continuing the demo:

```powershell
gcloud tasks queues pause $Queue --location=$Region
gcloud run services update-traffic $AppService --region=$Region --to-revisions="<last-good-app-revision>=100"
```

Then rotate the affected secret by adding a new Secret Manager version, deploy a new revision that references it, reset only the isolated synthetic fixture namespace, rerun all negative/security tests, and resume the queue only after the root cause is verified. Do not delete logs or rewrite event history to make a failed run look clean.

Firestore rollback is an application concern, not a `git reset` operation. Never blindly delete the default database or evidence bucket. Use the fixture reset contract against the dedicated submission namespace, preserve the failed-run receipt, and confirm no other data shares that namespace.

## Submission freeze

After five green canonical runs:

- tag the submitted commit and freeze dependency locks, fixture hashes, prompt/schema/policy versions and source SHA-256 values, and the deterministic frontend build manifest;
- record both Cloud Run revision names, exact environment configuration with secret values redacted, Firestore namespace, bucket, queue, region, and model ID;
- keep billing, services, repository access, video, judge access, and synthetic fixture data available through the judging period;
- send post-deadline work to a separate branch and separate Cloud Run service names so the judge-visible revision cannot drift; and
- rerun a clean-browser smoke test after the public video and Devpost links are final.

Copy `docs/submission-release.template.json` to ignored `artifacts/private/submission-release.json`, fill every field from the frozen evidence, rerun the production build so the bound frontend manifest matches `dist/client`, and run:

```powershell
node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json
```

The command is deliberately offline. It verifies local Git, source and artifact hashes, receipt structure, cross-run identity, placeholder removal, exact `billing_account_type: "free_trial"`, and explicit confirmation of remaining trial credit/time, absence of paid activation, and both service spend caps. It does not query Google Cloud or infer account type from `billing_enabled`; retain the Billing Overview and spend-cap receipts as the evidence for those confirmations. Public reachability, judge access, the continuous video, eligibility, ownership, truthfulness, and visual/media privacy remain explicit attestations that must be checked by the entrant.

No service-account private key is needed at any stage of this runbook.

Deployment and publication remain blocked until the active unupgraded Free Trial account and both service spend caps are verified, the frozen run set supplies live Gemini and Google ADK receipts plus Google Cloud resource/revision evidence, the repository/tag has verified judge access, and the public sub-four-minute video URL exists. The research-informed story mode is already confirmed. Local green counts cannot replace any live artifact.

## After judging: teardown

After the announced judging and access-retention period ends, preserve the redacted receipts locally, then remove the synthetic evidence and the entire dedicated project. This is the authoritative teardown; lifecycle deletion and spend caps are only backstops. Resolve and compare the exact project ID before either destructive command, and stop if it is not the dedicated project recorded in the frozen release record.

```powershell
$ActiveProject = gcloud config get-value project
if ($ActiveProject -ne $ProjectId) { throw "Refusing teardown: active project '$ActiveProject' is not '$ProjectId'." }
gcloud projects describe $ProjectId --format="yaml(projectId,name,lifecycleState)"
gcloud storage du --summarize --all-versions "gs://$Bucket"
gcloud artifacts repositories list --project=$ProjectId --location=$Region
gcloud storage rm --recursive "gs://$Bucket/"
if ($LASTEXITCODE -ne 0) { throw 'Evidence deletion failed; project teardown stopped.' }
gcloud projects delete $ProjectId
if ($LASTEXITCODE -ne 0) { throw 'Dedicated-project deletion was not accepted.' }
$DescribeOutput = (& gcloud projects describe $ProjectId --format=json 2>&1 | Out-String).Trim()
$DescribeExitCode = $LASTEXITCODE
$TeardownReceipt = [ordered]@{
    schema_version = "1"
    project_id = $ProjectId
    deletion_command_accepted = $true
    post_delete_describe_exit_code = $DescribeExitCode
    post_delete_describe_output = $DescribeOutput
    recorded_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
}
$TeardownReceiptJson = $TeardownReceipt | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    (Join-Path $PWD "artifacts/private/project-teardown-receipt.json"),
    "$TeardownReceiptJson`n",
    [System.Text.UTF8Encoding]::new($false)
)
```

With versioning and soft delete disabled, `gcloud storage rm --recursive` removes the ordinary evidence objects; project deletion then removes the bucket, Cloud Run services, builds, Artifact Registry images, queue, secrets, IAM bindings, Firestore database, logs, and remaining project-scoped resources. Both actions are irreversible for this demo workflow. Do not run them before judging finishes, against a shared project, or before the local receipts are preserved. The ignored teardown receipt always records the exact project ID, the describe exit code, and either the deletion lifecycle response or the exact not-found output; it must never be an empty file. Confirm neither public URL still serves.
