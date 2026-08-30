param(
    [Parameter(Mandatory)][uri]$AppUrl,
    [Parameter(Mandatory)][uri]$SimulatorUrl,
    [string]$EvidencePath,
    [string]$CaseId = "FR-20260829-0042",
    [string]$ReceiptPath,
    [switch]$AllowLocalFixture
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7 or newer is required for safe multipart form support.'
}

if (-not $EvidencePath) {
    $EvidencePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'public\assets\pouch-front.jpg'
}
$EvidencePath = (Resolve-Path -LiteralPath $EvidencePath).Path

if (-not $AllowLocalFixture -and ($AppUrl.Scheme -ne 'https' -or $SimulatorUrl.Scheme -ne 'https')) {
    throw 'Canonical preparation requires HTTPS app and simulator URLs. Use -AllowLocalFixture only for local rehearsal.'
}

function Get-RequiredSecret {
    param([Parameter(Mandatory)][string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Set $Name in the current process environment. Do not pass it as a script argument."
    }
    return $value
}

function Join-ServiceUrl {
    param(
        [Parameter(Mandatory)][uri]$BaseUrl,
        [Parameter(Mandatory)][string]$Path
    )
    return "$($BaseUrl.AbsoluteUri.TrimEnd('/'))/$($Path.TrimStart('/'))"
}

function Invoke-EvidenceUpload {
    param(
        [Parameter(Mandatory)][uri]$BaseUrl,
        [Parameter(Mandatory)][string]$CaseId,
        [Parameter(Mandatory)][System.IO.FileInfo]$EvidenceFile,
        [Parameter(Mandatory)][string]$EvidenceMimeType,
        [Parameter(Mandatory)][string]$IdempotencyKey,
        [Parameter(Mandatory)][string]$StaffToken,
        [Parameter(Mandatory)][bool]$AuthorizePreviewForModel,
        [Parameter(Mandatory)][int]$ExpectedStatusCode
    )

    # Build every command from the same frozen file so the retry and conflict
    # checks exercise the real multipart boundary without logging credentials.
    $httpClient = [System.Net.Http.HttpClient]::new()
    $request = $null
    $response = $null
    $multipart = $null
    $fileStream = $null
    try {
        $multipart = [System.Net.Http.MultipartFormDataContent]::new()
        $fileStream = [System.IO.File]::OpenRead($EvidenceFile.FullName)
        $fileContent = [System.Net.Http.StreamContent]::new($fileStream)
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new($EvidenceMimeType)
        $multipart.Add($fileContent, 'file', $EvidenceFile.Name)
        $consent = if ($AuthorizePreviewForModel) { 'true' } else { 'false' }
        $multipart.Add([System.Net.Http.StringContent]::new($consent), 'authorize_preview_for_model')
        $multipart.Add([System.Net.Http.StringContent]::new($IdempotencyKey), 'idempotency_key')

        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post,
            (Join-ServiceUrl $BaseUrl "/api/v1/staff/passports/$CaseId/evidence")
        )
        [void]$request.Headers.TryAddWithoutValidation('X-Found-Roll-Staff-Token', $StaffToken)
        $request.Content = $multipart

        $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        if ($statusCode -ne $ExpectedStatusCode) {
            throw "Evidence upload boundary returned unexpected HTTP $statusCode."
        }
        $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        try {
            $payload = $responseBody | ConvertFrom-Json
        } catch {
            throw "Evidence upload boundary returned invalid JSON for expected HTTP $ExpectedStatusCode."
        }
        return [pscustomobject]@{
            status_code = $statusCode
            payload = $payload
        }
    } finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        if ($null -ne $request) {
            $request.Dispose()
        } elseif ($null -ne $multipart) {
            $multipart.Dispose()
        } elseif ($null -ne $fileStream) {
            $fileStream.Dispose()
        }
        $httpClient.Dispose()
    }
}

$demoToken = Get-RequiredSecret 'FOUND_ROLL_DEMO_ACCESS_TOKEN'
$adminToken = Get-RequiredSecret 'FOUND_ROLL_ADMIN_TOKEN'
$staffToken = Get-RequiredSecret 'FOUND_ROLL_EVIDENCE_STAFF_TOKEN'
$supervisorToken = Get-RequiredSecret 'FOUND_ROLL_SUPERVISOR_TOKEN'
$relayApiKey = Get-RequiredSecret 'FOUND_ROLL_RELAY_API_KEY'

$appHealth = Invoke-RestMethod -Method Get -Uri (Join-ServiceUrl $AppUrl '/api/v1/healthz')
$simulatorHealth = Invoke-RestMethod -Method Get -Uri (Join-ServiceUrl $SimulatorUrl '/api/v1/healthz')

