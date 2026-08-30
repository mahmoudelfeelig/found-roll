[CmdletBinding()]
param(
    [string]$ProjectId = 'found-roll-agentic-20260830',
    [string]$GcloudPath = 'gcloud',
    [string]$AttestationTextSha256,
    [string]$AttestedAtUtc,
    [string]$AttestationBatchId,
    [int]$CloudRunCapMinorUnits = 1000,
    [int]$AgentPlatformCapMinorUnits = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.5') {
    throw 'PowerShell 7.5 or later is required for string-preserving JSON checks.'
}

$JsonConvertCommand = Get-Command ConvertFrom-Json -ErrorAction Stop
if (-not $JsonConvertCommand.Parameters.ContainsKey('DateKind')) {
    throw 'This PowerShell cannot preserve timestamp strings while parsing JSON.'
}

$RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PrivateRoot = Join-Path $RepositoryRoot 'artifacts/private'
$BillingReceiptPath = Join-Path $PrivateRoot 'billing-overview-receipt.json'
$CloudRunReceiptPath = Join-Path $PrivateRoot 'cloud-run-spend-cap-receipt.json'
$AgentPlatformReceiptPath = Join-Path $PrivateRoot 'agent-platform-spend-cap-receipt.json'
$ReleaseRecordPath = Join-Path $PrivateRoot 'submission-release.json'
$BillingTemplatePath = Join-Path $RepositoryRoot 'docs/google-cloud-billing-preflight.template.json'
$SpendCapTemplatePath = Join-Path $RepositoryRoot 'docs/google-cloud-spend-cap.template.json'
$ReleaseTemplatePath = Join-Path $RepositoryRoot 'docs/submission-release.template.json'
$ResourceIdentityPath = Join-Path $RepositoryRoot 'docs/google-cloud-resource-identity.json'
$AttestationVersion = 'found-roll-zero-real-money-v1'
$AttestationSource = 'entrant_direct_confirmation'
$ExpectedAttestationTextSha256 = '5ab75588420cca012f174e63eba3ca05f83e88cad99f93916543a335171b6a82'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function ConvertFrom-JsonPreservingStrings {
    param([Parameter(ValueFromPipeline = $true)][AllowEmptyString()][string]$Json)
    begin { $JsonLines = [System.Collections.Generic.List[string]]::new() }
    process { [void]$JsonLines.Add($Json) }
    end {
        Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject ($JsonLines -join "`n") -DateKind String
    }
}

function Get-UtcTimestamp {
    [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Value)
    $Bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-FileSha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required JSON file is missing: $Path" }
    Get-Content -Raw -LiteralPath $Path | ConvertFrom-JsonPreservingStrings
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Value
    )
    $Json = $Value | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText($Path, "$Json`n", $Utf8NoBom)
}

function Invoke-GcloudJson {
    param(
        [Parameter(Mandatory = $true)][string]$Operation,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $Lines = @(& $GcloudPath @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "Google Cloud CLI failed during $Operation." }
    ($Lines -join "`n") | ConvertFrom-JsonPreservingStrings
}

function Assert-AttestationInputs {
    param(
        [Parameter(Mandatory = $true)][string]$TextSha256,
        [Parameter(Mandatory = $true)][string]$Timestamp,
        [Parameter(Mandatory = $true)][string]$BatchId
    )
    if ($TextSha256 -notmatch '^[a-f0-9]{64}$') { throw 'AttestationTextSha256 must be a lowercase SHA-256 digest.' }
    if ($TextSha256 -ne $ExpectedAttestationTextSha256) { throw 'AttestationTextSha256 does not match the exact approved entrant confirmation for this release.' }
    if ($BatchId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
        throw 'AttestationBatchId must be a UUID v4.'
    }
    $ParsedTimestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($Timestamp, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$ParsedTimestamp)) {
        throw 'AttestedAtUtc must be an ISO-8601 UTC timestamp.'
    }
    $Age = [DateTimeOffset]::UtcNow - $ParsedTimestamp.ToUniversalTime()
    if ($Age.TotalMinutes -lt -5 -or $Age.TotalHours -gt 24) { throw 'The entrant attestation must be current within 24 hours.' }
}

