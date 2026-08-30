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

The hard zero-real-money boundary is an active, unexpired, **unupgraded Google Cloud Free Trial**. Before enabling deployment APIs, obtain a direct entrant confirmation, no more than 24 hours old, that proves all of the following for the account linked to this dedicated project:

- the account type literally says **Free trial account**;
- remaining trial credit is greater than zero;
- remaining trial time is greater than zero; and
- paid activation or upgrade has not occurred and no upgrade, payment, deposit, or paid-account conversion will be made during this release.

Stop if the account is paid, upgraded, expired, absent, or cannot be distinguished from a paid account. Never click **Activate** or **Upgrade**, add a payment, make a deposit, or convert the account for this project. The private release record must say `billing_account_type: "free_trial"` exactly and confirm remaining credit, remaining time, absence of paid activation, and the no-upgrade/no-payment commitment.

Before API enablement, create two separate project-and-service controls in the Cloud Billing console's **Preview spend-cap** flow: a Cloud Run cap of **EUR 10** and a Gemini/Agent Platform cap of **EUR 5**, both scoped to `found-roll-agentic-20260830`. The entrant must directly confirm that both say `Configured`, use those exact project/service scopes and amounts, are the lowest practical demo targets, and will not be changed during the release. Preview enforcement is not exposed through the public Google Cloud CLI or API, so the cap state cannot be independently queried by this runbook. These caps are defense in depth only: enforcement is delayed, in-flight work or overage can still consume trial credit, and persistent or storage resources outside the capped service can keep accruing. Ordinary budget alerts remain informational. Spend caps do not make a paid account acceptable and do not replace the unupgraded Free Trial boundary.

The schema-v2 preflight deliberately combines two different evidence sources. Direct entrant attestation supplies the Free Trial, remaining-credit/time, paid-activation, no-upgrade/no-payment, and spend-cap facts that the public CLI/API cannot expose. Live CLI reads independently bind the exact tracked project to an enabled billing link, hash the linked billing-account resource without storing it, and prove that the linked account is currently open. A screenshot or PNG is not required or consumed by the verifier, and the verifier does not claim to semantically prove the entrant's attested console facts.

On the first run for an attestation batch, pass a lowercase SHA-256 of the exact direct confirmation, the UTC time when that confirmation was received, and a fresh UUID v4. The verifier pins the approved confirmation digest for this release, so a different but syntactically valid digest is rejected. Do not copy the raw confirmation, billing-account resource name, credit amount, payment method, or other billing details into the repository or private JSON. The checked refresh script creates or updates the three ignored receipts and `artifacts/private/submission-release.json`, stores only `billing_account_name_sha256` for the linked billing-account resource, records `billing_account_open_cli_observed` and `entrant_attestation_confirmed`, binds the receipt hashes, and runs the operational verifier:

```powershell
$AttestationTextSha256 = '<lowercase-sha256-of-exact-direct-entrant-confirmation>'
$AttestedAtUtc = '<entrant-confirmation-received-at-utc>'
$AttestationBatchId = [guid]::NewGuid().ToString()
$PreflightRefreshLines = @(& ./scripts/refresh-google-cloud-preflight.ps1 `
    -ProjectId 'found-roll-agentic-20260830' `
    -AttestationTextSha256 $AttestationTextSha256 `
    -AttestedAtUtc $AttestedAtUtc `
    -AttestationBatchId $AttestationBatchId `
    -CloudRunCapMinorUnits 1000 `
    -AgentPlatformCapMinorUnits 500 2>&1)
$PreflightRefreshExitCode = $LASTEXITCODE
$PreflightRefreshOutput = $PreflightRefreshLines -join "`n"
if ($PreflightRefreshExitCode -ne 0 -or $PreflightRefreshOutput -notmatch '(?m)^GOOGLE CLOUD PREFLIGHT: PASS$') {
    throw 'Google Cloud preflight is not attestation-and-CLI bound, so deployment remains blocked.'
}
$PreflightRefreshOutput
```

The direct attestation timestamp must remain within 24 hours of the release record and current wall clock. For every operational `--preflight-only` gate, the refresh script's live CLI billing check and regenerated release-record timestamp must be within ten minutes of both each other and the current wall clock. The verifier rejects a wrong project, malformed or mismatched attestation batch, paid or unverified attestation, missing credit/time confirmation, absent no-upgrade/no-payment commitment, changed billing-account hash, closed account, or either wrong service cap. Subsequent refreshes within the same 24-hour batch may omit the three attestation parameters; the script reuses the bound attestation, re-queries the live billing link and open-account state, updates the receipt hashes and release timestamp, and reruns `--preflight-only`. Once the attestation exceeds 24 hours, or if any attested fact may have changed, stop and obtain a new direct entrant confirmation, timestamp, text digest, and UUID batch before continuing. Never hand-edit a `PASS` receipt.

Use one dedicated project in `us-central1`. Keep both Cloud Run services request-based with service-level and revision-level zero minimum instances, one maximum instance, one CPU, 512 MiB memory, CPU throttling, and no startup CPU boost. Do not add a VPC connector, load balancer, custom domain, GPU, Cloud SQL, paid support, Firestore backup/PITR/TTL, Artifact Analysis scanning, or any resource not listed in this runbook. Delete noncanonical build artifacts as you go and delete the dedicated project after judging. If the schema-v2 Free Trial receipt or either service spend-cap receipt is missing, expired, inconsistent, or fails the refresh script, do not enable deployment APIs or deploy.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.5') {
    throw 'PowerShell 7.5 or later is required for string-preserving JSON identity checks.'
}
$JsonConvertCommand = Get-Command ConvertFrom-Json -ErrorAction Stop
if (-not $JsonConvertCommand.Parameters.ContainsKey('DateKind')) {
    throw 'This PowerShell cannot preserve timestamp strings while parsing JSON.'
}
function ConvertFrom-JsonPreservingStrings {
    param([Parameter(Mandatory = $true, ValueFromPipeline = $true)][string]$Json)
    begin { $JsonLines = [System.Collections.Generic.List[string]]::new() }
    process { [void]$JsonLines.Add($Json) }
    end {
        return Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ($JsonLines -join "`n") -DateKind String -ErrorAction Stop
    }
}
$ResourceIdentityPath = Join-Path $PWD "docs/google-cloud-resource-identity.json"
if (-not (Test-Path -LiteralPath $ResourceIdentityPath -PathType Leaf)) { throw 'The tracked Google Cloud resource identity is missing.' }
$ResourceIdentity = Get-Content -Raw -LiteralPath $ResourceIdentityPath | ConvertFrom-JsonPreservingStrings
if (
    $ResourceIdentity.schema_version -ne '1' -or
    $ResourceIdentity.kind -ne 'found-roll-google-cloud-resource-identity' -or
    $ResourceIdentity.project_id -ne 'found-roll-agentic-20260830' -or
    [string]$ResourceIdentity.project_number -ne '1061926987746' -or
    $ResourceIdentity.project_created_at_utc -ne '2026-08-29T22:58:52.064Z' -or
    $ResourceIdentity.evidence_bucket -ne 'found-roll-agentic-20260830-found-roll-evidence' -or
    $ResourceIdentity.dedicated_project_label_key -ne 'found-roll-purpose' -or
    $ResourceIdentity.dedicated_project_label_value -ne 'dedicated-hackathon-demo'
) { throw 'The tracked resource identity is not the pre-authorized Found Roll project.' }
$ProjectId = [string]$ResourceIdentity.project_id
$ProjectNumber = [string]$ResourceIdentity.project_number
$ProjectCreatedAt = [string]$ResourceIdentity.project_created_at_utc
$Region = "us-central1"
$CloudBuildLocations = @()
$ModelLocation = "global"
$FirestoreLocation = "nam5"
$AppService = "found-roll-app"
$SimulatorService = "found-roll-simulator"
$Queue = "found-roll"
$Bucket = [string]$ResourceIdentity.evidence_bucket
$AppServiceAccount = "found-roll-app@$ProjectId.iam.gserviceaccount.com"
$SimulatorServiceAccount = "found-roll-simulator@$ProjectId.iam.gserviceaccount.com"
$TaskServiceAccount = "found-roll-tasks@$ProjectId.iam.gserviceaccount.com"
$FirestoreNamespace = "foundRoll_submission_v1_synthetic_demo"
$Model = "gemini-3.5-flash"
$StaffActorId = "staff.northport"
$SupervisorActorId = "supervisor.northport"
$AppUrl = "https://$($AppService)-$($ProjectNumber).$($Region).run.app"
$SimulatorUrl = "https://$($SimulatorService)-$($ProjectNumber).$($Region).run.app"
$HostedClientOrigin = $AppUrl
$DedicatedProjectLabelKey = [string]$ResourceIdentity.dedicated_project_label_key
$DedicatedProjectLabelValue = [string]$ResourceIdentity.dedicated_project_label_value
$ReleaseRecordPath = Join-Path $PWD "artifacts/private/submission-release.json"
$AppStorageReceiptPath = Join-Path $PWD "artifacts/private/storage-after-app-source-deploy.json"
$SimulatorStorageReceiptPath = Join-Path $PWD "artifacts/private/storage-after-simulator-source-deploy.json"
$RetainedRollbackRevisionDeclaration = @("<exact-revision-names-or-literal-NONE>")

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Value)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [Convert]::ToHexString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
    } finally {
        $Hasher.Dispose()
    }
}

function Assert-LastGcloudSuccess {
    param([Parameter(Mandatory = $true)][string]$Operation)
    if ($LASTEXITCODE -ne 0) { throw "gcloud failed during $Operation." }
}

function Get-AllCloudBuildLocations {
    $AccessTokenLines = @(& gcloud auth print-access-token)
    if ($LASTEXITCODE -ne 0) { throw 'Could not obtain an in-memory token for the Cloud Build locations inventory.' }
    $AccessToken = ($AccessTokenLines -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($AccessToken)) { throw 'Cloud Build locations inventory received an empty access token.' }
    $Headers = @{ Authorization = "Bearer $AccessToken" }
    $Locations = @('global')
    $PageToken = $null
    try {
        do {
            $LocationsUri = "https://cloudbuild.googleapis.com/v2/projects/$ProjectId/locations?pageSize=1000"
            if (-not [string]::IsNullOrWhiteSpace($PageToken)) {
                $LocationsUri += "&pageToken=$([uri]::EscapeDataString($PageToken))"
            }
            $LocationsPage = Invoke-RestMethod -Method Get -Uri $LocationsUri -Headers $Headers -ErrorAction Stop
            $LocationsProperty = $LocationsPage.PSObject.Properties['locations']
            $LocationRecords = if ($null -eq $LocationsProperty -or $null -eq $LocationsProperty.Value) { @() } else { @($LocationsProperty.Value) }
            foreach ($LocationRecord in @($LocationRecords | Where-Object { $null -ne $_ })) {
                $LocationName = [string]$LocationRecord.name
                $LocationMatch = [regex]::Match($LocationName, "^projects/(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))/locations/([a-z][a-z0-9-]{0,62})$")
                if (-not $LocationMatch.Success) { throw 'Cloud Build returned a location outside the exact project-scoped locations endpoint.' }
                $Locations += $LocationMatch.Groups[1].Value
            }
            $NextPageTokenProperty = $LocationsPage.PSObject.Properties['nextPageToken']
            $PageToken = if ($null -eq $NextPageTokenProperty) { '' } else { [string]$NextPageTokenProperty.Value }
        } while (-not [string]::IsNullOrWhiteSpace($PageToken))
    } finally {
        $Headers.Clear()
        $AccessToken = $null
        $AccessTokenLines = @()
    }
    $Locations = @($Locations | Sort-Object -Unique)
    if ($Locations -notcontains 'global' -or $Locations -notcontains $Region) {
        throw 'Cloud Build locations inventory omitted global or the deployment region.'
    }
    return $Locations
}

function ConvertTo-CanonicalJsonNode {
    param([AllowNull()]$InputObject)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [string] -or $InputObject -is [ValueType]) { return $InputObject }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $CanonicalObject = [ordered]@{}
        foreach ($Key in @($InputObject.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            $CanonicalObject[$Key] = ConvertTo-CanonicalJsonNode -InputObject $InputObject[$Key]
        }
        return [pscustomobject]$CanonicalObject
    }
    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $CanonicalObject = [ordered]@{}
        foreach ($Property in @($InputObject.PSObject.Properties | Sort-Object Name)) {
            $CanonicalObject[$Property.Name] = ConvertTo-CanonicalJsonNode -InputObject $Property.Value
        }
        return [pscustomobject]$CanonicalObject
    }
    if ($InputObject -is [System.Collections.IEnumerable]) {
        $CanonicalItems = @()
        foreach ($Item in $InputObject) { $CanonicalItems += ,(ConvertTo-CanonicalJsonNode -InputObject $Item) }
        Write-Output -NoEnumerate $CanonicalItems
        return
    }
    throw "Cannot canonicalize JSON value of type $($InputObject.GetType().FullName)."
}

function Get-CanonicalJsonHash {
    param([AllowNull()]$InputObject)
    $CanonicalJson = ConvertTo-CanonicalJsonNode -InputObject $InputObject | ConvertTo-Json -Compress -Depth 20
    return Get-Sha256Hex -Value $CanonicalJson
}

function Resolve-ExactArtifactImageResource {
    param(
        [Parameter(Mandatory = $true)][string]$InputImage,
        [Parameter(Mandatory = $true)][string]$ResolvedDigest,
        [Parameter(Mandatory = $true)][string]$ExpectedRepositoryPrefix
    )
    if ($ResolvedDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'An image has no exact resolved SHA-256 digest.' }
    $EmbeddedDigestMatch = [regex]::Match($InputImage, '@(sha256:[a-f0-9]{64})$')
    if ($EmbeddedDigestMatch.Success -and $EmbeddedDigestMatch.Groups[1].Value -ne $ResolvedDigest) {
        throw 'A digest-qualified input image disagrees with its authoritative resolved digest.'
    }
    $ImageWithoutDigest = [regex]::Replace($InputImage, '@sha256:[a-f0-9]{64}$', '')
    $ImagePackage = [regex]::Replace($ImageWithoutDigest, ':[^/:@]+$', '')
    if ($ImagePackage -notmatch "^$([regex]::Escape($ExpectedRepositoryPrefix))[^:/@\s]+$") {
        throw 'An image package is outside the exact dedicated source-deploy repository.'
    }
    return [pscustomobject]@{
        package = $ImagePackage
        digest = $ResolvedDigest
        resource = "$ImagePackage@$ResolvedDigest"
    }
}

function ConvertTo-CanonicalStorageSourceLocation {
    param([Parameter(Mandatory = $true)][string]$SourceLocation)
    $SourceMatch = [regex]::Match($SourceLocation, '^gs://([^/]+)/(.+?)(?:#([0-9]+))?$')
    if (-not $SourceMatch.Success -or $SourceMatch.Groups[2].Value.Contains('..')) {
        throw 'A source build has an invalid Cloud Storage source location.'
    }
    $Canonical = "gs://$($SourceMatch.Groups[1].Value)/$($SourceMatch.Groups[2].Value)"
    if ($SourceMatch.Groups[3].Success) { $Canonical += "#$($SourceMatch.Groups[3].Value)" }
    return $Canonical
}