foreach ($contractField in @('prompt_version', 'output_schema_version', 'policy_version')) {
    $contractProperty = $appHealth.PSObject.Properties[$contractField]
    if ($null -eq $contractProperty -or [string]::IsNullOrWhiteSpace([string]$contractProperty.Value)) {
        throw "App health did not expose the required frozen contract field $contractField."
    }
}

if (-not $AllowLocalFixture) {
    $expectedGuards = @{
        environment = 'production'
        demo_mode = $true
        demo_mutation_auth_required = $true
        admin_reset_auth_required = $true
        staff_read_auth_required = $true
        task_header_required = $true
        task_oidc_required = $true
        inventory_legacy_health_compatibility = $false
    }
    foreach ($entry in $expectedGuards.GetEnumerator()) {
        if ($appHealth.($entry.Key) -ne $entry.Value) {
            throw "Canonical app guard mismatch for $($entry.Key): expected $($entry.Value)."
        }
    }
    $expectedModes = @{
        analyst_mode = 'vertex_adk'
        model_name = 'gemini-3.5-flash'
        inventory_mode = 'http'
        repository = 'firestore'
        evidence_store = 'gcs'
        tasks_mode = 'cloud'
        relay_mode = 'http'
    }
    foreach ($entry in $expectedModes.GetEnumerator()) {
        if ($appHealth.($entry.Key) -ne $entry.Value) {
            throw "Canonical app health mismatch for $($entry.Key): expected $($entry.Value)."
        }
    }
    if (-not $appHealth.evidence_store_ready -or -not $appHealth.evidence_bucket_configured) {
        throw 'Canonical evidence storage is not ready.'
    }
    if (-not $appHealth.inventory_gateway_ready -or -not $appHealth.inventory_base_url_configured) {
        throw 'Canonical simulator-backed inventory gateway is not ready.'
    }
    if (
        $simulatorHealth.data.environment -ne 'production' -or
        -not $simulatorHealth.data.mutation_auth_configured -or
        -not $simulatorHealth.data.callback_signing_configured -or
        -not $simulatorHealth.data.token_derivation_configured
    ) {
        throw 'Canonical simulator health does not prove production mode and all three configured security boundaries.'
    }
} else {
    if ($appHealth.inventory_mode -ne 'http' -or -not $appHealth.inventory_gateway_ready -or -not $appHealth.inventory_base_url_configured) {
        throw 'Local rehearsal requires the real loopback HTTP inventory gateway.'
    }
    if ($appHealth.relay_mode -ne 'http') {
        throw 'Local rehearsal requires the real loopback HTTP relay boundary.'
    }
}
if ($simulatorHealth.simulation.mode -ne 'SIMULATED') {
    throw 'The simulator health response did not contain the permanent SIMULATED disclosure.'
}

$runtimeRoles = Invoke-RestMethod `
    -Method Get `
    -Uri (Join-ServiceUrl $AppUrl '/api/v1/auth/runtime-roles') `
    -Headers @{
        'X-Found-Roll-Demo-Token' = $demoToken
        'X-Found-Roll-Staff-Token' = $staffToken
        'X-Found-Roll-Supervisor-Token' = $supervisorToken
    }
if (
    -not $runtimeRoles.authenticated -or
    [string]::IsNullOrWhiteSpace($runtimeRoles.staff_actor_id) -or
    [string]::IsNullOrWhiteSpace($runtimeRoles.supervisor_actor_id) -or
    $runtimeRoles.staff_actor_id -eq $runtimeRoles.supervisor_actor_id
) {
    throw 'The strict runtime-role probe did not authenticate distinct staff and supervisor actors.'
}

$simulatorResetBody = @{
    confirmation = 'RESET_SIMULATED_FIXTURE'
    actor = 'demo:operator'
    reason = 'Fresh isolated synthetic canonical run'
} | ConvertTo-Json
$simulatorReset = Invoke-RestMethod `
    -Method Post `
    -Uri (Join-ServiceUrl $SimulatorUrl '/v1/admin/reset') `
    -Headers @{ Authorization = "Bearer $relayApiKey" } `
    -ContentType 'application/json' `
    -Body $simulatorResetBody

$appReset = Invoke-RestMethod `
    -Method Post `
    -Uri (Join-ServiceUrl $AppUrl '/api/v1/demo/reset') `
    -Headers @{ 'X-Found-Roll-Admin-Token' = $adminToken }

$snapshot = Invoke-RestMethod `
    -Method Get `
    -Uri (Join-ServiceUrl $AppUrl '/api/v1/demo/snapshot') `
    -Headers @{ 'X-Found-Roll-Staff-Token' = $staffToken }