function Assert-PriorBillingReceiptShape {
    param(
        [Parameter(Mandatory = $true)][object]$Receipt,
        [Parameter(Mandatory = $true)][string]$ExpectedProjectId
    )
    $RequiredFields = @(
        'schema_version',
        'kind',
        'status',
        'attestation_version',
        'attestation_source',
        'attestation_batch_id',
        'attestation_text_sha256',
        'attested_at_utc',
        'project_id',
        'billing_account_name_sha256',
        'account_type',
        'billing_enabled_cli_observed',
        'billing_account_open_cli_observed',
        'remaining_credit_greater_than_zero',
        'remaining_time_greater_than_zero',
        'paid_activation_absent',
        'no_paid_upgrade_or_payment_during_release_confirmed',
        'entrant_attestation_confirmed'
    )
    $MissingFields = @($RequiredFields | Where-Object { $null -eq $Receipt.PSObject.Properties[$_] })
    if ($MissingFields.Count -gt 0) { throw 'The existing preflight receipt is incomplete and cannot be reused.' }
    if (
        [string]$Receipt.schema_version -ne '2' -or
        [string]$Receipt.kind -ne 'found-roll-google-cloud-billing-preflight' -or
        [string]$Receipt.status -ne 'PASS' -or
        [string]$Receipt.attestation_version -ne $AttestationVersion -or
        [string]$Receipt.attestation_source -ne $AttestationSource -or
        [string]$Receipt.project_id -ne $ExpectedProjectId -or
        [string]$Receipt.account_type -ne 'free_trial' -or
        $Receipt.billing_enabled_cli_observed -ne $true -or
        $Receipt.billing_account_open_cli_observed -ne $true -or
        $Receipt.remaining_credit_greater_than_zero -ne $true -or
        $Receipt.remaining_time_greater_than_zero -ne $true -or
        $Receipt.paid_activation_absent -ne $true -or
        $Receipt.no_paid_upgrade_or_payment_during_release_confirmed -ne $true -or
        $Receipt.entrant_attestation_confirmed -ne $true
    ) { throw 'The existing preflight receipt cannot donate an attestation to this project.' }
}

$ProvidedAttestationInputCount = @(
    $AttestationTextSha256,
    $AttestedAtUtc,
    $AttestationBatchId
).Where({ -not [string]::IsNullOrWhiteSpace([string]$_) }).Count
if ($ProvidedAttestationInputCount -ne 0 -and $ProvidedAttestationInputCount -ne 3) {
    throw 'Provide all three entrant-attestation inputs together, or omit all three to refresh the existing batch.'
}
$ExplicitAttestationProvided = $ProvidedAttestationInputCount -eq 3
if ($ExplicitAttestationProvided) {
    Assert-AttestationInputs -TextSha256 $AttestationTextSha256 -Timestamp $AttestedAtUtc -BatchId $AttestationBatchId
}

New-Item -ItemType Directory -Force -Path $PrivateRoot | Out-Null

$Identity = Read-JsonFile -Path $ResourceIdentityPath
if ($Identity.project_id -ne $ProjectId) { throw 'The requested project does not match the tracked Found Roll identity.' }

$Project = Invoke-GcloudJson -Operation 'project identity verification' -Arguments @(
    'projects', 'describe', $ProjectId, '--format=json'
)
if (
    $Project.projectId -ne $Identity.project_id -or
    [string]$Project.projectNumber -ne [string]$Identity.project_number -or
    [string]$Project.createTime -ne [string]$Identity.project_created_at_utc -or
    $Project.lifecycleState -ne 'ACTIVE' -or
    $Project.labels.([string]$Identity.dedicated_project_label_key) -ne [string]$Identity.dedicated_project_label_value
) { throw 'The live project does not match the tracked dedicated Found Roll identity.' }

$BillingLink = Invoke-GcloudJson -Operation 'project billing-link verification' -Arguments @(
    'billing', 'projects', 'describe', $ProjectId, '--format=json'
)
if ($BillingLink.billingEnabled -ne $true -or [string]::IsNullOrWhiteSpace([string]$BillingLink.billingAccountName)) {
    throw 'The dedicated project is not linked to an open billing account.'
}
$BillingAccountResource = [string]$BillingLink.billingAccountName
if ($BillingAccountResource -notmatch '^billingAccounts/[A-Z0-9-]+$') { throw 'The live billing account resource has an unexpected shape.' }
$BillingAccountId = $BillingAccountResource.Substring('billingAccounts/'.Length)
$BillingAccount = Invoke-GcloudJson -Operation 'billing-account state verification' -Arguments @(
    'billing', 'accounts', 'describe', $BillingAccountId, '--format=json'
)
if ($BillingAccount.open -ne $true) { throw 'The linked billing account is not open.' }

$NowUtc = Get-UtcTimestamp
$BillingAccountHash = Get-Sha256Hex -Value $BillingAccountResource