function ConvertTo-SanitizedObjectInventory {
    param(
        [Parameter(Mandatory = $true)][string]$BucketName,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][array]$CloudObjects
    )
    $SanitizedObjects = @()
    foreach ($CloudObject in $CloudObjects) {
        $ObjectName = [string]$CloudObject.name
        $Generation = [string]$CloudObject.generation
        $ObjectBytes = [int64]0
        if (
            [string]::IsNullOrWhiteSpace($ObjectName) -or
            $Generation -notmatch '^\d{1,32}$' -or
            -not [int64]::TryParse([string]$CloudObject.size, [ref]$ObjectBytes) -or
            $ObjectBytes -lt 0
        ) { throw "Could not sanitize an object generation in gs://$BucketName." }
        $SanitizedObjects += [ordered]@{
            object_id_sha256 = Get-Sha256Hex -Value "$BucketName`n$ObjectName`n$Generation"
            generation = $Generation
            size_bytes = $ObjectBytes
        }
    }
    return @($SanitizedObjects | Sort-Object object_id_sha256)
}

function Resolve-RetainedRollbackRevisions {
    if (
        $RetainedRollbackRevisionDeclaration.Count -eq 0 -or
        @($RetainedRollbackRevisionDeclaration | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -match '[<>]' }).Count -gt 0
    ) { throw 'Declare every retained last-good revision, or the literal NONE, before cleanup.' }
    if ($RetainedRollbackRevisionDeclaration.Count -eq 1 -and $RetainedRollbackRevisionDeclaration[0] -eq 'NONE') {
        return @()
    }
    if ($RetainedRollbackRevisionDeclaration -contains 'NONE') {
        throw 'NONE cannot be mixed with retained revision names.'
    }
    foreach ($Revision in $RetainedRollbackRevisionDeclaration) {
        if ($Revision -notmatch '^found-roll-(?:app|simulator)-\d{5}-[a-z0-9]{3}$') {
            throw "Retained rollback revision '$Revision' is not an exact Found Roll revision name."
        }
    }
    return @($RetainedRollbackRevisionDeclaration)
}
```

Both service origins must be fixed before the first production revision starts. Cloud Run's [documented deterministic service URL](https://cloud.google.com/run/docs/triggering/https-request#deterministic_url) is `https://SERVICE_NAME-PROJECT_NUMBER.REGION.run.app`; both Found Roll DNS segments are below the 63-character limit, so the variables above derive their exact first-deploy origins from the tracked service names, project number, and region. Do not create a bootstrap revision merely to discover a URL, and do not deploy with the localhost default and plan to patch `FOUND_ROLL_PUBLIC_BASE_URL` afterward: production validation rejects that revision before it can become ready, and the Cloud Tasks audience would be wrong. After each source deployment, require the authoritative Cloud Run `status.url` to equal the corresponding derived origin before continuing.

Authenticate an operator account with permission to create the resources below and set the project:

