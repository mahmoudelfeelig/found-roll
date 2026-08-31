$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ServicePython = Join-Path $ProjectRoot 'service\.venv\Scripts\python.exe'
$SimulatorPython = Join-Path $ProjectRoot 'simulator\.venv\Scripts\python.exe'
$Node = (Get-Command node -ErrorAction Stop).Source

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][scriptblock]$Command
    )
    Write-Host "`n[$Label]"
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Invoke-FrontendBuild {
    & $Node node_modules\vite\bin\vite.js build
    if ($LASTEXITCODE -ne 0) { return }
    & $Node scripts\prepare-sites-build.mjs
}

function Invoke-FrontendTests {
    & $Node --test tests/*.test.mjs
}

function Assert-JsonInvariant {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][scriptblock]$Check,
        [Parameter(Mandatory)][string]$Message
    )
    $Payload = Get-Content -Raw (Join-Path $ProjectRoot $Path) | ConvertFrom-Json
    if (-not (& $Check $Payload)) {
        throw $Message
    }
}

foreach ($Python in @($ServicePython, $SimulatorPython)) {
    if (-not (Test-Path -LiteralPath $Python)) {
        throw "Missing verification environment: $Python"
    }
}

Push-Location $ProjectRoot
try {
    Invoke-Checked 'frontend production build' { Invoke-FrontendBuild }
    Invoke-Checked 'frontend and packaging tests' { Invoke-FrontendTests }
    Invoke-Checked 'custody service tests' {
        Push-Location (Join-Path $ProjectRoot 'service')
        try { & $ServicePython -m pytest tests -q } finally { Pop-Location }
    }
    Invoke-Checked 'custody service dependency check' { & $ServicePython -m pip check }
    Invoke-Checked 'custody service and release-script compile check' {
        & $ServicePython -m compileall -q service\app service\tests deployment evaluation scripts
    }
    Invoke-Checked 'relay simulator tests' {
        Push-Location (Join-Path $ProjectRoot 'simulator')
        try { & $SimulatorPython -m pytest tests -q } finally { Pop-Location }
    }
    Invoke-Checked 'relay simulator dependency check' { & $SimulatorPython -m pip check }
    Invoke-Checked 'relay simulator compile check' {
        & $SimulatorPython -m compileall -q simulator\app simulator\tests
    }
    Invoke-Checked 'privacy scanner self-tests' {
        & $ServicePython -m pytest evaluation\test_privacy_scan.py -q
    }
    Invoke-Checked 'frozen deterministic evaluation' {
        & $ServicePython evaluation\run_evaluation.py
    }
    Invoke-Checked 'authoritative client and real loopback HTTP workflow' {
        & node scripts\service-client-http-smoke.mjs
    }
    Invoke-Checked 'strict publication privacy scan' {
        & $ServicePython scripts\privacy-scan.py `
            --root src `
            --root dist\client `
            --root evaluation\artifacts\publication `
            --root evaluation\results.json `
            --root artifacts\verification `
            --canary-manifest evaluation\privacy-canaries.json `
            --output evaluation\privacy-scan-results.json `
            --fail-on-findings
    }
    Invoke-Checked 'README and documentation canary scan' {
        & $ServicePython scripts\privacy-scan.py `
            --root README.md `
            --root docs `
            --canary-manifest evaluation\privacy-canaries.json `
            --output evaluation\privacy-scan-docs-results.json `
            --canaries-only `
            --fail-on-findings
    }
    Invoke-Checked 'workflow YAML parse' {
        & $ServicePython -c "from pathlib import Path; import yaml; yaml.safe_load(Path('.github/workflows/verify.yml').read_text(encoding='utf-8'))"
    }

    [void][scriptblock]::Create((Get-Content -Raw scripts\prepare-canonical-run.ps1))

    Assert-JsonInvariant `
        -Path 'evaluation\results.json' `
        -Check { param($x) $x.fixture_count -eq 16 -and $x.passed_count -eq 16 -and $x.failed_count -eq 0 -and $x.status -eq 'LOCAL_PASS_CANONICAL_INCOMPLETE' } `
        -Message 'Frozen evaluation receipt is not a truthful 16/16 local pass with canonical status incomplete.'
    Assert-JsonInvariant `
        -Path 'evaluation\privacy-scan-results.json' `
        -Check { param($x) $x.status -eq 'PASS' -and $x.finding_count -eq 0 -and $x.skipped_large_file_count -eq 0 -and $x.decode_replacement_count -eq 0 -and $x.unsupported_file_count -eq 5 -and $x.unsupported_extensions.'.jpg' -eq 5 } `
        -Message 'Strict publication scan is not clean or its known binary-image boundary changed.'
    Assert-JsonInvariant `
        -Path 'evaluation\privacy-scan-docs-results.json' `
        -Check { param($x) $x.status -eq 'PASS' -and $x.finding_count -eq 0 -and $x.skipped_large_file_count -eq 0 -and $x.decode_replacement_count -eq 0 -and $x.unsupported_file_count -eq 1 -and $x.unsupported_extensions.'.png' -eq 1 } `
        -Message 'Documentation canary scan is not clean or its known binary-image boundary changed.'
    Assert-JsonInvariant `
        -Path 'artifacts\verification\service-client-http-smoke-receipt.json' `
        -Check { param($x) $x.result -eq 'passed' -and $x.final_state -eq 'CLOSED' -and $x.hash_chain_valid -eq $true -and $x.service_projection_authoritative -eq $true -and $x.inventory_gateway_loopback_http -eq $true -and $x.imported_evidence_count -eq 2 -and $x.imported_evidence_provenance_verified -eq $true -and $x.runtime_role_probe_authenticated -eq $true -and $x.runtime_staff_actor_id -eq 'staff.northport' -and $x.runtime_supervisor_actor_id -eq 'supervisor.northport' -and $x.token_replay_boundary_unchanged -eq $true -and $x.release_task_boundary_unchanged -eq $true -and $x.manifest_internally_consistent -eq $true -and $x.physical_transfer_proven -eq $false -and $x.local_canonical_preparation_verified -eq $true } `
        -Message 'Authoritative client HTTP receipt does not satisfy the full local workflow invariants.'
    Assert-JsonInvariant `
        -Path 'artifacts\verification\inventory-gateway-http-smoke-receipt.json' `
        -Check { param($x) $x.result -eq 'passed' -and $x.transport -eq 'real_loopback_http' -and $x.gateway_mode -eq 'http' -and $x.restricted_fields_included -eq $false -and $x.authorized_candidate_ids.Count -eq 3 -and $x.unauthorized_tenant_denied -eq $true -and $x.unauthorized_candidate_denied -eq $true } `
        -Message 'Inventory gateway did not pass the real loopback HTTP and authorization boundary.'
    Assert-JsonInvariant `
        -Path 'artifacts\verification\local-canonical-preparation-receipt.json' `
        -Check { param($x) $x.schema_version -eq '2' -and $x.status -eq 'PREPARED_FOR_ANALYSIS' -and $x.canonical -eq $false -and -not [string]::IsNullOrWhiteSpace($x.prepared_at) -and $x.preparation_script_sha256 -eq (Get-FileHash -LiteralPath 'scripts\prepare-canonical-run.ps1' -Algorithm SHA256).Hash.ToLowerInvariant() -and $x.case_id -eq 'FR-20260829-0042' -and -not [string]::IsNullOrWhiteSpace($x.workflow_epoch) -and $x.case_state -eq 'RECEIVED' -and $x.analyst_mode -eq 'fixture' -and $x.inventory_mode -eq 'http' -and $x.inventory_gateway_ready -eq $true -and $x.prompt_version -eq 'fixture-no-model' -and $x.output_schema_version -eq 'found-roll-analysis-proposal-v2' -and $x.policy_version -eq 'found-roll-release-v1' -and $x.repository -eq 'memory' -and $x.evidence_store -eq 'memory' -and $x.relay_mode -eq 'http' -and $x.runtime_roles_authenticated -eq $true -and $x.staff_actor_id -eq 'staff.northport' -and $x.supervisor_actor_id -eq 'supervisor.northport' -and $x.evidence.source_file -eq 'pouch-front.jpg' -and $x.evidence.original_sha256 -eq '7eecc012b0f8638fc59f2979ea0cdd3888e6cf5e9659eea2f30f0388bcea6d42' -and $x.evidence.preview_visibility -eq 'MODEL_AUTHORIZED' -and $x.evidence.active_for_analysis -eq $true -and $x.evidence.current_epoch_record_count -eq 2 -and @($x.evidence.active_pair_ids).Count -eq 2 -and $x.evidence.exact_retry_same_pair -eq $true -and $x.evidence.changed_consent_conflict_verified -eq $true -and $x.evidence.changed_consent_conflict_code -eq 'evidence_idempotency_conflict' -and $x.simulator_disclosure -eq 'SIMULATED' } `
        -Message 'Local canonical-preparation rehearsal did not preserve the real HTTP inventory, evidence, and simulator boundaries.'

    $ExpectedAssets = [ordered]@{
        'public\assets\claimant-match.jpg' = @{ Bytes = 303802; Sha256 = 'e5f8f907e9fcc2e21415b41218faea6ef11f783827aa6409aaba32defb6e64ed' }
        'public\assets\northport-intake.jpg' = @{ Bytes = 404870; Sha256 = '460bce72c0d68f8f26ae7f5f4d03b6cfc8975f239815580de511be3933d062ed' }
        'public\assets\pouch-front.jpg' = @{ Bytes = 326943; Sha256 = '7eecc012b0f8638fc59f2979ea0cdd3888e6cf5e9659eea2f30f0388bcea6d42' }
        'public\assets\pouch-interior.jpg' = @{ Bytes = 329913; Sha256 = '5a2dc95289981af12a057c3754d5df6140b67de842dc803a5092f5e9d1fb6b1e' }
        'public\assets\pouch-rear.jpg' = @{ Bytes = 347067; Sha256 = '1768db7c0249316c55877a73d91bd09689118f800e7a40ff339d2cfea6a6b159' }
    }
    foreach ($Entry in $ExpectedAssets.GetEnumerator()) {
        $Asset = Get-Item -LiteralPath $Entry.Key
        $Digest = (Get-FileHash -LiteralPath $Entry.Key -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($Asset.Length -ne $Entry.Value.Bytes -or $Digest -ne $Entry.Value.Sha256) {
            throw "Synthetic asset provenance mismatch: $($Entry.Key)"
        }
    }

    $ArchitectureManifest = Get-Content -Raw docs\architecture-diagram.manifest.json | ConvertFrom-Json
    $ArchitectureSourceHash = (Get-FileHash docs\architecture-diagram.mmd -Algorithm SHA256).Hash.ToLowerInvariant()
    $ArchitectureImageHash = (Get-FileHash docs\architecture-diagram.png -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ArchitectureSourceHash -ne $ArchitectureManifest.source_sha256 -or $ArchitectureImageHash -ne $ArchitectureManifest.render_sha256) {
        throw 'Architecture source or render changed without refreshing its manifest.'
    }

    foreach ($Required in @(
        '.gitattributes',
        '.github\workflows\verify.yml',
        '.dockerignore',
        'Dockerfile',
        'NOTICE.md',
        'THIRD_PARTY_NOTICES.md',
        'deployment\app.py',
        'deployment\serve.py',
        'service\requirements.lock',
        'service\requirements-dev.lock',
        'simulator\requirements.lock',
        'simulator\requirements-dev.lock',
        'dist\client\index.html',
        'artifacts\verification\frontend-build-manifest.json',
        'dist\server\index.js',
        'dist\.openai\hosting.json',
        'public\assets\README.md',
        'docs\architecture.md',
        'docs\architecture-diagram.mmd',
        'docs\architecture-diagram.png',
        'docs\architecture-diagram.manifest.json',
        'docs\demo-script.md',
        'docs\deployment.md',
        'docs\devpost-submission.md',
        'docs\canonical-run.template.json',
        'docs\chain-audit.template.json',
        'docs\canonical-privacy.template.json',
        'docs\clean-browser.template.json',
        'docs\submission-release.template.json',
        'docs\evaluation-plan.md',
        'docs\evaluation.md',
        'docs\threat-and-privacy.md',
        'design-qa.md',
        'artifacts\verification\local-canonical-preparation-receipt.json',
        'scripts\prepare-canonical-run.ps1',
        'scripts\privacy-scan.py',
        'scripts\inventory-gateway-http-smoke.py',
        'scripts\service-client-http-smoke.mjs'
        'scripts\verify-submission-readiness.mjs'
        'tests\submission-readiness.test.mjs'
        'service\app\agent_contract.py'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $Required))) {
            throw "Required local release artifact is missing: $Required"
        }
    }

    Write-Host "`nFound Roll complete local gate passed: production build, tests, real loopback HTTP, publication scans, and artifact integrity. Design screenshots are preserved review evidence, not an automated freshness claim. Google Cloud canonical evidence remains a separate incomplete gate."
} finally {
    Pop-Location
}