$ExistingBillingReceipt = Test-Path -LiteralPath $BillingReceiptPath -PathType Leaf
$ExistingBillingAccountHash = $null
$ExistingAttestationTextSha256 = $null
$ExistingAttestedAtUtc = $null
$ExistingAttestationBatchId = $null
if ($ExistingBillingReceipt) {
    $PriorBillingReceipt = Read-JsonFile -Path $BillingReceiptPath
    Assert-PriorBillingReceiptShape -Receipt $PriorBillingReceipt -ExpectedProjectId $ProjectId
    $ExistingBillingAccountHash = [string]$PriorBillingReceipt.billing_account_name_sha256
    $ExistingAttestationTextSha256 = [string]$PriorBillingReceipt.attestation_text_sha256
    $ExistingAttestedAtUtc = [string]$PriorBillingReceipt.attested_at_utc
    $ExistingAttestationBatchId = [string]$PriorBillingReceipt.attestation_batch_id
    if (-not $ExplicitAttestationProvided) {
        $AttestationTextSha256 = $ExistingAttestationTextSha256
        $AttestedAtUtc = $ExistingAttestedAtUtc
        $AttestationBatchId = $ExistingAttestationBatchId
    } elseif (
        $AttestationBatchId -eq $ExistingAttestationBatchId -and (
            $AttestationTextSha256 -ne $ExistingAttestationTextSha256 -or
            $AttestedAtUtc -ne $ExistingAttestedAtUtc
        )
    ) {
        throw 'An existing attestation batch cannot be rebound to different entrant evidence.'
    }
} else {
    if (
        [string]::IsNullOrWhiteSpace($AttestationTextSha256) -or
        [string]::IsNullOrWhiteSpace($AttestedAtUtc) -or
        [string]::IsNullOrWhiteSpace($AttestationBatchId)
    ) { throw 'Initial preflight creation requires the direct entrant-attestation hash, timestamp, and batch UUID.' }
}

Assert-AttestationInputs -TextSha256 $AttestationTextSha256 -Timestamp $AttestedAtUtc -BatchId $AttestationBatchId
if ($ExistingBillingReceipt) {
    if ($ExistingBillingAccountHash -notmatch '^[a-f0-9]{64}$') {
        throw 'The existing preflight receipt has no valid billing-account binding.'
    }
    if ($BillingAccountHash -ne $ExistingBillingAccountHash -and (
        -not $ExplicitAttestationProvided -or
        $AttestationBatchId -eq $ExistingAttestationBatchId
    )) {
        throw 'The project billing account changed; obtain a new direct entrant confirmation and use a new attestation batch.'
    }
}
if ($CloudRunCapMinorUnits -ne 1000 -or $AgentPlatformCapMinorUnits -ne 500) {
    throw 'This release is authorized only for the entrant-attested EUR 10 Cloud Run and EUR 5 Agent Platform caps.'
}

$BillingReceipt = Read-JsonFile -Path $BillingTemplatePath
$BillingReceipt.schema_version = '2'
$BillingReceipt.kind = 'found-roll-google-cloud-billing-preflight'
$BillingReceipt.status = 'PASS'
$BillingReceipt.attestation_version = $AttestationVersion
$BillingReceipt.attestation_source = $AttestationSource
$BillingReceipt.attestation_batch_id = $AttestationBatchId
$BillingReceipt.attestation_text_sha256 = $AttestationTextSha256
$BillingReceipt.attested_at_utc = $AttestedAtUtc
$BillingReceipt.cli_checked_at_utc = $NowUtc
$BillingReceipt.project_id = $ProjectId
$BillingReceipt.billing_account_name_sha256 = $BillingAccountHash
$BillingReceipt.account_type = 'free_trial'
$BillingReceipt.billing_enabled_cli_observed = $true
$BillingReceipt.billing_account_open_cli_observed = $true
$BillingReceipt.remaining_credit_greater_than_zero = $true
$BillingReceipt.remaining_time_greater_than_zero = $true
$BillingReceipt.paid_activation_absent = $true
$BillingReceipt.no_paid_upgrade_or_payment_during_release_confirmed = $true
$BillingReceipt.entrant_attestation_confirmed = $true

function New-SpendCapReceipt {
    param(
        [Parameter(Mandatory = $true)][string]$ServiceTarget,
        [Parameter(Mandatory = $true)][int]$MinorUnits
    )
    $Receipt = Read-JsonFile -Path $SpendCapTemplatePath
    $Receipt.schema_version = '2'
    $Receipt.kind = 'found-roll-google-cloud-spend-cap-preflight'
    $Receipt.status = 'PASS'
    $Receipt.attestation_version = $AttestationVersion
    $Receipt.attestation_source = $AttestationSource
    $Receipt.attestation_batch_id = $AttestationBatchId
    $Receipt.attestation_text_sha256 = $AttestationTextSha256
    $Receipt.attested_at_utc = $AttestedAtUtc
    $Receipt.project_id = $ProjectId
    $Receipt.service_target = $ServiceTarget
    $Receipt.cap_status = 'CONFIGURED'
    $Receipt.cap_amount_minor_units = $MinorUnits
    $Receipt.cap_currency = 'EUR'
    $Receipt.project_scope_confirmed = $true
    $Receipt.service_scope_confirmed = $true
    $Receipt.lowest_practical_demo_target_confirmed = $true
    $Receipt.no_cap_change_during_release_confirmed = $true
    $Receipt.entrant_attestation_confirmed = $true
    $Receipt
}