```powershell
gcloud auth login
gcloud config set project $ProjectId
gcloud config set run/region $Region
gcloud auth list
gcloud config list project
$ProjectState = gcloud projects describe $ProjectId --format=json | ConvertFrom-JsonPreservingStrings
if (
    $ProjectState.projectId -ne $ProjectId -or
    [string]$ProjectState.projectNumber -ne $ProjectNumber -or
    [string]$ProjectState.createTime -ne $ProjectCreatedAt -or
    $ProjectState.lifecycleState -ne "ACTIVE"
) { throw 'The live project does not match the pre-authorized tracked Found Roll identity.' }

# This control-plane API enablement is non-billable and is intentionally separate
# from the runtime API enablement guarded below.
gcloud services enable cloudresourcemanager.googleapis.com --project=$ProjectId
Assert-LastGcloudSuccess -Operation 'Cloud Resource Manager control-plane API enablement'

$ProjectLabels = [ordered]@{}
if ($null -ne $ProjectState.labels) {
    foreach ($LabelProperty in $ProjectState.labels.PSObject.Properties) {
        $ProjectLabels[$LabelProperty.Name] = [string]$LabelProperty.Value
    }
}
$ProjectLabels[$DedicatedProjectLabelKey] = $DedicatedProjectLabelValue
$ProjectLabelBody = [ordered]@{
    name = "projects/$ProjectNumber"
    labels = $ProjectLabels
} | ConvertTo-Json -Depth 4 -Compress
$AccessTokenLines = @(& gcloud auth print-access-token)
if ($LASTEXITCODE -ne 0) { throw 'Could not obtain an in-memory token for dedicated-project labeling.' }
$AccessToken = ($AccessTokenLines -join "`n").Trim()
if ([string]::IsNullOrWhiteSpace($AccessToken)) { throw 'Dedicated-project labeling received an empty access token.' }
$Headers = @{ Authorization = "Bearer $AccessToken" }
try {
    $ProjectLabelOperation = Invoke-RestMethod `
        -Method Patch `
        -Uri "https://cloudresourcemanager.googleapis.com/v3/projects/${ProjectNumber}?updateMask=labels" `
        -Headers $Headers `
        -ContentType 'application/json' `
        -Body $ProjectLabelBody `
        -ErrorAction Stop
} finally {
    $Headers.Clear()
    $AccessToken = $null
    $AccessTokenLines = @()
}
if ([string]::IsNullOrWhiteSpace([string]$ProjectLabelOperation.name)) {
    throw 'The Cloud Resource Manager label PATCH returned no operation identity.'
}
$ProjectLabelVerified = $false
for ($ProjectLabelAttempt = 0; $ProjectLabelAttempt -lt 15; $ProjectLabelAttempt += 1) {
    $LabeledProjectJson = gcloud projects describe $ProjectId --format=json
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the dedicated-project label after the REST PATCH.' }
    $LabeledProject = $LabeledProjectJson | ConvertFrom-JsonPreservingStrings
    if (
        $LabeledProject.projectId -ne $ProjectId -or
        [string]$LabeledProject.projectNumber -ne $ProjectNumber -or
        [string]$LabeledProject.createTime -ne $ProjectCreatedAt -or
        $LabeledProject.lifecycleState -ne 'ACTIVE'
    ) { throw 'Project identity changed while verifying the dedicated-project label.' }
    if ($LabeledProject.labels.$DedicatedProjectLabelKey -eq $DedicatedProjectLabelValue) {
        $ProjectLabelVerified = $true
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $ProjectLabelVerified) { throw 'The dedicated-project label did not converge after the REST PATCH.' }

function Assert-DedicatedProjectIdentity {
    $ActiveProject = ([string](gcloud config get-value project)).Trim()
    if ($LASTEXITCODE -ne 0 -or $ActiveProject -ne $ProjectId) {
        throw "The active gcloud project is not the tracked Found Roll project."
    }
    $ProjectJson = gcloud projects describe $ProjectId --format=json
    if ($LASTEXITCODE -ne 0) { throw 'Could not re-read the dedicated Google Cloud project.' }
    $LiveProjectState = $ProjectJson | ConvertFrom-JsonPreservingStrings
    if (
        $LiveProjectState.projectId -ne $ProjectId -or
        [string]$LiveProjectState.projectNumber -ne $ProjectNumber -or
        [string]$LiveProjectState.createTime -ne $ProjectCreatedAt -or
        $LiveProjectState.lifecycleState -ne 'ACTIVE' -or
        $LiveProjectState.labels.$DedicatedProjectLabelKey -ne $DedicatedProjectLabelValue
    ) { throw 'The active project no longer matches the tracked dedicated Found Roll identity.' }
}

function Assert-GoogleCloudPreflight {
    param([Parameter(Mandatory = $true)][string]$PhaseName)
    if ([string]::IsNullOrWhiteSpace($PhaseName) -or $PhaseName -match '[<>]') { throw 'Name the guarded cloud phase.' }
    Assert-DedicatedProjectIdentity

    $PreflightRefreshLines = @(& ./scripts/refresh-google-cloud-preflight.ps1 -ProjectId $ProjectId 2>&1)
    $PreflightRefreshExitCode = $LASTEXITCODE
    $PreflightRefreshOutput = $PreflightRefreshLines -join "`n"
    if ($PreflightRefreshExitCode -ne 0 -or $PreflightRefreshOutput -notmatch '(?m)^GOOGLE CLOUD PREFLIGHT: PASS$') {
        throw "Fresh entrant-attestation and live-CLI preflight failed for phase '$PhaseName'."
    }

    if (-not (Test-Path -LiteralPath $ReleaseRecordPath -PathType Leaf)) { throw 'The private preflight release record is missing.' }
    $PreflightRecord = Get-Content -Raw -LiteralPath $ReleaseRecordPath | ConvertFrom-JsonPreservingStrings
    if ($PreflightRecord.google_cloud.project_id -ne $ProjectId) { throw 'The preflight receipt project does not match the deployment project.' }
    if ([string]$PreflightRecord.google_cloud.project_number -ne $ProjectNumber) { throw 'The preflight receipt project number does not match the deployment project.' }
    if ([string]$PreflightRecord.google_cloud.evidence_bucket -ne $Bucket) { throw 'The preflight receipt does not bind the exact project-derived evidence bucket.' }

    $BillingReceiptPath = Join-Path $PWD ([string]$PreflightRecord.google_cloud.preflight_receipts.billing_overview.path)
    $BillingReceipt = Get-Content -Raw -LiteralPath $BillingReceiptPath | ConvertFrom-JsonPreservingStrings
    if (
        $BillingReceipt.entrant_attestation_confirmed -ne $true -or
        $BillingReceipt.billing_account_open_cli_observed -ne $true
    ) {
        throw "The refreshed receipt does not bind both entrant attestation and live open-account CLI evidence for phase '$PhaseName'."
    }
    $PreflightRefreshOutput
    Remove-Variable BillingReceipt -ErrorAction SilentlyContinue
}
```

`Assert-GoogleCloudPreflight` invokes the checked refresh script before every guarded phase. That script re-reads the exact project identity, billing link, and open billing-account state, then regenerates the hash-bound private receipts and release record before running `--preflight-only`. It does not query or infer the Free Trial credit/time, paid-activation status, or Preview spend-cap state; those remain bound to the current direct entrant attestation.

```powershell
Assert-GoogleCloudPreflight -PhaseName "pre-deployment-refresh"
```

Application Default Credentials are acceptable for local development under an individual account. Cloud Run uses attached service-account identity. Never run `gcloud iam service-accounts keys create`, download a JSON key, or set `GOOGLE_APPLICATION_CREDENTIALS` to a repository file.

Enable only the APIs used by the submitted architecture:

```powershell
Assert-GoogleCloudPreflight -PhaseName "api-enablement"
gcloud services enable cloudresourcemanager.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com firestore.googleapis.com storage.googleapis.com cloudtasks.googleapis.com secretmanager.googleapis.com cloudasset.googleapis.com iamcredentials.googleapis.com logging.googleapis.com --project=$ProjectId
Assert-LastGcloudSuccess -Operation 'bounded API enablement'
$CloudBuildLocations = @(Get-AllCloudBuildLocations)
```

## Service accounts and least privilege

Create three dedicated identities:

```powershell
gcloud iam service-accounts create found-roll-app --project=$ProjectId --display-name="Found Roll application runtime"
Assert-LastGcloudSuccess -Operation 'app service-account creation'
gcloud iam service-accounts create found-roll-simulator --project=$ProjectId --display-name="Found Roll disclosed simulator runtime"
Assert-LastGcloudSuccess -Operation 'simulator service-account creation'
gcloud iam service-accounts create found-roll-tasks --project=$ProjectId --display-name="Found Roll Cloud Tasks caller"
Assert-LastGcloudSuccess -Operation 'task service-account creation'
```

Grant the application only the roles needed by the canonical path:

```powershell
gcloud projects add-iam-policy-binding $ProjectId --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/datastore.user"
Assert-LastGcloudSuccess -Operation 'app Firestore IAM binding'
gcloud projects add-iam-policy-binding $ProjectId --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/cloudtasks.enqueuer"
Assert-LastGcloudSuccess -Operation 'app Cloud Tasks IAM binding'
gcloud projects add-iam-policy-binding $ProjectId --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/aiplatform.user"
Assert-LastGcloudSuccess -Operation 'app Vertex AI IAM binding'
gcloud projects add-iam-policy-binding $ProjectId --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/logging.logWriter"
Assert-LastGcloudSuccess -Operation 'app logging IAM binding'
gcloud projects add-iam-policy-binding $ProjectId --project=$ProjectId --member="serviceAccount:$SimulatorServiceAccount" --role="roles/logging.logWriter"
Assert-LastGcloudSuccess -Operation 'simulator logging IAM binding'
gcloud iam service-accounts add-iam-policy-binding $TaskServiceAccount --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/iam.serviceAccountUser"
Assert-LastGcloudSuccess -Operation 'task service-account user binding'
```

After the app service exists, allow only the task caller to invoke it through Google IAM in deployments where the entire service can remain private. If the hosted client requires the app service to be public, application-layer OIDC validation on `/tasks/outbox` remains mandatory because Cloud Run IAM is service-wide rather than route-specific.

The Cloud Tasks service agent must be able to mint an OIDC token for the task caller. Compute its principal and bind it on the task service account:

```powershell
$TasksServiceAgent = "service-$ProjectNumber@gcp-sa-cloudtasks.iam.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding $TaskServiceAccount --project=$ProjectId --member="serviceAccount:$TasksServiceAgent" --role="roles/iam.serviceAccountTokenCreator"
Assert-LastGcloudSuccess -Operation 'Cloud Tasks token-creator binding'
```

The deploying operator also needs permission to act as the runtime service accounts. Grant that narrowly through your organization’s normal deployer role; do not give the runtime accounts Owner or Editor.

## Firestore, Storage, and Cloud Tasks

Create a Firestore Native database only if the project does not already have one. Database location is effectively permanent, so confirm it before running the create command:

```powershell
Assert-GoogleCloudPreflight -PhaseName "infrastructure-provisioning"
gcloud firestore databases list
gcloud firestore databases create --project=$ProjectId --location=$FirestoreLocation --type=firestore-native
Assert-LastGcloudSuccess -Operation 'Firestore database creation'
```

Create a private evidence bucket with uniform bucket-level access, public-access prevention, and soft delete disabled. Google Cloud Storage otherwise applies a default seven-day soft-delete policy whose retained bytes can continue to consume storage after ordinary deletion. Bucket names are global, so a successful command is not enough: resolve the bucket afterward and prove its `projectNumber` equals this dedicated Free Trial project before any update, IAM binding, or use.

```powershell
$ExistingBucketJson = @(& gcloud storage buckets describe "gs://$Bucket" --format=json 2>$null)
$ExistingBucketExitCode = $LASTEXITCODE
if ($ExistingBucketExitCode -ne 0) {
    gcloud storage buckets create "gs://$Bucket" --project=$ProjectId --location=$Region --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
    Assert-LastGcloudSuccess -Operation 'evidence-bucket creation'
}
$EvidenceBucketJson = gcloud storage buckets describe "gs://$Bucket" --format=json
if ($LASTEXITCODE -ne 0) { throw "Could not resolve the evidence bucket gs://$Bucket after creation." }
$EvidenceBucketState = $EvidenceBucketJson | ConvertFrom-JsonPreservingStrings
if (
    [string]$EvidenceBucketState.name -ne $Bucket -or
    [string]$EvidenceBucketState.projectNumber -ne $ProjectNumber
) { throw "Refusing to use gs://$Bucket because it is not owned by dedicated project number $ProjectNumber." }
gcloud storage buckets update "gs://$Bucket" --project=$ProjectId --clear-soft-delete
Assert-LastGcloudSuccess -Operation 'evidence-bucket soft-delete disablement'
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
    gcloud storage buckets update "gs://$Bucket" --project=$ProjectId --lifecycle-file=$LifecyclePath
    Assert-LastGcloudSuccess -Operation 'evidence-bucket lifecycle update'
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
gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/storage.objectUser"
Assert-LastGcloudSuccess -Operation 'evidence-bucket IAM binding'
```

Create the queue in the same region as the app with a fully bounded demo retry policy. If it already exists, run the update command instead so an old default—up to 100 attempts—cannot survive:

```powershell
gcloud tasks queues create $Queue --project=$ProjectId --location=$Region --max-concurrent-dispatches=1 --max-dispatches-per-second=1 --max-attempts=3 --max-retry-duration=1s --min-backoff=10s --max-backoff=60s --max-doublings=2
Assert-LastGcloudSuccess -Operation 'Cloud Tasks queue creation'
# Use this instead when the queue already exists:
gcloud tasks queues update $Queue --project=$ProjectId --location=$Region --max-concurrent-dispatches=1 --max-dispatches-per-second=1 --max-attempts=3 --max-retry-duration=1s --min-backoff=10s --max-backoff=60s --max-doublings=2
Assert-LastGcloudSuccess -Operation 'Cloud Tasks queue policy update'
gcloud tasks queues describe $Queue --location=$Region --format="yaml(state,rateLimits,retryConfig)"
```

Cloud Tasks stops only after both the attempt count and retry duration are satisfied; `0s` means unlimited duration and must not be used here. The runtime contract is `ANALYSIS_EXECUTION_LEASE_SECONDS=5`, while the queue minimum backoff is 10 seconds. The lease must remain strictly shorter than `--min-backoff=10s`, so a crash redelivery cannot arrive while the analysis lease is still live. The positive `1s` maximum retry duration is already satisfied before the first retry because that minimum backoff is 10 seconds, so `--max-attempts=3` becomes the effective hard dispatch-attempt bound. The attempt that first discovers an ambiguous relay result durably records `FAILED/EXECUTE` and returns non-2xx. A redelivery that observes that already-terminal state returns a 2xx non-retryable acknowledgment without invoking the relay or appending an event. Completed deliveries are also acknowledged with 2xx.

Cloud Task bodies must contain only `schema_version`, `case_id`, and `outbox_id`. Private answers, model text, evidence, claimant links, tokens, and signed URLs never belong in task payloads or task names. Production Cloud Tasks publication/replay receipts are payload-free; only the explicit local inline adapter returns that opaque body for manual development delivery.

## Secrets

Converge the project to exactly eight secret resources. The bootstrap is resumable after a partial resource-creation or version-upload failure: it creates only missing allowlisted resources, reuses an existing secret only when it has exactly one `ENABLED` numeric version, and uploads only to an allowlisted resource that still has zero versions. Any extra secret, multiple versions, or non-`ENABLED` existing version stops the run. The demo workflow, admin recovery, staff evidence/identity/release, supervisor approval, simulator bearer API, simulator token hashing, callback HMAC, and service-side digest pepper are independent boundaries. One callback value is mapped to different environment names in the app and simulator so both validate the same HMAC contract.

```powershell
Assert-GoogleCloudPreflight -PhaseName "secret-bootstrap"
$SecretBootstrapNames = @(
    'found-roll-secret-pepper',
    'found-roll-demo-access-token',
    'found-roll-admin-token',
    'found-roll-simulator-api-key',
    'found-roll-simulator-token-secret',
    'found-roll-simulator-callback-secret',
    'found-roll-evidence-staff-token',
    'found-roll-supervisor-token'
)

function Get-ProjectWideSecretDirectInventory {
    $LocationLines = @(& gcloud secrets locations list --project=$ProjectId --limit=unlimited --format="value(locationId)" 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate every supported Secret Manager location.' }
    $SecretLocations = @('global')
    foreach ($RawLocation in $LocationLines) {
        $SecretLocation = ([string]$RawLocation).Trim()
        if ($SecretLocation -match '/') { $SecretLocation = ($SecretLocation -split '/')[-1] }
        if ([string]::IsNullOrWhiteSpace($SecretLocation)) { continue }
        if ($SecretLocation -notmatch '^[a-z][a-z0-9-]{0,62}$') { throw 'Secret Manager returned an invalid location identity.' }
        $SecretLocations += $SecretLocation
    }
    $SecretLocations = @($SecretLocations | Sort-Object -Unique)
    if ($SecretLocations -notcontains 'global') { throw 'The direct Secret Manager inventory omitted the global location.' }

    $SanitizedSecrets = @()
    $SecretProjectSegment = "(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))"
    foreach ($SecretLocation in $SecretLocations) {
        if ($SecretLocation -eq 'global') {
            $SecretJson = @(& gcloud secrets list --project=$ProjectId --limit=unlimited --format=json 2>&1)
        } else {
            $SecretJson = @(& gcloud secrets list --project=$ProjectId --location=$SecretLocation --limit=unlimited --format=json 2>&1)
        }
        if ($LASTEXITCODE -ne 0) { throw "Could not enumerate Secret Manager location $SecretLocation." }
        try { $SecretRecords = @(($SecretJson -join "`n") | ConvertFrom-JsonPreservingStrings) }
        catch { throw "Could not parse the direct Secret Manager inventory for $SecretLocation." }
        foreach ($SecretRecord in @($SecretRecords | Where-Object { $null -ne $_ })) {
            $ResourceName = [string]$SecretRecord.name
            $ExpectedPattern = if ($SecretLocation -eq 'global') {
                "^projects/$SecretProjectSegment/secrets/([^/]+)$"
            } else {
                "^projects/$SecretProjectSegment/locations/$([regex]::Escape($SecretLocation))/secrets/([^/]+)$"
            }
            $ResourceMatch = [regex]::Match($ResourceName, $ExpectedPattern)
            if (-not $ResourceMatch.Success) { throw "Secret Manager returned a resource outside exact project $ProjectNumber and location $SecretLocation." }
            $SanitizedSecrets += [pscustomobject]@{
                secret_id = $ResourceMatch.Groups[1].Value
                location = $SecretLocation
                resource_name = $ResourceName
            }
        }
    }
    $DuplicateResourceNames = @($SanitizedSecrets | Group-Object resource_name | Where-Object Count -ne 1)
    if ($DuplicateResourceNames.Count -gt 0) { throw 'The direct Secret Manager inventory returned a duplicate resource.' }
    return @($SanitizedSecrets | Sort-Object resource_name)
}

$ExistingSecretAssets = @(Get-ProjectWideSecretDirectInventory)
$RegionalSecretAssets = @($ExistingSecretAssets | Where-Object { $_.location -ne 'global' })
if ($RegionalSecretAssets.Count -gt 0) { throw 'Regional Secret Manager resources are outside the global-only Found Roll allowlist.' }
$ExistingSecretIds = @($ExistingSecretAssets | ForEach-Object { [string]$_.secret_id } | Sort-Object -Unique)
$ExpectedSecretIds = @($SecretBootstrapNames | Sort-Object -Unique)
$UnexpectedSecretIds = @($ExistingSecretIds | Where-Object { $ExpectedSecretIds -notcontains $_ })
if ($UnexpectedSecretIds.Count -gt 0) {
    throw 'Secret bootstrap stopped because the project contains a secret outside the exact Found Roll allowlist.'
}
$MissingSecretIds = @($ExpectedSecretIds | Where-Object { $ExistingSecretIds -notcontains $_ })
foreach ($SecretName in $MissingSecretIds) {
    gcloud secrets create $SecretName --project=$ProjectId --replication-policy=automatic
    Assert-LastGcloudSuccess -Operation "missing secret-resource creation for $SecretName"
}
$CreatedSecretAssets = @(Get-ProjectWideSecretDirectInventory)
$CreatedRegionalSecretAssets = @($CreatedSecretAssets | Where-Object { $_.location -ne 'global' })
if ($CreatedRegionalSecretAssets.Count -gt 0) { throw 'A regional secret appeared during bootstrap.' }
$CreatedSecretIds = @($CreatedSecretAssets | ForEach-Object { [string]$_.secret_id } | Sort-Object -Unique)
$ExpectedSecretIds = @($SecretBootstrapNames | Sort-Object)
if ($CreatedSecretIds.Count -ne $ExpectedSecretIds.Count -or @(Compare-Object $CreatedSecretIds $ExpectedSecretIds).Count -ne 0) {
    throw 'The post-bootstrap project secret inventory is not the exact eight-resource allowlist.'
}
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
$SecretsNeedingUpload = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

function Get-VerifiedSecretVersionState {
    param([Parameter(Mandatory = $true)][string]$SecretName)
    $VersionJson = @(& gcloud secrets versions list $SecretName --project=$ProjectId --limit=unlimited --format=json 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Could not enumerate every version for $SecretName." }
    try { $VersionRecords = @(($VersionJson -join "`n") | ConvertFrom-JsonPreservingStrings) }
    catch { throw "Could not parse the version inventory for $SecretName." }
    $VersionRecords = @($VersionRecords | Where-Object { $null -ne $_ })
    if ($VersionRecords.Count -eq 0) {
        return [pscustomobject]@{ Count = 0; VersionNumber = $null; State = $null }
    }
    if ($VersionRecords.Count -ne 1) { throw "$SecretName must have zero versions or exactly one intended active version." }
    $VersionResourceMatch = [regex]::Match(
        [string]$VersionRecords[0].name,
        "^projects/(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))/secrets/$([regex]::Escape($SecretName))/versions/([0-9]+)$"
    )
    if (-not $VersionResourceMatch.Success) { throw "$SecretName returned a version outside its exact project and secret resource." }
    $VersionNumber = $VersionResourceMatch.Groups[1].Value
    $VersionState = [string]$VersionRecords[0].state
    if ($VersionNumber -notmatch '^\d+$' -or $VersionState -ne 'ENABLED') {
        throw "$SecretName has one version, but it is not an exact numeric ENABLED version."
    }
    return [pscustomobject]@{ Count = 1; VersionNumber = $VersionNumber; State = $VersionState }
}

foreach ($SecretName in $SecretBootstrapNames) {
    $ExistingVersionState = Get-VerifiedSecretVersionState -SecretName $SecretName
    if ($ExistingVersionState.Count -eq 0) {
        [void]$SecretsNeedingUpload.Add($SecretName)
    } else {
        $SecretVersions[$SecretName] = [string]$ExistingVersionState.VersionNumber
    }
}

function Assert-SecretUploadState {
    Assert-DedicatedProjectIdentity
    $LiveSecretAssets = @(Get-ProjectWideSecretDirectInventory)
    if (@($LiveSecretAssets | Where-Object { $_.location -ne 'global' }).Count -gt 0) {
        throw 'Secret upload stopped because a regional secret exists.'
    }
    $LiveSecretIds = @($LiveSecretAssets | ForEach-Object { [string]$_.secret_id } | Sort-Object -Unique)
    $ExpectedSecretIds = @($SecretBootstrapNames | Sort-Object)
    if ($LiveSecretIds.Count -ne $ExpectedSecretIds.Count -or @(Compare-Object $LiveSecretIds $ExpectedSecretIds).Count -ne 0) {
        throw 'Secret upload stopped because the project-wide secret inventory changed.'
    }
    foreach ($SecretName in $SecretBootstrapNames) {
        $LiveVersionState = Get-VerifiedSecretVersionState -SecretName $SecretName
        if ($SecretVersions.Contains($SecretName)) {
            if ($LiveVersionState.Count -ne 1 -or $LiveVersionState.VersionNumber -ne [string]$SecretVersions[$SecretName]) {
                throw "Secret upload stopped because the intended active version for $SecretName changed."
            }
        } elseif ($LiveVersionState.Count -ne 0) {
            throw "Secret upload stopped because pending secret $SecretName no longer has zero versions."
        }
    }
}

function Assert-AllSecretInputValues {
    if ($SecretValues.Count -ne $SecretBootstrapNames.Count) { throw 'All eight intended secret values must be entered on every bootstrap or resume.' }
    $ValidatedValues = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($Entry in $SecretValues.GetEnumerator()) {
        $Value = [string]$Entry.Value
        if ($Value.Length -lt 24 -or $Value -ne $Value.Trim() -or $Value -match '(?i)(replace|change|example|placeholder|your-|local-)') {
            throw "$($Entry.Key) must be at least 24 characters, contain no leading/trailing whitespace, and not be a placeholder."
        }
        if (-not $ValidatedValues.Add($Value)) { throw 'Every one of the eight secret resources must use a distinct value.' }
    }
    $ValidatedValues.Clear()
}

function Test-ExactSecretFileBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedValue
    )
    $ActualBytes = [System.IO.File]::ReadAllBytes($Path)
    $ExpectedBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($ExpectedValue)
    try {
        if ($ActualBytes.Length -ne $ExpectedBytes.Length) { return $false }
        $Difference = 0
        for ($Index = 0; $Index -lt $ActualBytes.Length; $Index++) {
            $Difference = $Difference -bor ($ActualBytes[$Index] -bxor $ExpectedBytes[$Index])
        }
        return $Difference -eq 0
    } finally {
        if ($ActualBytes.Length -gt 0) { [Array]::Clear($ActualBytes, 0, $ActualBytes.Length) }
        if ($ExpectedBytes.Length -gt 0) { [Array]::Clear($ExpectedBytes, 0, $ExpectedBytes.Length) }
    }
}

function Remove-ProtectedSecretTempFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $Length = (Get-Item -LiteralPath $Path).Length
        [System.IO.File]::WriteAllBytes($Path, [byte[]]::new([int]$Length))
        Remove-Item -LiteralPath $Path -Force
    }
}

foreach ($Entry in $SecretPrompts.GetEnumerator()) {
    $Value = Read-Host -MaskInput $Entry.Value
    $SecretValues[$Entry.Key] = $Value
}
Assert-AllSecretInputValues

$ProtectedSecretTempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("found-roll-secret-$([guid]::NewGuid().ToString('N'))")
[void](New-Item -ItemType Directory -Path $ProtectedSecretTempDirectory -ErrorAction Stop)
if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $ProtectedAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $ProtectedAcl.SetAccessRuleProtection($true, $false)
    $CurrentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $ProtectedRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $CurrentIdentity,
        'FullControl',
        'ContainerInherit,ObjectInherit',
        'None',
        'Allow'
    )
    $ProtectedAcl.SetAccessRule($ProtectedRule)
    Set-Acl -LiteralPath $ProtectedSecretTempDirectory -AclObject $ProtectedAcl -ErrorAction Stop
} else {
    & chmod 700 -- $ProtectedSecretTempDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the temporary secret comparison directory.' }
}