if ($snapshot.case.id -ne $CaseId -or $snapshot.case.state -ne 'RECEIVED') {
    throw 'The Found Roll reset did not return the frozen case in RECEIVED state.'
}
if (-not $snapshot.case.workflow_epoch) {
    throw 'The reset snapshot did not expose a workflow epoch for evidence isolation.'
}
$evidenceIdempotencyKey = "canonical:${CaseId}:$($snapshot.case.workflow_epoch):evidence:v1"

$evidenceFile = Get-Item -LiteralPath $EvidencePath
$evidenceMimeType = switch ($evidenceFile.Extension.ToLowerInvariant()) {
    '.jpg' { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.png' { 'image/png' }
    default { throw 'Evidence must be a JPEG or PNG image.' }
}

# Invoke-RestMethod serializes FileInfo values as application/octet-stream. Use the
# explicit multipart helper so all three commands preserve the JPEG/PNG boundary.
$upload = (Invoke-EvidenceUpload `
    -BaseUrl $AppUrl `
    -CaseId $CaseId `
    -EvidenceFile $evidenceFile `
    -EvidenceMimeType $evidenceMimeType `
    -IdempotencyKey $evidenceIdempotencyKey `
    -StaffToken $staffToken `
    -AuthorizePreviewForModel $true `
    -ExpectedStatusCode 200).payload
$retryUpload = (Invoke-EvidenceUpload `
    -BaseUrl $AppUrl `
    -CaseId $CaseId `
    -EvidenceFile $evidenceFile `
    -EvidenceMimeType $evidenceMimeType `
    -IdempotencyKey $evidenceIdempotencyKey `
    -StaffToken $staffToken `
    -AuthorizePreviewForModel $true `
    -ExpectedStatusCode 200).payload

$uploadPairIdentity = [ordered]@{
    workflow_epoch = $upload.workflow_epoch
    active_for_analysis = $upload.active_for_analysis
    original = [ordered]@{
        id = $upload.original.id
        sha256 = $upload.original.sha256
        generation = $upload.original.generation
        visibility = $upload.original.visibility
    }
    preview = [ordered]@{
        id = $upload.preview.id
        sha256 = $upload.preview.sha256
        generation = $upload.preview.generation
        visibility = $upload.preview.visibility
    }
}
$retryPairIdentity = [ordered]@{
    workflow_epoch = $retryUpload.workflow_epoch
    active_for_analysis = $retryUpload.active_for_analysis
    original = [ordered]@{
        id = $retryUpload.original.id
        sha256 = $retryUpload.original.sha256
        generation = $retryUpload.original.generation
        visibility = $retryUpload.original.visibility
    }
    preview = [ordered]@{
        id = $retryUpload.preview.id
        sha256 = $retryUpload.preview.sha256
        generation = $retryUpload.preview.generation
        visibility = $retryUpload.preview.visibility
    }
}
$exactRetrySamePair = (
    ($uploadPairIdentity | ConvertTo-Json -Depth 4 -Compress) -ceq
    ($retryPairIdentity | ConvertTo-Json -Depth 4 -Compress)
)
if (-not $exactRetrySamePair) {
    throw 'An exact evidence-upload retry did not return the original evidence pair.'
}

$changedConsentResponse = Invoke-EvidenceUpload `
    -BaseUrl $AppUrl `
    -CaseId $CaseId `
    -EvidenceFile $evidenceFile `
    -EvidenceMimeType $evidenceMimeType `
    -IdempotencyKey $evidenceIdempotencyKey `
    -StaffToken $staffToken `
    -AuthorizePreviewForModel $false `
    -ExpectedStatusCode 409
$changedConsentConflictCode = [string]$changedConsentResponse.payload.error.code
if ($changedConsentConflictCode -ne 'evidence_idempotency_conflict') {
    throw 'Changed evidence consent did not fail with the required idempotency conflict.'
}
$changedConsentConflictVerified = $true

$localSha256 = (Get-FileHash -LiteralPath $EvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($upload.original.sha256 -ne $localSha256) {
    throw 'The stored original checksum does not match the frozen source asset.'
}
if ($upload.original.visibility -ne 'STAFF_ONLY' -or $upload.preview.visibility -ne 'MODEL_AUTHORIZED') {
    throw 'Evidence visibility did not preserve a staff-only original and model-authorized derivative.'
}
if ($upload.preview.provenance.origin -ne 'DERIVED' -or $upload.preview.provenance.source_evidence_id -ne $upload.original.id) {
    throw 'The preview provenance does not link to the original evidence record.'
}
if ($upload.workflow_epoch -ne $snapshot.case.workflow_epoch -or -not $upload.active_for_analysis) {
    throw 'The uploaded evidence pair is not active for the reset workflow epoch.'
}
$evidenceListing = Invoke-RestMethod `
    -Method Get `
    -Uri (Join-ServiceUrl $AppUrl "/api/v1/staff/passports/$CaseId/evidence") `
    -Headers @{ 'X-Found-Roll-Staff-Token' = $staffToken }
$currentEpochEvidence = @($evidenceListing.items | Where-Object { $_.workflow_epoch -eq $snapshot.case.workflow_epoch })
if ($evidenceListing.workflow_epoch -ne $snapshot.case.workflow_epoch -or $currentEpochEvidence.Count -ne 2) {
    throw 'The current workflow epoch does not contain exactly one evidence pair.'
}
$expectedActivePairIds = @($upload.original.id, $upload.preview.id) | Sort-Object
$actualActivePairIds = @($evidenceListing.active_pair_ids) | Sort-Object
if ((ConvertTo-Json $expectedActivePairIds -Compress) -ne (ConvertTo-Json $actualActivePairIds -Compress)) {
    throw 'The evidence listing did not select the uploaded pair as the active analysis packet.'
}
if (-not $AllowLocalFixture) {
    foreach ($record in @($upload.original, $upload.preview)) {
        if (-not $record.storage_uri.StartsWith('gs://') -or -not $record.generation) {
            throw 'Canonical evidence did not return a generation-pinned private GCS record.'
        }
    }
}

$receipt = [ordered]@{
    schema_version = '2'
    status = 'PREPARED_FOR_ANALYSIS'
    canonical = -not $AllowLocalFixture
    prepared_at = [DateTimeOffset]::UtcNow.ToString('o')
    preparation_script_sha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    case_id = $snapshot.case.id
    workflow_epoch = $snapshot.case.workflow_epoch
    case_version = $snapshot.case.version
    case_state = $snapshot.case.state
    fixture_version = $simulatorReset.data.fixture_version
    analyst_mode = $appHealth.analyst_mode
    inventory_mode = $appHealth.inventory_mode
    inventory_gateway_ready = $appHealth.inventory_gateway_ready
    model_name = $appHealth.model_name
    prompt_version = $appHealth.prompt_version
    output_schema_version = $appHealth.output_schema_version
    policy_version = $appHealth.policy_version
    app_environment = $appHealth.environment
    demo_mutation_auth_required = $appHealth.demo_mutation_auth_required
    admin_reset_auth_required = $appHealth.admin_reset_auth_required
    staff_read_auth_required = $appHealth.staff_read_auth_required
    task_header_required = $appHealth.task_header_required
    task_oidc_required = $appHealth.task_oidc_required
    runtime_roles_authenticated = $runtimeRoles.authenticated
    staff_actor_id = $runtimeRoles.staff_actor_id
    supervisor_actor_id = $runtimeRoles.supervisor_actor_id
    inventory_legacy_health_compatibility = $appHealth.inventory_legacy_health_compatibility
    repository = $appHealth.repository
    evidence_store = $appHealth.evidence_store
    tasks_mode = $appHealth.tasks_mode
    relay_mode = $appHealth.relay_mode
    evidence = [ordered]@{
        source_file = $evidenceFile.Name
        original_id = $upload.original.id
        original_sha256 = $upload.original.sha256
        original_generation = $upload.original.generation
        preview_id = $upload.preview.id
        preview_sha256 = $upload.preview.sha256
        preview_generation = $upload.preview.generation
        preview_visibility = $upload.preview.visibility
        active_pair_ids = $actualActivePairIds
        current_epoch_record_count = $currentEpochEvidence.Count
        active_for_analysis = $upload.active_for_analysis
        exact_retry_same_pair = $exactRetrySamePair
        changed_consent_conflict_verified = $changedConsentConflictVerified
        changed_consent_conflict_code = $changedConsentConflictCode
    }
    simulator_disclosure = $simulatorHealth.simulation.mode
    simulator_environment = $simulatorHealth.data.environment
    reset_event_count = @($appReset.events).Count
}

$receiptJson = $receipt | ConvertTo-Json -Depth 8
if ($ReceiptPath) {
    $receiptDirectory = Split-Path $ReceiptPath -Parent
    if ($receiptDirectory) {
        New-Item -ItemType Directory -Force -Path $receiptDirectory | Out-Null
    }
    Set-Content -LiteralPath $ReceiptPath -Value $receiptJson -Encoding utf8NoBOM
}
$receiptJson