$CloudRunReceipt = New-SpendCapReceipt -ServiceTarget 'cloud_run' -MinorUnits $CloudRunCapMinorUnits
$AgentPlatformReceipt = New-SpendCapReceipt -ServiceTarget 'agent_platform' -MinorUnits $AgentPlatformCapMinorUnits

Write-JsonFile -Path $BillingReceiptPath -Value $BillingReceipt
Write-JsonFile -Path $CloudRunReceiptPath -Value $CloudRunReceipt
Write-JsonFile -Path $AgentPlatformReceiptPath -Value $AgentPlatformReceipt

if (Test-Path -LiteralPath $ReleaseRecordPath -PathType Leaf) {
    $ReleaseRecord = Read-JsonFile -Path $ReleaseRecordPath
} else {
    $ReleaseRecord = Read-JsonFile -Path $ReleaseTemplatePath
}
$ReleaseRecord.created_at_utc = $NowUtc
$ReleaseRecord.google_cloud.project_id = [string]$Identity.project_id
$ReleaseRecord.google_cloud.project_number = [string]$Identity.project_number
$ReleaseRecord.google_cloud.project_created_at_utc = [string]$Identity.project_created_at_utc
$ReleaseRecord.google_cloud.evidence_bucket = [string]$Identity.evidence_bucket
$ReleaseRecord.google_cloud.dedicated_project_confirmed = $true
$ReleaseRecord.google_cloud.dedicated_project_label_key = [string]$Identity.dedicated_project_label_key
$ReleaseRecord.google_cloud.dedicated_project_label_value = [string]$Identity.dedicated_project_label_value
$ReleaseRecord.google_cloud.billing_enabled_confirmed = $true
$ReleaseRecord.google_cloud.billing_account_type = 'free_trial'
$ReleaseRecord.google_cloud.free_trial_remaining_credit_confirmed = $true
$ReleaseRecord.google_cloud.free_trial_remaining_time_confirmed = $true
$ReleaseRecord.google_cloud.paid_activation_absent_confirmed = $true
$ReleaseRecord.google_cloud.cloud_run_spend_cap_confirmed = $true
$ReleaseRecord.google_cloud.agent_platform_spend_cap_confirmed = $true
$ReleaseRecord.google_cloud.resource_identity.path = 'docs/google-cloud-resource-identity.json'
$ReleaseRecord.google_cloud.resource_identity.sha256 = Get-FileSha256Hex -Path $ResourceIdentityPath
$ReleaseRecord.google_cloud.preflight_receipts.billing_overview.path = 'artifacts/private/billing-overview-receipt.json'
$ReleaseRecord.google_cloud.preflight_receipts.billing_overview.sha256 = Get-FileSha256Hex -Path $BillingReceiptPath
$ReleaseRecord.google_cloud.preflight_receipts.cloud_run_spend_cap.path = 'artifacts/private/cloud-run-spend-cap-receipt.json'
$ReleaseRecord.google_cloud.preflight_receipts.cloud_run_spend_cap.sha256 = Get-FileSha256Hex -Path $CloudRunReceiptPath
$ReleaseRecord.google_cloud.preflight_receipts.agent_platform_spend_cap.path = 'artifacts/private/agent-platform-spend-cap-receipt.json'
$ReleaseRecord.google_cloud.preflight_receipts.agent_platform_spend_cap.sha256 = Get-FileSha256Hex -Path $AgentPlatformReceiptPath
Write-JsonFile -Path $ReleaseRecordPath -Value $ReleaseRecord

Push-Location $RepositoryRoot
try {
    $VerifierLines = @(& node scripts/verify-submission-readiness.mjs --record artifacts/private/submission-release.json --preflight-only 2>&1)
    $VerifierExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
$VerifierOutput = $VerifierLines -join "`n"
if ($VerifierExitCode -ne 0 -or $VerifierOutput -notmatch '(?m)^GOOGLE CLOUD PREFLIGHT: PASS$') {
    throw "Google Cloud preflight did not pass.`n$VerifierOutput"
}
$VerifierOutput