try {
    foreach ($Entry in @($SecretValues.GetEnumerator() | Where-Object { $SecretVersions.Contains([string]$_.Key) })) {
        $ComparePath = Join-Path $ProtectedSecretTempDirectory ("existing-$([guid]::NewGuid().ToString('N')).bin")
        try {
            Assert-SecretUploadState
            Assert-GoogleCloudPreflight -PhaseName "secret-version-compare-$($Entry.Key)"
            $AccessOutput = @(& gcloud secrets versions access $($SecretVersions[$Entry.Key]) --secret=$Entry.Key --project=$ProjectId --out-file=$ComparePath 2>&1)
            if ($LASTEXITCODE -ne 0) { throw "Could not access the exact existing version for $($Entry.Key) into protected temporary storage." }
            if (-not (Test-ExactSecretFileBytes -Path $ComparePath -ExpectedValue ([string]$Entry.Value))) {
                throw "The entered value does not byte-match the exact existing intended version for $($Entry.Key)."
            }
        } finally {
            Remove-ProtectedSecretTempFile -Path $ComparePath
        }
    }

    foreach ($Entry in @($SecretValues.GetEnumerator() | Where-Object { $SecretsNeedingUpload.Contains([string]$_.Key) })) {
        $TempPath = Join-Path $ProtectedSecretTempDirectory ("upload-$([guid]::NewGuid().ToString('N')).bin")
        try {
            $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes([string]$Entry.Value)
            try { [System.IO.File]::WriteAllBytes($TempPath, $Bytes) }
            finally { if ($Bytes.Length -gt 0) { [Array]::Clear($Bytes, 0, $Bytes.Length) } }
            Assert-SecretUploadState
            Assert-GoogleCloudPreflight -PhaseName "secret-version-upload-$($Entry.Key)"
            $VersionName = gcloud secrets versions add $Entry.Key --project=$ProjectId --data-file=$TempPath --format="value(name)"
            Assert-LastGcloudSuccess -Operation "first-version upload for $($Entry.Key)"
            if ([string]::IsNullOrWhiteSpace($VersionName)) { throw "Secret upload returned no version for $($Entry.Key)." }
            $VersionNumber = ([string]$VersionName -split '/')[-1]
            if ($VersionNumber -notmatch '^\d+$') { throw "Secret version was not a numeric resource version for $($Entry.Key)." }
            $SecretVersions[$Entry.Key] = $VersionNumber
            Assert-SecretUploadState
        } finally {
            Remove-ProtectedSecretTempFile -Path $TempPath
        }
    }
    if ($SecretVersions.Count -ne $SecretBootstrapNames.Count) { throw 'Secret bootstrap did not converge all eight exact version bindings.' }
    Assert-SecretUploadState
} finally {
    $SecretValues.Clear()
    $SecretsNeedingUpload.Clear()
    Remove-Variable Value, Entry, Bytes, AccessOutput -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $ProtectedSecretTempDirectory -PathType Container) {
        Remove-Item -LiteralPath $ProtectedSecretTempDirectory -Force
    }
}
```

Prefer an ephemeral, encrypted operator environment such as Cloud Shell. Temporary-file overwrite and deletion is best effort on modern storage; do not use this workflow on a shared or untrusted host.

Grant only the consuming runtime identity access:

```powershell
gcloud secrets add-iam-policy-binding found-roll-secret-pepper --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'secret-pepper IAM binding'
gcloud secrets add-iam-policy-binding found-roll-demo-access-token --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'demo-token IAM binding'
gcloud secrets add-iam-policy-binding found-roll-admin-token --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'admin-token IAM binding'
gcloud secrets add-iam-policy-binding found-roll-simulator-api-key --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'app simulator-key IAM binding'
gcloud secrets add-iam-policy-binding found-roll-simulator-callback-secret --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'app simulator-callback IAM binding'
gcloud secrets add-iam-policy-binding found-roll-simulator-api-key --project=$ProjectId --member="serviceAccount:$SimulatorServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'simulator API-key IAM binding'
gcloud secrets add-iam-policy-binding found-roll-simulator-token-secret --project=$ProjectId --member="serviceAccount:$SimulatorServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'simulator token-secret IAM binding'
gcloud secrets add-iam-policy-binding found-roll-simulator-callback-secret --project=$ProjectId --member="serviceAccount:$SimulatorServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'simulator callback IAM binding'
gcloud secrets add-iam-policy-binding found-roll-evidence-staff-token --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'evidence-staff-token IAM binding'
gcloud secrets add-iam-policy-binding found-roll-supervisor-token --project=$ProjectId --member="serviceAccount:$AppServiceAccount" --role="roles/secretmanager.secretAccessor"
Assert-LastGcloudSuccess -Operation 'supervisor-token IAM binding'
```

Do not print secret values during verification. Numeric version identifiers are non-secret deployment metadata; retain them only in the private deployment receipt and pin every Cloud Run mapping to the captured numeric version rather than `latest`.

Each secret should have exactly one active version after initial setup. During rotation, deploy and verify the replacement numeric version first, then destroy every superseded numeric version; leaving an old version `DISABLED` still counts it as active for Secret Manager pricing. Destruction is irreversible. Before running it, enumerate every traffic-serving and retained rollback revision and prove none references the old version.

```powershell
$SecretName = "found-roll-secret-pepper"
$SupersededVersion = "<exact-superseded-numeric-version>"
$ReplacementVersion = "<exact-enabled-replacement-numeric-version>"
if ($SupersededVersion -notmatch '^\d+$' -or $ReplacementVersion -notmatch '^\d+$' -or $SupersededVersion -eq $ReplacementVersion) {
    throw 'Set distinct exact superseded and replacement numeric secret versions.'
}
$ReplacementState = gcloud secrets versions describe $ReplacementVersion --secret=$SecretName --project=$ProjectId --format=json | ConvertFrom-JsonPreservingStrings
if ($LASTEXITCODE -ne 0 -or $ReplacementState.state -ne 'ENABLED') {
    throw "Replacement $SecretName version $ReplacementVersion is not enabled."
}
gcloud secrets versions list $SecretName --project=$ProjectId --format="table(name,state,createTime)"
$RetainedRollbackRevisions = @(Resolve-RetainedRollbackRevisions)
$RotationProtectedRevisions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Service in @($AppService, $SimulatorService)) {
    $ServiceState = gcloud run services describe $Service --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
    if ($LASTEXITCODE -ne 0) { throw "Could not describe protected service $Service." }
    [void]$RotationProtectedRevisions.Add([string]$ServiceState.status.latestReadyRevisionName)
    foreach ($TrafficTarget in @($ServiceState.status.traffic)) {
        if (-not [string]::IsNullOrWhiteSpace($TrafficTarget.revisionName)) {
            [void]$RotationProtectedRevisions.Add([string]$TrafficTarget.revisionName)
        }
    }
}
foreach ($Revision in $RetainedRollbackRevisions) {
    if (-not [string]::IsNullOrWhiteSpace($Revision)) { [void]$RotationProtectedRevisions.Add([string]$Revision) }
}
$ReplacementReferenceCount = 0
foreach ($Revision in $RotationProtectedRevisions) {
    $RevisionState = gcloud run revisions describe $Revision --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect secret references for $Revision." }
    foreach ($EnvironmentEntry in @($RevisionState.spec.containers[0].env)) {
        $SecretReference = $EnvironmentEntry.valueFrom.secretKeyRef
        if ($null -eq $SecretReference) { continue }
        $ReferencedSecret = [string]$SecretReference.name
        if ([string]::IsNullOrWhiteSpace($ReferencedSecret)) { $ReferencedSecret = [string]$SecretReference.secret }
        $ReferencedVersion = [string]$SecretReference.key
        if ([string]::IsNullOrWhiteSpace($ReferencedVersion)) { $ReferencedVersion = [string]$SecretReference.version }
        if ($ReferencedSecret -eq $SecretName) {
            if ($ReferencedVersion -ne $ReplacementVersion) {
                throw "Protected revision $Revision references $SecretName version $ReferencedVersion rather than enabled replacement $ReplacementVersion."
            }
            $ReplacementReferenceCount += 1
        }
    }
}
if ($ReplacementReferenceCount -lt 1) { throw "No protected consuming revision references $SecretName version $ReplacementVersion." }
Assert-DedicatedProjectIdentity
gcloud secrets versions destroy $SupersededVersion --secret=$SecretName --project=$ProjectId
Assert-LastGcloudSuccess -Operation 'superseded secret-version destruction'
gcloud secrets versions list $SecretName --project=$ProjectId --format="table(name,state,createTime)"
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
function Assert-ProjectStorageBound {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedProjectId,
        [int64]$MaximumBytes = 5GB
    )

    Assert-DedicatedProjectIdentity
    $ActiveProject = ([string](gcloud config get-value project)).Trim()
    if ($LASTEXITCODE -ne 0 -or $ActiveProject -ne $ExpectedProjectId) {
        throw "Storage audit project '$ActiveProject' is not '$ExpectedProjectId'."
    }
    $ExpectedProjectNumber = ([string](gcloud projects describe $ExpectedProjectId --format="value(projectNumber)")).Trim()
    if ($LASTEXITCODE -ne 0 -or $ExpectedProjectNumber -notmatch '^\d{6,20}$') {
        throw 'Could not resolve the storage-audit project number.'
    }
    $SoftDeletedBucketOutput = @(& gcloud storage ls --buckets --soft-deleted --exhaustive --full --project=$ExpectedProjectId 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate soft-deleted project buckets.' }
    $SoftDeletedBucketInventoryText = $SoftDeletedBucketOutput -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($SoftDeletedBucketInventoryText)) {
        throw 'At least one soft-deleted project bucket exists and cannot be safely inventoried without restoration.'
    }
    $ProjectBuckets = @(gcloud storage buckets list --project=$ExpectedProjectId --format="value(name)" | Sort-Object)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate every project bucket.' }
    if ($ProjectBuckets -notcontains $Bucket) { throw 'The complete project inventory does not contain the frozen evidence bucket.' }
    $ProjectStorageBytes = [int64]0
    $BucketReceipts = @()
    foreach ($ProjectBucket in $ProjectBuckets) {
        gcloud storage buckets update "gs://$ProjectBucket" --project=$ExpectedProjectId --clear-soft-delete
        Assert-LastGcloudSuccess -Operation "soft-delete disablement for gs://$ProjectBucket"
        $BucketState = gcloud storage buckets describe "gs://$ProjectBucket" --format=json | ConvertFrom-JsonPreservingStrings
        if ($LASTEXITCODE -ne 0) { throw "Could not describe gs://$ProjectBucket." }
        if ([string]$BucketState.projectNumber -ne $ExpectedProjectNumber) {
            throw "Bucket gs://$ProjectBucket is not owned by expected project number $ExpectedProjectNumber."
        }
        if ($BucketState.versioning.enabled -eq $true) { throw "Versioning is enabled on gs://$ProjectBucket." }
        if ($null -ne $BucketState.retentionPolicy -and [int64]$BucketState.retentionPolicy.retentionPeriod -gt 0) {
            throw "A retention policy is enabled on gs://$ProjectBucket."
        }
        $SoftDeleteSeconds = [int64]0
        if ($null -ne $BucketState.softDeletePolicy -and $null -ne $BucketState.softDeletePolicy.retentionDurationSeconds) {
            if (-not [int64]::TryParse([string]$BucketState.softDeletePolicy.retentionDurationSeconds, [ref]$SoftDeleteSeconds)) {
                throw "Could not parse the soft-delete duration for gs://$ProjectBucket."
            }
        }
        if ($SoftDeleteSeconds -gt 0) { throw "Soft delete remains enabled on gs://$ProjectBucket." }

        $CurrentObjectJson = @(& gcloud storage objects list "gs://$ProjectBucket" --format=json 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Could not enumerate current objects in gs://$ProjectBucket." }
        try {
            $CurrentObjects = @(($CurrentObjectJson -join "`n") | ConvertFrom-JsonPreservingStrings)
        } catch { throw "Could not parse current-object inventory for gs://$ProjectBucket." }
        $AllVersionJson = @(& gcloud storage objects list "gs://$ProjectBucket" --all-versions --format=json 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Could not enumerate all object versions in gs://$ProjectBucket." }
        try {
            $AllVersionObjects = @(($AllVersionJson -join "`n") | ConvertFrom-JsonPreservingStrings)
        } catch { throw "Could not parse all-version inventory for gs://$ProjectBucket." }
        $SoftDeletedJson = @(& gcloud storage objects list "gs://$ProjectBucket" --soft-deleted --exhaustive --format=json 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Could not exhaustively enumerate soft-deleted objects in gs://$ProjectBucket." }
        try {
            $SoftDeletedObjects = @(($SoftDeletedJson -join "`n") | ConvertFrom-JsonPreservingStrings)
        } catch { throw "Could not parse soft-deleted-object inventory for gs://$ProjectBucket." }
        $CurrentObjectReceipts = @(ConvertTo-SanitizedObjectInventory -BucketName $ProjectBucket -CloudObjects $CurrentObjects)
        $AllVersionObjectReceipts = @(ConvertTo-SanitizedObjectInventory -BucketName $ProjectBucket -CloudObjects $AllVersionObjects)
        $SoftDeletedObjectReceipts = @(ConvertTo-SanitizedObjectInventory -BucketName $ProjectBucket -CloudObjects $SoftDeletedObjects)
        $NormalBytes = [int64](($AllVersionObjectReceipts | Measure-Object -Property size_bytes -Sum).Sum)
        $SoftDeletedBytes = [int64](($SoftDeletedObjectReceipts | Measure-Object -Property size_bytes -Sum).Sum)
        if ((Get-CanonicalJsonHash -InputObject $CurrentObjectReceipts) -ne (Get-CanonicalJsonHash -InputObject $AllVersionObjectReceipts)) {
            throw "Noncurrent object versions exist in gs://$ProjectBucket; remove and re-audit them before deployment."
        }
        if ($SoftDeletedObjectReceipts.Count -gt 0 -or $SoftDeletedBytes -gt 0) {
            throw "Soft-deleted objects remain in gs://$ProjectBucket; restore or permanently remove them before continuing."
        }
        $ProjectStorageBytes += $NormalBytes + $SoftDeletedBytes
        $BucketReceipts += [ordered]@{
            bucket = $ProjectBucket
            project_number = $ExpectedProjectNumber
            ordinary_bytes = $NormalBytes
            soft_deleted_bytes = $SoftDeletedBytes
            current_object_count = $CurrentObjectReceipts.Count
            all_version_object_count = $AllVersionObjectReceipts.Count
            soft_deleted_object_count = $SoftDeletedObjectReceipts.Count
            versioning_enabled = $false
            retention_policy_seconds = 0
            soft_delete_seconds = $SoftDeleteSeconds
            current_object_inventory_sha256 = Get-CanonicalJsonHash -InputObject $CurrentObjectReceipts
            all_version_object_inventory_sha256 = Get-CanonicalJsonHash -InputObject $AllVersionObjectReceipts
            soft_deleted_object_inventory_sha256 = Get-CanonicalJsonHash -InputObject $SoftDeletedObjectReceipts
            current_objects = $CurrentObjectReceipts
            all_version_objects = $AllVersionObjectReceipts
            soft_deleted_objects = $SoftDeletedObjectReceipts
        }
    }
    if ($ProjectStorageBytes -ge $MaximumBytes) {
        throw "Aggregate project storage is not under $MaximumBytes bytes: $ProjectStorageBytes bytes."
    }
    $BucketReceipts = @($BucketReceipts | Sort-Object bucket)
    $SoftDeletedBucketReceipts = @()
    return [ordered]@{
        project_id = $ExpectedProjectId
        project_number = $ExpectedProjectNumber
        maximum_bytes_exclusive = $MaximumBytes
        observed_bytes = $ProjectStorageBytes
        active_bucket_inventory_sha256 = Get-CanonicalJsonHash -InputObject $BucketReceipts
        soft_deleted_bucket_inventory_sha256 = Get-CanonicalJsonHash -InputObject $SoftDeletedBucketReceipts
        soft_deleted_bucket_count = 0
        soft_deleted_bucket_inventory_exhaustive = $true
        soft_deleted_object_inventory_exhaustive = $true
        buckets = $BucketReceipts
        soft_deleted_buckets = $SoftDeletedBucketReceipts
    }
}

function Write-ProjectStorageAuditReceipt {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('after_app_source_deploy', 'after_simulator_source_deploy')][string]$Phase,
        [Parameter(Mandatory = $true)][ValidateSet('found-roll-app', 'found-roll-simulator')][string]$Service,
        [Parameter(Mandatory = $true)][string]$ReceiptPath
    )
    Assert-DedicatedProjectIdentity
    $Storage = Assert-ProjectStorageBound -ExpectedProjectId $ProjectId -MaximumBytes 5GB
    $ServiceStateJson = gcloud run services describe $Service --project=$ProjectId --region=$Region --format=json
    if ($LASTEXITCODE -ne 0) { throw "Could not resolve the source-deployed service $Service." }
    $ServiceState = $ServiceStateJson | ConvertFrom-JsonPreservingStrings
    $Revision = [string]$ServiceState.status.latestReadyRevisionName
    if ($Revision -notmatch "^$([regex]::Escape($Service))-\d{5}-[a-z0-9]{3}$") {
        throw "Could not resolve the exact latest-ready revision for $Service."
    }
    $RevisionStateJson = gcloud run revisions describe $Revision --project=$ProjectId --region=$Region --format=json
    if ($LASTEXITCODE -ne 0) { throw "Could not describe source-deployed revision $Revision." }
    $RevisionState = $RevisionStateJson | ConvertFrom-JsonPreservingStrings
    $RevisionCreatedAt = ([DateTimeOffset]::Parse([string]$RevisionState.metadata.creationTimestamp)).UtcDateTime.ToString('o')
    $RevisionContainers = @($RevisionState.spec.containers)
    if ($RevisionContainers.Count -ne 1) { throw "Revision $Revision must contain exactly one application container." }
    $RevisionImageDigest = [string]$RevisionState.status.imageDigest
    $ExpectedRevisionImagePrefix = "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy/"
    $RevisionImageBinding = Resolve-ExactArtifactImageResource -InputImage ([string]$RevisionContainers[0].image) -ResolvedDigest $RevisionImageDigest -ExpectedRepositoryPrefix $ExpectedRevisionImagePrefix
    $RevisionImagePackage = [string]$RevisionImageBinding.package
    $RevisionImageResource = [string]$RevisionImageBinding.resource

    $ServiceAnnotations = $ServiceState.metadata.PSObject.Properties['annotations'].Value
    $RevisionAnnotations = $RevisionState.metadata.PSObject.Properties['annotations'].Value
    if ($null -eq $ServiceAnnotations -or $null -eq $RevisionAnnotations) { throw "Cloud Run build annotations are missing for revision $Revision." }
    $ServiceBuildId = [string]$ServiceAnnotations.PSObject.Properties['run.googleapis.com/build-id'].Value
    $RevisionBuildId = [string]$RevisionAnnotations.PSObject.Properties['run.googleapis.com/build-id'].Value
    $ServiceBuildName = [string]$ServiceAnnotations.PSObject.Properties['run.googleapis.com/build-name'].Value
    $ServiceBuildSourceLocation = [string]$ServiceAnnotations.PSObject.Properties['run.googleapis.com/build-source-location'].Value
    $RevisionBuildSourceLocation = [string]$RevisionAnnotations.PSObject.Properties['run.googleapis.com/build-source-location'].Value
    $BuildNameMatch = [regex]::Match(
        $ServiceBuildName,
        "^(?://cloudbuild\.googleapis\.com/)?projects/(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))/locations/([^/]+)/builds/([^/]+)$"
    )
    if (
        [string]::IsNullOrWhiteSpace($ServiceBuildId) -or
        $ServiceBuildId -ne $RevisionBuildId -or
        -not $BuildNameMatch.Success -or
        $BuildNameMatch.Groups[2].Value -ne $ServiceBuildId -or
        [string]::IsNullOrWhiteSpace($ServiceBuildSourceLocation) -or
        $ServiceBuildSourceLocation -ne $RevisionBuildSourceLocation -or
        $ServiceBuildSourceLocation -match '[<>]'
    ) { throw "Cloud Run does not expose one authoritative source-build annotation binding for revision $Revision." }
    $SourceDeployBuildId = $ServiceBuildId
    $SourceDeployBuildLocation = $BuildNameMatch.Groups[1].Value
    if ($CloudBuildLocations -notcontains $SourceDeployBuildLocation) {
        throw "The authoritative source build for $Revision is outside the only authorized build locations."
    }
    $SourceDeployBuildResource = "projects/$ProjectNumber/locations/$SourceDeployBuildLocation/builds/$SourceDeployBuildId"
    $CanonicalServiceBuildSourceLocation = ConvertTo-CanonicalStorageSourceLocation -SourceLocation $ServiceBuildSourceLocation
    $SourceDeployBuildSourceLocationSha256 = Get-Sha256Hex -Value $CanonicalServiceBuildSourceLocation

    function Get-ProjectWideCloudBuildAssetInventory {
        param([Parameter(Mandatory = $true)][string]$SnapshotTime)
        $BuildAssetJson = @(& gcloud asset list --project=$ProjectId --asset-types="cloudbuild.googleapis.com/Build" --content-type=resource --snapshot-time=$SnapshotTime --limit=unlimited --format=json 2>&1)
        if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate the project-wide Cloud Build asset inventory.' }
        try { $BuildAssetRecords = @(($BuildAssetJson -join "`n") | ConvertFrom-JsonPreservingStrings) }
        catch { throw 'Could not parse the project-wide Cloud Build asset inventory.' }
        $SanitizedBuildAssets = @()
        $ProjectSegment = "(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))"
        foreach ($BuildAsset in @($BuildAssetRecords | Where-Object { $null -ne $_ })) {
            $BuildResource = [string]$BuildAsset.name
            $BuildResourceMatch = [regex]::Match(
                $BuildResource,
                "^//cloudbuild\.googleapis\.com/projects/$ProjectSegment/locations/([^/]+)/builds/([^/]+)$"
            )
            if (-not $BuildResourceMatch.Success) { throw 'A Cloud Build asset has an unexpected project or resource name.' }
            $BuildLocation = $BuildResourceMatch.Groups[1].Value
            if ($CloudBuildLocations -notcontains $BuildLocation) {
                throw "Cloud Build asset $BuildResource is outside the only authorized locations."
            }
            $SanitizedBuildAssets += [ordered]@{
                build_id = $BuildResourceMatch.Groups[2].Value
                location = $BuildLocation
                build_resource = "projects/$ProjectNumber/locations/$BuildLocation/builds/$($BuildResourceMatch.Groups[2].Value)"
            }
        }
        return @($SanitizedBuildAssets | Sort-Object build_resource)
    }

    $BuildAssetSnapshotBeforeUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $BuildAssetsBefore = @(Get-ProjectWideCloudBuildAssetInventory -SnapshotTime $BuildAssetSnapshotBeforeUtc)
    $BuildReceipts = @()
    foreach ($BuildLocation in $CloudBuildLocations) {
        $BuildIds = @(& gcloud builds list --project=$ProjectId --region=$BuildLocation --limit=unlimited --format="value(id)" 2>&1 | Sort-Object -Unique)
        if ($LASTEXITCODE -ne 0) { throw "Could not exhaustively enumerate Cloud Build location $BuildLocation." }
        foreach ($BuildId in $BuildIds) {
            if ([string]::IsNullOrWhiteSpace($BuildId)) { continue }
            $BuildStateJson = @(& gcloud builds describe $BuildId --project=$ProjectId --region=$BuildLocation --format=json 2>&1)
            if ($LASTEXITCODE -ne 0) { throw "Could not describe build $BuildId in $BuildLocation." }
            try { $BuildState = ($BuildStateJson -join "`n") | ConvertFrom-JsonPreservingStrings }
            catch { throw "Could not parse build $BuildId in $BuildLocation." }
            $BuildStateNameMatch = [regex]::Match(
                [string]$BuildState.name,
                "^projects/(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))/locations/$([regex]::Escape($BuildLocation))/builds/$([regex]::Escape([string]$BuildId))$"
            )
            if (
                [string]$BuildState.id -ne [string]$BuildId -or
                [string]$BuildState.projectId -ne $ProjectId -or
                -not $BuildStateNameMatch.Success
            ) { throw "Cloud Build describe returned an identity outside exact project $ProjectId, location $BuildLocation, or build $BuildId." }
            if ([string]::IsNullOrWhiteSpace($BuildState.createTime) -or [string]::IsNullOrWhiteSpace($BuildState.finishTime)) {
                throw "Build $BuildId in $BuildLocation is not terminal and cannot be frozen into the storage audit."
            }
            $BuildSourceProperty = $BuildState.PSObject.Properties['source']
            $StorageSourceProperty = if ($null -eq $BuildSourceProperty -or $null -eq $BuildSourceProperty.Value) { $null } else { $BuildSourceProperty.Value.PSObject.Properties['storageSource'] }
            if ($null -eq $StorageSourceProperty -or $null -eq $StorageSourceProperty.Value) { throw "Build $BuildId has no exact Cloud Storage source identity." }
            $StorageSource = $StorageSourceProperty.Value
            $StorageSourceBucket = [string]$StorageSource.PSObject.Properties['bucket'].Value
            $StorageSourceObject = [string]$StorageSource.PSObject.Properties['object'].Value
            $StorageSourceGenerationProperty = $StorageSource.PSObject.Properties['generation']
            $StorageSourceGeneration = if ($null -eq $StorageSourceGenerationProperty) { '' } else { [string]$StorageSourceGenerationProperty.Value }
            $BuildSourceLocation = "gs://$StorageSourceBucket/$StorageSourceObject"
            if (-not [string]::IsNullOrWhiteSpace($StorageSourceGeneration)) { $BuildSourceLocation += "#$StorageSourceGeneration" }
            $CanonicalBuildSourceLocation = ConvertTo-CanonicalStorageSourceLocation -SourceLocation $BuildSourceLocation
            $BuildImageDigests = @()
            $BuildImageResources = @()
            $BuildResultsProperty = $BuildState.PSObject.Properties['results']
            $BuildResultImages = @()
            if ($null -ne $BuildResultsProperty -and $null -ne $BuildResultsProperty.Value) {
                $BuildImagesProperty = $BuildResultsProperty.Value.PSObject.Properties['images']
                if ($null -ne $BuildImagesProperty -and $null -ne $BuildImagesProperty.Value) { $BuildResultImages = @($BuildImagesProperty.Value) }
            }
            foreach ($BuildImage in @($BuildResultImages | Where-Object { $null -ne $_ })) {
                $BuildDigest = [string]$BuildImage.digest
                if ($BuildDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw "Build $BuildId returned a malformed image digest." }
                $BuildImageBinding = Resolve-ExactArtifactImageResource -InputImage ([string]$BuildImage.name) -ResolvedDigest $BuildDigest -ExpectedRepositoryPrefix "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy/"
                $BuildImageDigests += $BuildDigest
                $BuildImageResources += [string]$BuildImageBinding.resource
            }
            $BuildImageDigests = @($BuildImageDigests | Sort-Object -Unique)
            $BuildImageResources = @($BuildImageResources | Sort-Object -Unique)
            $BuildReceipts += [ordered]@{
                build_id = [string]$BuildState.id
                location = $BuildLocation
                build_resource = "projects/$ProjectNumber/locations/$BuildLocation/builds/$([string]$BuildState.id)"
                status = [string]$BuildState.status
                created_at_utc = ([DateTimeOffset]::Parse([string]$BuildState.createTime)).UtcDateTime.ToString('o')
                finished_at_utc = ([DateTimeOffset]::Parse([string]$BuildState.finishTime)).UtcDateTime.ToString('o')
                source_location_sha256 = Get-Sha256Hex -Value $CanonicalBuildSourceLocation
                image_digests = $BuildImageDigests
                image_resources = $BuildImageResources
            }
        }
    }
    $BuildReceipts = @($BuildReceipts | Sort-Object build_resource)
    $BuildAssetSnapshotAfterUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $BuildAssetsAfter = @(Get-ProjectWideCloudBuildAssetInventory -SnapshotTime $BuildAssetSnapshotAfterUtc)
    $BuildReceiptIdentities = @(
        $BuildReceipts | ForEach-Object {
            [ordered]@{ build_id = $_.build_id; location = $_.location; build_resource = $_.build_resource }
        }
    )
    $ConfirmedBuildIdentities = @()
    foreach ($BuildLocation in $CloudBuildLocations) {
        $ConfirmedBuildIds = @(& gcloud builds list --project=$ProjectId --region=$BuildLocation --limit=unlimited --format="value(id)" 2>&1 | Sort-Object -Unique)
        if ($LASTEXITCODE -ne 0) { throw "Could not confirm the direct Cloud Build identity inventory in $BuildLocation." }
        foreach ($ConfirmedBuildId in $ConfirmedBuildIds) {
            if ([string]::IsNullOrWhiteSpace($ConfirmedBuildId)) { continue }
            $ConfirmedBuildIdentities += [ordered]@{
                build_id = [string]$ConfirmedBuildId
                location = $BuildLocation
                build_resource = "projects/$ProjectNumber/locations/$BuildLocation/builds/$([string]$ConfirmedBuildId)"
            }
        }
    }
    $ConfirmedBuildIdentities = @($ConfirmedBuildIdentities | Sort-Object build_resource)
    if ((Get-CanonicalJsonHash -InputObject $BuildReceiptIdentities) -ne (Get-CanonicalJsonHash -InputObject $ConfirmedBuildIdentities)) {
        throw 'The direct all-location Cloud Build identity inventory changed during the audit.'
    }
    $DirectBuildResources = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($BuildIdentity in $BuildReceiptIdentities) { [void]$DirectBuildResources.Add([string]$BuildIdentity.build_resource) }
    foreach ($BuildAsset in (@($BuildAssetsBefore) + @($BuildAssetsAfter))) {
        if (-not $DirectBuildResources.Contains([string]$BuildAsset.build_resource)) {
            throw 'Cloud Asset returned a Build that is absent from the direct all-location Cloud Build inventory.'
        }
    }
    $CompletedBuilds = @($BuildReceipts | Where-Object { $_.status -eq 'SUCCESS' })
    $AuthoritativeSourceBuild = @($CompletedBuilds | Where-Object { $_.build_resource -eq $SourceDeployBuildResource })
    if (
        $AuthoritativeSourceBuild.Count -ne 1 -or
        $AuthoritativeSourceBuild[0].source_location_sha256 -ne $SourceDeployBuildSourceLocationSha256 -or
        $AuthoritativeSourceBuild[0].image_resources -notcontains $RevisionImageResource -or
        [DateTimeOffset]::Parse([string]$AuthoritativeSourceBuild[0].finished_at_utc) -gt [DateTimeOffset]::Parse($RevisionCreatedAt)
    ) { throw "The exact Cloud Run annotated source build did not uniquely produce $RevisionImageResource before revision $Revision was created." }
    if ($Phase -eq 'after_simulator_source_deploy') {
        if (-not (Test-Path -LiteralPath $AppStorageReceiptPath -PathType Leaf)) {
            throw 'The exact app-phase storage receipt is required before writing the simulator phase.'
        }
        $PriorAppReceipt = Get-Content -Raw -LiteralPath $AppStorageReceiptPath | ConvertFrom-JsonPreservingStrings
        $PriorAppBuildRecord = @($PriorAppReceipt.builds | Where-Object { $_.build_resource -eq $PriorAppReceipt.source_deploy_build_resource })
        $CarriedAppBuildRecord = @($BuildReceipts | Where-Object { $_.build_resource -eq $PriorAppReceipt.source_deploy_build_resource })
        if (
            $PriorAppReceipt.phase -ne 'after_app_source_deploy' -or
            $PriorAppBuildRecord.Count -ne 1 -or
            $CarriedAppBuildRecord.Count -ne 1 -or
            (Get-CanonicalJsonHash -InputObject $PriorAppBuildRecord[0]) -ne (Get-CanonicalJsonHash -InputObject $CarriedAppBuildRecord[0])
        ) { throw 'The simulator-phase inventory does not carry forward the exact app source-build record.' }
    }

    $RepositoryInventoryJson = @(& gcloud artifacts repositories list --project=$ProjectId --location=all --format=json 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate every Artifact Registry repository.' }
    try { $RepositoryInventory = @(($RepositoryInventoryJson -join "`n") | ConvertFrom-JsonPreservingStrings) }
    catch { throw 'Could not parse the Artifact Registry repository inventory.' }
    $ArtifactRepositories = @()
    $ArtifactImages = @()
    foreach ($Repository in $RepositoryInventory) {
        if ([string]$Repository.format -ne 'DOCKER') {
            throw "Non-Docker Artifact Registry repository $($Repository.name) is outside the bounded release inventory; remove or separately account it."
        }
        $RepositoryResourceMatch = [regex]::Match(
            [string]$Repository.name,
            "^projects/(?:$([regex]::Escape($ProjectId))|$([regex]::Escape($ProjectNumber)))/locations/([^/]+)/repositories/([^/]+)$"
        )
        if (-not $RepositoryResourceMatch.Success) { throw 'Artifact Registry returned a repository outside the exact dedicated project or with an invalid resource name.' }
        $RepositoryLocation = $RepositoryResourceMatch.Groups[1].Value
        $RepositoryId = $RepositoryResourceMatch.Groups[2].Value
        $RepositoryUri = "$RepositoryLocation-docker.pkg.dev/$ProjectId/$RepositoryId"
        $RepositoryImagesJson = @(& gcloud artifacts docker images list $RepositoryUri --include-tags --format="json(package,version,metadata.imageSizeBytes,updateTime,tags)" 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Could not enumerate every image in $RepositoryUri." }
        try { $RepositoryImages = @(($RepositoryImagesJson -join "`n") | ConvertFrom-JsonPreservingStrings) }
        catch { throw "Could not parse the image inventory for $RepositoryUri." }
        $RepositoryArtifactCount = 0
        $RepositoryArtifactBytes = [int64]0
        foreach ($Image in $RepositoryImages) {
            $ImageDigestMatch = [regex]::Match([string]$Image.version, 'sha256:[a-f0-9]{64}$')
            if (-not $ImageDigestMatch.Success) { throw 'An Artifact Registry image is missing its exact digest.' }
            $ImageDigest = $ImageDigestMatch.Value
            $ImageBytes = [int64]0
            $RawImageBytes = [string]$Image.metadata.imageSizeBytes
            if ([string]::IsNullOrWhiteSpace($RawImageBytes)) { $RawImageBytes = [string]$Image.imageSizeBytes }
            if (-not [int64]::TryParse($RawImageBytes, [ref]$ImageBytes) -or $ImageBytes -le 0) {
                throw 'An Artifact Registry image is missing a positive byte size.'
            }
            $Package = [string]$Image.package
            if (-not $Package.StartsWith("$RepositoryUri/", [System.StringComparison]::Ordinal)) {
                throw "Artifact package $Package is outside $RepositoryUri."
            }
            $ArtifactImages += [ordered]@{
                repository_uri = $RepositoryUri
                package = $Package
                digest = $ImageDigest
                size_bytes = $ImageBytes
            }
            $RepositoryArtifactCount += 1
            $RepositoryArtifactBytes += $ImageBytes
        }
        $ArtifactRepositories += [ordered]@{
            repository = $RepositoryId
            location = $RepositoryLocation
            format = 'DOCKER'
            repository_uri = $RepositoryUri
            artifact_count = $RepositoryArtifactCount
            artifact_size_bytes = $RepositoryArtifactBytes
        }
    }
    $ArtifactRepositories = @($ArtifactRepositories | Sort-Object repository_uri)
    $ArtifactImages = @($ArtifactImages | Sort-Object @{ Expression = { "$($_.package)@$($_.digest)" } })
    $ImageSizeBytes = [int64](($ArtifactImages | Measure-Object -Property size_bytes -Sum).Sum)
    $ServicesToBind = if ($Phase -eq 'after_app_source_deploy') { @($AppService) } else { @($AppService, $SimulatorService) }
    $RevisionImages = @()
    foreach ($BoundService in $ServicesToBind) {
        $BoundServiceState = gcloud run services describe $BoundService --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
        if ($LASTEXITCODE -ne 0) { throw "Could not bind latest-ready revision for $BoundService." }
        $BoundRevision = [string]$BoundServiceState.status.latestReadyRevisionName
        $BoundRevisionState = gcloud run revisions describe $BoundRevision --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
        if ($LASTEXITCODE -ne 0) { throw "Could not bind image digest for $BoundRevision." }
        $BoundContainers = @($BoundRevisionState.spec.containers)
        $BoundImageDigest = [string]$BoundRevisionState.status.imageDigest
        if ($BoundContainers.Count -ne 1 -or $BoundImageDigest -notmatch '^sha256:[a-f0-9]{64}$') {
            throw "Protected revision $BoundRevision has no unique container and exact image digest."
        }
        $BoundImageBinding = Resolve-ExactArtifactImageResource -InputImage ([string]$BoundContainers[0].image) -ResolvedDigest $BoundImageDigest -ExpectedRepositoryPrefix "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy/"
        $RevisionImages += [ordered]@{
            service = $BoundService
            revision = $BoundRevision
            image_digest = $BoundImageDigest
            image_package = [string]$BoundImageBinding.package
            image_resource = [string]$BoundImageBinding.resource
        }
    }
    $ArtifactImageResources = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($ArtifactImage in $ArtifactImages) { [void]$ArtifactImageResources.Add("$([string]$ArtifactImage.package)@$([string]$ArtifactImage.digest)") }
    foreach ($RevisionImage in $RevisionImages) {
        if (-not $ArtifactImageResources.Contains([string]$RevisionImage.image_resource)) {
            throw "Revision $($RevisionImage.revision) is absent from the exact Artifact Registry package-and-digest inventory."
        }
    }
    if (-not $ArtifactImageResources.Contains($RevisionImageResource)) {
        throw "Source-deployed revision $Revision is absent from the exact Artifact Registry package-and-digest inventory."
    }
    $RequiredDeployCount = if ($Phase -eq 'after_app_source_deploy') { 1 } else { 2 }
    if ($CompletedBuilds.Count -lt $RequiredDeployCount -or $ArtifactImages.Count -lt $RequiredDeployCount) {
        throw "The $Phase inventory does not cover every source deploy through this phase."
    }
    $ObservedBytes = [int64]$Storage.observed_bytes + $ImageSizeBytes
    if ($ObservedBytes -ge 5GB) { throw "Aggregate bucket and image storage is not under five GiB: $ObservedBytes bytes." }
    $Receipt = [ordered]@{
        schema_version = '1'
        kind = 'found-roll-google-cloud-project-storage-audit'
        status = 'PASS'
        phase = $Phase
        observed_at_utc = [DateTime]::UtcNow.ToString('o')
        project_id = $ProjectId
        project_number = $ProjectNumber
        service = $Service
        revision = $Revision
        revision_created_at_utc = $RevisionCreatedAt
        revision_image_digest = $RevisionImageDigest
        revision_image_resource = $RevisionImageResource
        source_deploy_build_id = $SourceDeployBuildId
        source_deploy_build_location = $SourceDeployBuildLocation
        source_deploy_build_resource = $SourceDeployBuildResource
        source_deploy_build_binding_source = 'cloud-run-build-annotations'
        source_deploy_build_source_location_sha256 = $SourceDeployBuildSourceLocationSha256
        maximum_bytes_exclusive = [int64]5GB
        observed_bytes = $ObservedBytes
        active_bucket_inventory_sha256 = [string]$Storage.active_bucket_inventory_sha256
        soft_deleted_bucket_inventory_sha256 = [string]$Storage.soft_deleted_bucket_inventory_sha256
        soft_deleted_bucket_count = 0
        cloud_build_inventory_sha256 = Get-CanonicalJsonHash -InputObject $BuildReceipts
        cloud_build_locations = @($CloudBuildLocations)
        cloud_build_locations_source = 'cloud-build-v2-paginated-project-locations+global'
        direct_build_identity_inventory_sha256 = Get-CanonicalJsonHash -InputObject $ConfirmedBuildIdentities
        direct_build_identity_count = $ConfirmedBuildIdentities.Count
        direct_build_inventory_stable = $true
        cloud_build_asset_snapshot_before_sha256 = Get-CanonicalJsonHash -InputObject $BuildAssetsBefore
        cloud_build_asset_snapshot_before_count = $BuildAssetsBefore.Count
        cloud_build_asset_inventory_sha256 = Get-CanonicalJsonHash -InputObject $BuildAssetsAfter
        cloud_build_asset_count = $BuildAssetsAfter.Count
        cloud_build_asset_inventory_exhaustive = $false
        cloud_build_asset_snapshot_before_utc = $BuildAssetSnapshotBeforeUtc
        cloud_build_asset_snapshot_after_utc = $BuildAssetSnapshotAfterUtc
        cloud_build_asset_inventory_stable = (Get-CanonicalJsonHash -InputObject $BuildAssetsBefore) -eq (Get-CanonicalJsonHash -InputObject $BuildAssetsAfter)
        completed_build_count = $CompletedBuilds.Count
        build_inventory_exhaustive = $true
        artifact_repository_inventory_sha256 = Get-CanonicalJsonHash -InputObject $ArtifactRepositories
        repository_count = $ArtifactRepositories.Count
        repository_inventory_exhaustive = $true
        artifact_image_inventory_sha256 = Get-CanonicalJsonHash -InputObject $ArtifactImages
        image_digest_count = $ArtifactImages.Count
        image_size_bytes = $ImageSizeBytes
        artifact_inventory_exhaustive = $true
        soft_deleted_bucket_inventory_exhaustive = $true
        soft_deleted_object_inventory_exhaustive = $true
        image_digests_and_sizes_included = $true
        buckets = @($Storage.buckets)
        soft_deleted_buckets = @($Storage.soft_deleted_buckets)
        builds = $BuildReceipts
        cloud_build_assets_before = $BuildAssetsBefore
        cloud_build_assets = $BuildAssetsAfter
        artifact_repositories = $ArtifactRepositories
        artifact_images = $ArtifactImages
        revision_images = $RevisionImages
    }
    $ReceiptJson = $Receipt | ConvertTo-Json -Depth 12
    [System.IO.File]::WriteAllText($ReceiptPath, $ReceiptJson, [System.Text.UTF8Encoding]::new($false))
    $ReceiptDigest = Get-Sha256Hex -Value $ReceiptJson
    $BindingKey = if ($Phase -eq 'after_app_source_deploy') { 'after_app_source_deploy' } else { 'after_simulator_source_deploy' }
    $ExpectedRelativePath = if ($Phase -eq 'after_app_source_deploy') {
        'artifacts/private/storage-after-app-source-deploy.json'
    } else {
        'artifacts/private/storage-after-simulator-source-deploy.json'
    }
    if ([System.IO.Path]::GetFullPath($ReceiptPath) -ne [System.IO.Path]::GetFullPath((Join-Path $PWD $ExpectedRelativePath))) {
        throw 'The storage receipt path does not match the frozen release-record contract.'
    }
    $ReleaseRecord = Get-Content -Raw -LiteralPath $ReleaseRecordPath | ConvertFrom-JsonPreservingStrings
    $Binding = $ReleaseRecord.google_cloud.project_storage_receipts.PSObject.Properties[$BindingKey].Value
    if ([string]$Binding.path -ne $ExpectedRelativePath) { throw 'The storage receipt binding path is not exact.' }
    $Binding.sha256 = $ReceiptDigest
    $UpdatedReleaseJson = $ReleaseRecord | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($ReleaseRecordPath, $UpdatedReleaseJson, [System.Text.UTF8Encoding]::new($false))
    return [ordered]@{ path = $ExpectedRelativePath; sha256 = $ReceiptDigest; revision = $Revision }
}
foreach ($BuildLocation in $CloudBuildLocations) {
    gcloud builds list --project=$ProjectId --region=$BuildLocation --limit=unlimited --sort-by=~createTime
    if ($LASTEXITCODE -ne 0) { throw "Could not exhaustively verify Cloud Build location $BuildLocation." }
}
$ProjectStorageReceipt = Assert-ProjectStorageBound -ExpectedProjectId $ProjectId -MaximumBytes 5GB
$ProjectStorageReceipt | ConvertTo-Json -Depth 8
gcloud artifacts repositories list --project=$ProjectId --location=$Region
```

After the first source deploy creates the standard repository, inventory every image digest and tag:

```powershell
$SourceRepository = "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy"
gcloud artifacts docker images list $SourceRepository --include-tags --sort-by=~UPDATE_TIME
```

The project-wide audit clears soft delete before any temporary object is removed, rejects versioning and positive retention on every evidence/source/build bucket, requires the exact frozen evidence bucket, and inventories ordinary versions and soft-deleted generations separately. It preserves deterministic identifier-only arrays for every terminal build, every Artifact Registry repository, every package digest and byte size, and every source-deployed revision-to-image tuple; counts, sums, and canonical hashes are recomputed offline. A non-Docker repository is rejected rather than silently omitted. `Write-ProjectStorageAuditReceipt` runs immediately after each successful source deploy, writes the matching ignored receipt, updates that receipt's SHA-256 in the private release record, and enforces one aggregate under-5-GiB ceiling across buckets and images. Stop if any bucket, build, repository, image digest, image size, source build, or revision binding cannot be exhaustively described. Do not assume a service spend cap covers build or storage artifacts.

After both services are verified, protect every revision receiving traffic, each latest-ready revision, and every explicitly retained last-good rollback revision. Never infer safety from only the latest revision. Resolve the package from the revision's sole container spec, require Cloud Run's separate `status.imageDigest`, and combine them only after any embedded spec digest agrees. For every older or untagged digest, prove it is absent from the complete protected-image set before deleting that exact digest rather than a repository or wildcard:

```powershell
$RetainedRollbackRevisions = @(Resolve-RetainedRollbackRevisions)
$ProtectedRevisions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Service in @($AppService, $SimulatorService)) {
    $ServiceState = gcloud run services describe $Service --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
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

$RepositoryPrefix = "$SourceRepository/"
$ProtectedImages = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($Revision in $ProtectedRevisions) {
    $ProtectedRevisionJson = gcloud run revisions describe $Revision --project=$ProjectId --region=$Region --format=json
    if ($LASTEXITCODE -ne 0) { throw "Could not describe protected revision $Revision." }
    $ProtectedRevisionState = $ProtectedRevisionJson | ConvertFrom-JsonPreservingStrings
    $ProtectedContainers = @($ProtectedRevisionState.spec.containers)
    if ($ProtectedContainers.Count -ne 1) { throw "Protected revision $Revision does not contain exactly one container." }
    $ProtectedImageBinding = Resolve-ExactArtifactImageResource `
        -InputImage ([string]$ProtectedContainers[0].image) `
        -ResolvedDigest ([string]$ProtectedRevisionState.status.imageDigest) `
        -ExpectedRepositoryPrefix $RepositoryPrefix
    [void]$ProtectedImages.Add([string]$ProtectedImageBinding.resource)
}

$CandidateImage = "<exact-non-serving-image>@sha256:<digest>"
if (
    $CandidateImage -match '[<>]' -or
    -not $CandidateImage.StartsWith($RepositoryPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    $CandidateImage -notmatch '@sha256:[a-f0-9]{64}$'
) { throw 'Set one exact digest-qualified cleanup candidate under this project source repository.' }
if ($ProtectedImages.Contains($CandidateImage)) { throw "Refusing to delete protected image $CandidateImage." }
Assert-DedicatedProjectIdentity
gcloud artifacts docker images delete $CandidateImage --project=$ProjectId --delete-tags
Assert-LastGcloudSuccess -Operation 'non-serving Artifact Registry image deletion'
```

Do not issue individual Cloud Storage deletion commands from this runbook. Preserve the exhaustive location-bound build and object inventories, remain below the five-GiB project ceiling, and rely on exact dedicated-project teardown after judging to remove staging objects. Never delete a protected serving or rollback digest, and never use wildcard cleanup.

Deploy the app revision before changing the simulator. On this transitional revision only, set `FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT=true`. That flag accepts a missing legacy field but still rejects an explicit `environment=development`. The exact HTTPS app and simulator origins are supplied on the first production deploy, not discovered by a follow-up update:

```powershell
Assert-GoogleCloudPreflight -PhaseName "app-source-deploy"
gcloud run deploy $AppService `
    --project=$ProjectId `
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
Assert-LastGcloudSuccess -Operation 'app source deployment'
$AppStorageBinding = Write-ProjectStorageAuditReceipt -Phase after_app_source_deploy -Service $AppService -ReceiptPath $AppStorageReceiptPath
$AppStorageBinding | ConvertTo-Json -Compress
gcloud run services describe $AppService --project=$ProjectId --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.containers[0].env)"
```

Confirm the described service URL or mapped origin is the configured `$AppUrl`, and that the compatible app revision is ready before continuing. A temporary 503 inventory-readiness result against an absent bootstrap simulator is acceptable only during a new-project rollout; the app process itself must start, and no canonical case may begin yet.

### Deploy the production simulator after the compatible app

Only after the compatible app revision is serving, deploy the simulator with production fail-closed validation:

```powershell
Assert-GoogleCloudPreflight -PhaseName "simulator-source-deploy"
gcloud run deploy $SimulatorService `
    --project=$ProjectId `
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
Assert-LastGcloudSuccess -Operation 'simulator source deployment'
$SimulatorStorageBinding = Write-ProjectStorageAuditReceipt -Phase after_simulator_source_deploy -Service $SimulatorService -ReceiptPath $SimulatorStorageReceiptPath
$SimulatorStorageBinding | ConvertTo-Json -Compress
gcloud run services describe $SimulatorService --project=$ProjectId --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.containers[0].env)"
Invoke-RestMethod "$SimulatorUrl/healthz"
Invoke-RestMethod "$AppUrl/healthz"
Assert-GoogleCloudPreflight -PhaseName "final-app-service-update"
gcloud run services update $AppService --project=$ProjectId --region=$Region --scaling=auto --min=0 --max=1 --min-instances=0 --max-instances=1 --timeout=120s --update-env-vars="FOUND_ROLL_INVENTORY_ALLOW_LEGACY_HEALTH_WITHOUT_ENVIRONMENT=false"
Assert-LastGcloudSuccess -Operation 'final app service update'
gcloud run services describe $AppService --project=$ProjectId --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.containers[0].env)"
Invoke-RestMethod "$AppUrl/healthz"
function Get-CanonicalRevisionImageBinding {
    param(
        [Parameter(Mandatory = $true)][string]$Service,
        [Parameter(Mandatory = $true)][string]$ExpectedOrigin
    )
    $CanonicalServiceState = gcloud run services describe $Service --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
    if ($LASTEXITCODE -ne 0) { throw "Could not describe canonical service $Service." }
    $CanonicalOrigin = ([string]$CanonicalServiceState.status.url).TrimEnd('/')
    if ($CanonicalOrigin -ne $ExpectedOrigin.TrimEnd('/')) { throw "Canonical origin for $Service does not equal the configured exact origin." }
    $CanonicalRevision = [string]$CanonicalServiceState.status.latestReadyRevisionName
    if ($CanonicalRevision -notmatch "^$([regex]::Escape($Service))-\d{5}-[a-z0-9]{3}$") { throw "Canonical revision for $Service is invalid." }
    $CanonicalRevisionState = gcloud run revisions describe $CanonicalRevision --project=$ProjectId --region=$Region --format=json | ConvertFrom-JsonPreservingStrings
    if ($LASTEXITCODE -ne 0) { throw "Could not describe canonical revision $CanonicalRevision." }
    $CanonicalContainers = @($CanonicalRevisionState.spec.containers)
    $CanonicalImageDigest = [string]$CanonicalRevisionState.status.imageDigest
    if ($CanonicalContainers.Count -ne 1 -or $CanonicalImageDigest -notmatch '^sha256:[a-f0-9]{64}$') {
        throw "Canonical revision $CanonicalRevision has no unique container and exact image digest."
    }
    $CanonicalImageBinding = Resolve-ExactArtifactImageResource -InputImage ([string]$CanonicalContainers[0].image) -ResolvedDigest $CanonicalImageDigest -ExpectedRepositoryPrefix "$Region-docker.pkg.dev/$ProjectId/cloud-run-source-deploy/"
    $ServiceResource = "projects/$ProjectNumber/locations/$Region/services/$Service"
    return [ordered]@{
        project_id = $ProjectId
        project_number = $ProjectNumber
        region = $Region
        service = $Service
        service_resource = $ServiceResource
        origin = $CanonicalOrigin
        revision = $CanonicalRevision
        revision_resource = "$ServiceResource/revisions/$CanonicalRevision"
        revision_created_at_utc = ([DateTimeOffset]::Parse([string]$CanonicalRevisionState.metadata.creationTimestamp)).UtcDateTime.ToString('o')
        image_digest = $CanonicalImageDigest
        image_package = [string]$CanonicalImageBinding.package
        image_resource = [string]$CanonicalImageBinding.resource
    }
}
$CanonicalAppBinding = Get-CanonicalRevisionImageBinding -Service $AppService -ExpectedOrigin $AppUrl
$CanonicalSimulatorBinding = Get-CanonicalRevisionImageBinding -Service $SimulatorService -ExpectedOrigin $SimulatorUrl
if ($CanonicalAppBinding.image_digest -eq $CanonicalSimulatorBinding.image_digest) { throw 'Canonical app and simulator images must be distinct.' }
$ReleaseRecord = Get-Content -Raw -LiteralPath $ReleaseRecordPath | ConvertFrom-JsonPreservingStrings
$ReleaseRecord.google_cloud.canonical_revision_images.app = $CanonicalAppBinding
$ReleaseRecord.google_cloud.canonical_revision_images.simulator = $CanonicalSimulatorBinding
$UpdatedReleaseJson = $ReleaseRecord | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($ReleaseRecordPath, $UpdatedReleaseJson, [System.Text.UTF8Encoding]::new($false))
```

The observed simulator Cloud Run `status.url` must equal the already configured `$SimulatorUrl`. Its health payload must report `data.environment=production`; the app health probe must accept that exact envelope and return ready both before and after the compatibility flag is removed. The frozen release receipt must show the flag as `false`. `--allow-unauthenticated` makes the fictional simulator read API and health route reachable for the demo; every mutation still fails closed on its bearer API key. `SIMULATOR_ENV=production` also makes startup fail if the API, token, or callback secret is missing, shorter than 24 characters, a placeholder, or reused across purposes. `--scaling=auto` prevents inherited manual scaling. Both service-level `--max=1` and revision-level `--max-instances=1` are mandatory because this resettable simulator keeps process-local fixture state; `--min=0` and `--min-instances=0` prevent idle instances, and `--timeout=20s` bounds each simulator request. Concurrency eight limits simultaneous requests within the one allowed instance; it is not an instance cap. This is acceptable only for one synthetic demonstration and is not a persistence or scalability design. A real custodian integration must be private, durable, and use workload identity/OIDC rather than a long-lived bearer key.

The public origin does not make rich custody data public. In production, passport snapshots, events, candidates, manifests, and the demo snapshot require `X-Found-Roll-Staff-Token`. General demo mutations use `X-Found-Roll-Demo-Token`; staff evidence, identity attestation, and release also use the staff credential; intake, claimant-link issuance, and duplicate release-task delivery require both; approval uses `X-Found-Roll-Supervisor-Token`; and claimant evidence uses the one-time `X-Found-Roll-Claim-Link` against a purpose-built coarse projection. Before loading any rich projection, the browser calls `GET /api/v1/auth/runtime-roles` with all three reusable headers; the endpoint validates them strictly even in development, mutates nothing, and returns the configured actor IDs with no-store headers. The server records those exact actors and rejects a conflicting optional legacy actor field. Empty, partial, or rejected browser configuration clears the whole in-memory private session. Reset and outbox reconciliation use `X-Found-Roll-Admin-Token` from authenticated terminal/Cloud Shell tooling only. Keep the deployment in the dedicated `_synthetic_demo` namespace, use narrow CORS, cap instances, and disclose that these demo credentials are not production identity.

If the frontend is hosted separately, run the production build and freeze `artifacts/verification/frontend-build-manifest.json`, which deterministically binds every regular file below `dist/client` by path, byte length, and SHA-256. Record that manifest digest in every canonical run and the clean-browser receipt. The deployed frontend must call the exact submitted `$AppUrl`. The bundle contains an explicitly labeled, read-only offline fixture for failure presentation; it cannot verify private evidence or mutate custody and is not canonical proof. The judge-visible recording must remain connected to the submitted service and show its live health/status rather than relying on that fallback.

### Prepare a fresh model-evidence run

From an authenticated local terminal or Cloud Shell, load the five operator-only values into the current process environment without echoing them, then use the checked preparation script. The script uses the admin, staff, demo, and relay values to reset both isolated synthetic services, verify live-mode health with inventory legacy compatibility `false`, read the new workflow epoch, upload the frozen pouch source with an epoch-scoped idempotency key, and verify exactly one complete current-epoch original/preview pair is active. It checks the original checksum and GCS generation and confirms that the derivative is explicitly `MODEL_AUTHORIZED`, then emits an identifier-only receipt before analysis begins. The supervisor value is retained only for the later approval step. There is no browser reset action; **Refresh case** only reloads state.

```powershell
Assert-GoogleCloudPreflight -PhaseName "canonical-gemini-run-1"
$env:FOUND_ROLL_DEMO_ACCESS_TOKEN = gcloud secrets versions access $($SecretVersions['found-roll-demo-access-token']) --secret=found-roll-demo-access-token --project=$ProjectId
$env:FOUND_ROLL_ADMIN_TOKEN = gcloud secrets versions access $($SecretVersions['found-roll-admin-token']) --secret=found-roll-admin-token --project=$ProjectId
$env:FOUND_ROLL_EVIDENCE_STAFF_TOKEN = gcloud secrets versions access $($SecretVersions['found-roll-evidence-staff-token']) --secret=found-roll-evidence-staff-token --project=$ProjectId
$env:FOUND_ROLL_SUPERVISOR_TOKEN = gcloud secrets versions access $($SecretVersions['found-roll-supervisor-token']) --secret=found-roll-supervisor-token --project=$ProjectId
$env:FOUND_ROLL_RELAY_API_KEY = gcloud secrets versions access $($SecretVersions['found-roll-simulator-api-key']) --secret=found-roll-simulator-api-key --project=$ProjectId
./scripts/prepare-canonical-run.ps1 -AppUrl $AppUrl -SimulatorUrl $SimulatorUrl -ReceiptPath artifacts/private/canonical-preparation-1.json
```

Repeat the preparation and reset-to-close workflow with receipt suffixes `2` through `5`. Run `Assert-GoogleCloudPreflight -PhaseName "canonical-gemini-run-N"` immediately before each live Gemini run; the guard refreshes the CLI billing-link/open-account evidence and all three schema-v2 receipt hashes automatically. Never reuse a preparation receipt across runs: each reset must produce a distinct workflow epoch, evidence pair, and run receipt.

For each execution, copy `docs/canonical-run.template.json` and `docs/chain-audit.template.json` into ignored `artifacts/private/`. Fill the run receipt only with sanitized identifiers, digests, counts, modes, and booleans. Fill the chain audit from the authenticated event-list and manifest responses for that exact case, run, workflow epoch, commit, and tree. Change the run status to `CANONICAL_PASS` and the chain-audit status to `PASS` only when every field is proven. The offline verifier recomputes every event hash, previous-hash link, evidence digest, manifest ID, and manifest digest rather than trusting those labels. After all five runs, create the shared private privacy and clean-browser receipts from `docs/canonical-privacy.template.json` and `docs/clean-browser.template.json`. Set `verified_at_utc` only from the completed clean-browser observation: it must follow the end of all five canonical runs, precede the release freeze, and remain within 24 hours of both the freeze and the verifier's wall clock. Never paste raw logs, prompts, responses, request bodies, media, tokens, signed URLs, or private object names into the sanitized run, privacy, or browser receipts; the private chain audit contains only the service event and manifest schema.

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
gcloud run services describe $AppService --project=$ProjectId --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.serviceAccountName,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources)"
gcloud run services describe $SimulatorService --project=$ProjectId --region=$Region --format="yaml(status.url,status.latestReadyRevisionName,metadata.annotations,spec.template.metadata.annotations,spec.template.spec.timeoutSeconds,spec.template.spec.serviceAccountName,spec.template.spec.containerConcurrency,spec.template.spec.containers[0].resources)"
```

For each service, the service metadata must show `run.googleapis.com/scalingMode: automatic` and `run.googleapis.com/maxScale: '1'`; `run.googleapis.com/minScale` must be absent or `0`, which is the service default produced by `--min=0`. The revision-template annotations must show `autoscaling.knative.dev/minScale: '0'`, `autoscaling.knative.dev/maxScale: '1'`, `run.googleapis.com/cpu-throttling: 'true'`, and `run.googleapis.com/startup-cpu-boost: 'false'`. The app revision must show `timeoutSeconds: 120`; the simulator must show `timeoutSeconds: 20`. Also confirm one CPU, 512 MiB, and concurrency eight. Save these complete redacted descriptions with the release evidence. Concurrency is only the within-instance request limit; service-level `maxScale` is the true service instance cap. A service cap can briefly be exceeded while Cloud Run handles traffic spikes, which is why the separate Cloud Run spend cap and the unupgraded Free Trial remain mandatory.

The app health response must report `environment=production`, `demo_mode=true`, `vertex_adk`, `gemini-3.5-flash`, `prompt_version=found-roll-case-analyst-prompt-v1`, `output_schema_version=found-roll-analysis-proposal-v1`, `policy_version=found-roll-release-v1`, `firestore`, `cloud`, `inventory_mode=http`, `inventory_gateway_ready=true`, `inventory_legacy_health_compatibility=false`, `relay_mode=http`, and every production auth/task guard enabled. Inventory readiness is a bounded live probe that validates the simulator's exact `SIMULATED` header and health envelope; a configured URL alone is not ready. The simulator health response must permanently disclose `SIMULATED` and must not echo any secret.

Resource state:

```powershell
gcloud tasks queues describe $Queue --location=$Region --format="yaml(state,rateLimits,retryConfig)"
gcloud firestore databases describe --database="(default)"
gcloud storage buckets describe "gs://$Bucket" --format="yaml(name,location,iamConfiguration,lifecycle,versioning,softDeletePolicy)"
gcloud storage du --summarize --all-versions "gs://$Bucket"
foreach ($BuildLocation in $CloudBuildLocations) {
    gcloud builds list --project=$ProjectId --region=$BuildLocation --limit=unlimited --sort-by=~createTime
    if ($LASTEXITCODE -ne 0) { throw "Could not exhaustively verify Cloud Build location $BuildLocation." }
}
$ProjectStorageReceipt = Assert-ProjectStorageBound -ExpectedProjectId $ProjectId -MaximumBytes 5GB
$ProjectStorageReceipt | ConvertTo-Json -Depth 8
gcloud artifacts repositories list --project=$ProjectId --location=$Region
gcloud artifacts docker images list $SourceRepository --include-tags --sort-by=~UPDATE_TIME
```

If verification runs in a new PowerShell process, load the exact `Assert-ProjectStorageBound` definition from the inventory section first. The queue receipt must show one concurrent dispatch, one dispatch per second, three maximum attempts, a positive one-second maximum retry duration, 10-second minimum backoff, 60-second maximum backoff, and two doublings. The project-wide storage receipt must enumerate every bucket, report zero positive soft-delete duration, versioning, and retention, include ordinary plus soft-deleted bytes, and remain under 5 GiB in aggregate. The evidence-bucket receipt must also show the after-judging deletion lifecycle. The build/artifact inventory must retain only the protected serving/rollback images plus any exact staging object still needed for a protected completed build.

Keep the generated schema-v2 Billing Overview, Cloud Run spend-cap, and Gemini/Agent Platform spend-cap JSON receipts alongside the private release evidence. The offline verifier intentionally does not query Google Cloud: it fails closed unless the receipts bind the direct entrant confirmation of exact `free_trial` account type, remaining credit, remaining time, no paid activation, the no-upgrade/no-payment commitment, the EUR 10 Cloud Run cap, and the EUR 5 Agent Platform cap. The operational refresh separately verifies the live project billing link, linked-account hash, and open-account state through the CLI.

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
gcloud run services describe $AppService --project=$ProjectId --region=$Region --format="value(status.traffic.revisionName)"
gcloud run services describe $SimulatorService --project=$ProjectId --region=$Region --format="value(status.traffic.revisionName)"
```

If a new revision fails health, security negatives, contract tests, or a canonical reset, send all traffic back to the last verified revision:

```powershell
gcloud run services update-traffic $AppService --project=$ProjectId --region=$Region --to-revisions="<last-good-app-revision>=100"
Assert-LastGcloudSuccess -Operation 'app traffic rollback'
gcloud run services update-traffic $SimulatorService --project=$ProjectId --region=$Region --to-revisions="<last-good-simulator-revision>=100"
Assert-LastGcloudSuccess -Operation 'simulator traffic rollback'
```

For a privacy leak, token/callback validation defect, or unknown duplicate side effect, stop work rather than continuing the demo:

```powershell
gcloud tasks queues pause $Queue --project=$ProjectId --location=$Region
Assert-LastGcloudSuccess -Operation 'incident queue pause'
gcloud run services update-traffic $AppService --project=$ProjectId --region=$Region --to-revisions="<last-good-app-revision>=100"
Assert-LastGcloudSuccess -Operation 'incident app traffic rollback'
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
$ReadinessVerifierLines = @(& node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json 2>&1)
$ReadinessVerifierExitCode = $LASTEXITCODE
$ReadinessVerifierOutput = $ReadinessVerifierLines -join "`n"
if ($ReadinessVerifierExitCode -ne 0 -or $ReadinessVerifierOutput -notmatch '(?m)^SUBMISSION READINESS: PASS$') {
    throw 'The frozen submission release did not pass the offline verifier.'
}
$ReadinessVerifierOutput
```

The command is deliberately offline. It verifies local Git, source and artifact hashes, receipt structure, cross-run identity, placeholder removal, exact `billing_account_type: "free_trial"`, a single hash-bound schema-v2 entrant-attestation batch, the exact EUR 10 and EUR 5 service caps, and the required confirmations for remaining trial credit/time, absence of paid activation, no paid upgrade/payment during release, and no cap changes. It validates project/service/status/timestamp metadata and requires the direct attestation to remain within 24 hours of the release timestamp and current wall clock. The operational `--preflight-only` gate additionally requires the live CLI billing check and regenerated release record to be no more than ten minutes old. It does not semantically prove the attested console facts or query the Preview spend-cap state, because that enforcement state is not exposed by the public CLI/API. Public reachability, judge access, the continuous video, eligibility, ownership, truthfulness, and visual/media privacy remain explicit attestations that must be checked by the entrant.

No service-account private key is needed at any stage of this runbook.

Deployment and publication remain blocked until the active unupgraded Free Trial account and both service spend caps are verified, the frozen run set supplies live Gemini and Google ADK receipts plus Google Cloud resource/revision evidence, the repository/tag has verified judge access, and the public sub-four-minute video URL exists. The research-informed story mode is already confirmed. Local green counts cannot replace any live artifact.

## After judging: teardown

After the announced judging and access-retention period ends, preserve the redacted receipts locally, then delete the entire dedicated project. This is the authoritative teardown; lifecycle deletion and spend caps are only backstops. The teardown-only verifier deliberately ignores expired Free Trial evidence so cost-reducing cleanup cannot be blocked, but it still requires the clean frozen commit, release tag, remote, frozen verifier, and hard-coded tracked project identity to agree. The ignored private release record has no immutable digest anchor and must not be described as though the Git tag content-addresses it; re-review it as operator input before teardown. Do not separately delete a globally addressed bucket: exact tracked-project deletion is the safer ownership boundary. The block below is intentionally standalone and must be run from the repository root in a fresh PowerShell process. Stop if any local, frozen, or live identity check fails.

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.5') {
    throw 'PowerShell 7.5 or later is required for string-preserving teardown identity checks.'
}
$JsonConvertCommand = Get-Command ConvertFrom-Json -ErrorAction Stop
if (-not $JsonConvertCommand.Parameters.ContainsKey('DateKind')) {
    throw 'This PowerShell cannot preserve timestamp strings while parsing teardown JSON.'
}
function ConvertFrom-JsonPreservingStrings {
    param([Parameter(Mandatory = $true, ValueFromPipeline = $true)][string]$Json)
    begin { $JsonLines = [System.Collections.Generic.List[string]]::new() }
    process { [void]$JsonLines.Add($Json) }
    end {
        return Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ($JsonLines -join "`n") -DateKind String -ErrorAction Stop
    }
}
[void](Get-Command node -ErrorAction Stop)
[void](Get-Command gcloud -ErrorAction Stop)
$ExpectedProjectId = 'found-roll-agentic-20260830'
$ExpectedProjectNumber = '1061926987746'
$ExpectedProjectCreatedAt = '2026-08-29T22:58:52.064Z'
$ExpectedEvidenceBucket = 'found-roll-agentic-20260830-found-roll-evidence'
$ExpectedLabelKey = 'found-roll-purpose'
$ExpectedLabelValue = 'dedicated-hackathon-demo'
$TeardownRegion = 'us-central1'

function Assert-StandaloneLastGcloudSuccess {
    param([Parameter(Mandatory = $true)][string]$Operation)
    if ($LASTEXITCODE -ne 0) { throw "gcloud failed during standalone teardown: $Operation." }
}

$ReleaseRecordPath = Join-Path $PWD "artifacts/private/submission-release.json"
$ResourceIdentityPath = Join-Path $PWD 'docs/google-cloud-resource-identity.json'
foreach ($RequiredPath in @($ReleaseRecordPath, $ResourceIdentityPath, (Join-Path $PWD 'scripts/verify-submission-readiness.mjs'))) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) { throw "Required teardown input is missing: $RequiredPath" }
}

$FrozenRelease = Get-Content -Raw -LiteralPath $ReleaseRecordPath -ErrorAction Stop | ConvertFrom-JsonPreservingStrings -ErrorAction Stop
$FrozenIdentity = Get-Content -Raw -LiteralPath $ResourceIdentityPath -ErrorAction Stop | ConvertFrom-JsonPreservingStrings -ErrorAction Stop
if (
    $FrozenIdentity.project_id -ne $ExpectedProjectId -or
    [string]$FrozenIdentity.project_number -ne $ExpectedProjectNumber -or
    [string]$FrozenIdentity.project_created_at_utc -ne $ExpectedProjectCreatedAt -or
    [string]$FrozenIdentity.evidence_bucket -ne $ExpectedEvidenceBucket -or
    [string]$FrozenIdentity.dedicated_project_label_key -ne $ExpectedLabelKey -or
    [string]$FrozenIdentity.dedicated_project_label_value -ne $ExpectedLabelValue -or
    $FrozenRelease.google_cloud.project_id -ne $ExpectedProjectId -or
    [string]$FrozenRelease.google_cloud.project_number -ne $ExpectedProjectNumber -or
    [string]$FrozenRelease.google_cloud.project_created_at_utc -ne $ExpectedProjectCreatedAt -or
    [string]$FrozenRelease.google_cloud.evidence_bucket -ne $ExpectedEvidenceBucket -or
    [string]$FrozenRelease.google_cloud.dedicated_project_label_key -ne $ExpectedLabelKey -or
    [string]$FrozenRelease.google_cloud.dedicated_project_label_value -ne $ExpectedLabelValue
) { throw 'Refusing teardown: local inputs do not match the exact dedicated project constants.' }

function Invoke-StandaloneTeardownVerifier {
    $VerifierLines = @(& node scripts/verify-submission-readiness.mjs --record $ReleaseRecordPath --teardown-identity-only 2>&1)
    $VerifierExitCode = $LASTEXITCODE
    $VerifierOutput = $VerifierLines -join "`n"
    if ($VerifierExitCode -ne 0 -or $VerifierOutput -notmatch '(?m)^GOOGLE CLOUD TEARDOWN IDENTITY: PASS$') {
        throw 'The frozen release tag and tracked project identity do not authorize teardown.'
    }
    return $VerifierOutput
}

function Assert-StandaloneDedicatedProjectIdentity {
    $ActiveProjectLines = @(& gcloud config get-value project 2>&1)
    $ActiveProjectExitCode = $LASTEXITCODE
    $ActiveProject = ($ActiveProjectLines -join "`n").Trim()
    if ($ActiveProjectExitCode -ne 0 -or $ActiveProject -ne $ExpectedProjectId) {
        throw "Refusing teardown: active project '$ActiveProject' is not the exact dedicated project."
    }
    $ProjectStateLines = @(& gcloud projects describe $ExpectedProjectId --format=json 2>&1)
    $ProjectStateExitCode = $LASTEXITCODE
    if ($ProjectStateExitCode -ne 0) { throw 'Could not describe the exact dedicated project before teardown.' }
    $ProjectState = ($ProjectStateLines -join "`n") | ConvertFrom-JsonPreservingStrings -ErrorAction Stop
    if (
        $ProjectState.projectId -ne $ExpectedProjectId -or
        [string]$ProjectState.projectNumber -ne $ExpectedProjectNumber -or
        [string]$ProjectState.createTime -ne $ExpectedProjectCreatedAt -or
        $ProjectState.lifecycleState -ne 'ACTIVE' -or
        $ProjectState.labels.$ExpectedLabelKey -ne $ExpectedLabelValue
    ) { throw 'Live project metadata does not match the exact standalone teardown constants.' }
}

Invoke-StandaloneTeardownVerifier
Assert-StandaloneDedicatedProjectIdentity
$RepositoryInventoryLines = @(& gcloud artifacts repositories list --project=$ExpectedProjectId --location=$TeardownRegion --format=json 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'Could not inventory regional Artifact Registry repositories before teardown.' }
Invoke-StandaloneTeardownVerifier
Assert-StandaloneDedicatedProjectIdentity
gcloud projects delete $ExpectedProjectId --project=$ExpectedProjectId --quiet
Assert-StandaloneLastGcloudSuccess -Operation 'dedicated-project deletion'
$DescribeLines = @(& gcloud projects describe $ExpectedProjectId --format=json 2>&1)
$DescribeExitCode = $LASTEXITCODE
$DescribeOutput = ($DescribeLines -join "`n").Trim()
$PostDeleteState = $null
$PostDeleteNotFoundConfirmed = $false
if ($DescribeExitCode -eq 0) {
    if ([string]::IsNullOrWhiteSpace($DescribeOutput)) { throw 'Post-delete describe returned empty success output.' }
    try { $PostDeleteProject = $DescribeOutput | ConvertFrom-JsonPreservingStrings -ErrorAction Stop }
    catch { throw 'Post-delete describe did not return valid project JSON.' }
    if (
        $PostDeleteProject.projectId -ne $ExpectedProjectId -or
        [string]$PostDeleteProject.projectNumber -ne $ExpectedProjectNumber -or
        [string]$PostDeleteProject.createTime -ne $ExpectedProjectCreatedAt -or
        $PostDeleteProject.labels.$ExpectedLabelKey -ne $ExpectedLabelValue -or
        $PostDeleteProject.lifecycleState -ne 'DELETE_REQUESTED'
    ) { throw 'Post-delete describe did not prove DELETE_REQUESTED for the exact dedicated project.' }
    $PostDeleteState = 'DELETE_REQUESTED'
} else {
    $EscapedProjectId = [regex]::Escape($ExpectedProjectId)
    $RecognizedNotFoundPattern = "^ERROR:\s+\(gcloud\.projects\.describe\)\s+(?:Project\s+)?\[$EscapedProjectId\]\s+(?:was\s+)?not found\.?$"
    if ([string]::IsNullOrWhiteSpace($DescribeOutput) -or $DescribeOutput -notmatch $RecognizedNotFoundPattern) {
        throw 'Post-delete describe failed without an exact-project recognized not-found result.'
    }
    $PostDeleteState = 'NOT_FOUND'
    $PostDeleteNotFoundConfirmed = $true
}
$TeardownReceipt = [ordered]@{
    schema_version = "1"
    project_id = $ExpectedProjectId
    project_number = $ExpectedProjectNumber
    project_created_at_utc = $ExpectedProjectCreatedAt
    dedicated_project_label_key = $ExpectedLabelKey
    dedicated_project_label_value = $ExpectedLabelValue
    deletion_command_accepted = $true
    post_delete_describe_exit_code = $DescribeExitCode
    post_delete_state = $PostDeleteState
    post_delete_not_found_confirmed = $PostDeleteNotFoundConfirmed
    recorded_at_utc = [DateTimeOffset]::UtcNow.ToString('o')
}
$TeardownReceiptJson = $TeardownReceipt | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    (Join-Path $PWD "artifacts/private/project-teardown-receipt.json"),
    "$TeardownReceiptJson`n",
    [System.Text.UTF8Encoding]::new($false)
)
```

Exact labeled-project deletion removes the evidence bucket, Cloud Run services, builds, Artifact Registry images, queue, secrets, IAM bindings, Firestore database, logs, and remaining project-scoped resources without first targeting a global bucket name. The action is irreversible for this demo workflow. Do not run it before judging finishes, against a shared project, or before the local receipts are preserved. The ignored teardown receipt is written only after the exact project returns `DELETE_REQUESTED`, or after a narrowly recognized error names that exact project as not found. Empty output, arbitrary errors, another project, and `ACTIVE` all fail before the receipt write. Confirm neither public URL still serves.
