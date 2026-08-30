[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$pluginRoot = Join-Path $repoRoot 'plugin\plugins\codex-skill-organizer'
$marketplacePath = Join-Path $repoRoot 'plugin\marketplace.json'
$securityGatePath = Join-Path $repoRoot 'scripts\security-gate.mjs'
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$runtimeLock = Get-Content -LiteralPath (Join-Path $scriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$globalSdk = (Get-Content -LiteralPath (Join-Path $repoRoot 'global.json') -Raw | ConvertFrom-Json).sdk
if ($runtimeLock.schemaVersion -ne 1 -or $runtimeLock.platform -ne 'win-x64' -or
    $runtimeLock.version -notmatch '^24\.\d+\.\d+$' -or
    $runtimeLock.archiveName -ne "node-v$($runtimeLock.version)-win-x64.zip" -or
    $runtimeLock.url -ne "https://nodejs.org/dist/v$($runtimeLock.version)/node-v$($runtimeLock.version)-win-x64.zip" -or
    $runtimeLock.archiveSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.nodeExeSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.licenseSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.npmVersion -notmatch '^\d+\.\d+\.\d+$' -or
    $runtimeLock.npmCmdSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.npmCliSha256 -notmatch '^[0-9a-f]{64}$') {
    throw 'Pinned Windows Node runtime lock is invalid.'
}
if ($globalSdk.version -notmatch '^\d+\.\d+\.\d+$' -or $globalSdk.rollForward -ne 'disable' -or
    $globalSdk.allowPrerelease -ne $false) {
    throw 'global.json does not pin an exact stable .NET SDK.'
}
if ((& node --version).Trim() -ne "v$($runtimeLock.version)" -or (& npm.cmd --version).Trim() -ne $runtimeLock.npmVersion) {
    throw 'Release scaffold tests must run on the pinned Node.js and npm versions.'
}
if ($package.scripts.'check:version' -ne 'node scripts/version-contract.mjs --check' -or
    $package.scripts.'check:security' -ne 'node scripts/security-gate.mjs --repository-root . --plugin-root plugin/plugins/codex-skill-organizer --marketplace-root plugin' -or
    $package.scripts.'version:sync' -ne 'node scripts/version-contract.mjs --write' -or
    -not ([string]$package.scripts.check).StartsWith('npm run check:version && npm run check:security && ')) {
    throw 'package.json does not make the version and repository security contracts part of ordinary checks.'
}
if ($package.scripts.'test:path-probe:windows' -ne 'tsx --test --test-concurrency=1 tests/windows-path-probe.test.ts') {
    throw 'package.json must keep the real Windows path probe isolated and serial.'
}
if ($package.scripts.'test:health-probe:windows' -ne 'tsx --test --test-concurrency=1 tests/server-data-directory.test.ts') {
    throw 'package.json must keep the real Windows health transport isolated and serial.'
}
& node (Join-Path $repoRoot 'scripts\version-contract.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Repository product version derivatives are stale.' }
if (-not (Test-Path -LiteralPath $securityGatePath -PathType Leaf)) {
    throw 'Deterministic repository security gate is missing.'
}
& node $securityGatePath `
    --repository-root $repoRoot `
    --plugin-root $pluginRoot `
    --marketplace-root (Split-Path -Parent $marketplacePath)
if ($LASTEXITCODE -ne 0) { throw 'Repository or plugin publication security validation failed.' }

$attributesText = Get-Content -LiteralPath (Join-Path $repoRoot '.gitattributes') -Raw
foreach ($requiredAttribute in @('* text=auto eol=lf', '*.cmd text eol=lf', '*.ps1 text eol=lf', '*.ico binary', '*.exe binary')) {
    if (-not $attributesText.Contains($requiredAttribute)) { throw "Missing deterministic Git attribute: $requiredAttribute" }
}
$desktopProjectText = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop\SkillOrganizerForCodex.Desktop.csproj') -Raw
foreach ($requiredProjectSetting in @(
    '<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>',
    '<RestoreLockedMode>true</RestoreLockedMode>',
    '<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>',
    '<Deterministic>true</Deterministic>',
    '<DebugType>none</DebugType>',
    '<PathMap>$(MSBuildProjectDirectory)=/_/desktop</PathMap>'
)) {
    if (-not $desktopProjectText.Contains($requiredProjectSetting)) { throw "Desktop reproducibility setting is missing: $requiredProjectSetting" }
}
if ($desktopProjectText -match '<(?:Version|AssemblyVersion|FileVersion)>') {
    throw 'The desktop project duplicates the package.json product version.'
}
$nugetLock = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop\packages.lock.json') -Raw | ConvertFrom-Json
$lockedLibraries = @(
    foreach ($target in $nugetLock.dependencies.PSObject.Properties) {
        $target.Value.PSObject.Properties.Name
    }
) | Select-Object -Unique
foreach ($requiredLibrary in @('Microsoft.Web.WebView2', 'Microsoft.NET.ILLink.Tasks')) {
    if ($requiredLibrary -notin $lockedLibraries) { throw "NuGet lock omits $requiredLibrary." }
}
if (-not (Test-Path -LiteralPath (Join-Path $scriptRoot 'Test-DeterministicDesktopPublish.ps1') -PathType Leaf)) {
    throw 'Cross-path deterministic desktop publish test is missing.'
}
$failingHealthFixture = Join-Path $repoRoot 'installer\TestFixtures\FailingHealthCheck\FailingHealthCheck.csproj'
if (-not (Test-Path -LiteralPath $failingHealthFixture -PathType Leaf)) {
    throw 'Deterministic failing-health upgrade fixture is missing.'
}
$installerMatrixFixture = Join-Path $repoRoot 'installer\TestFixtures\InstallerMatrix\Invoke-InstallerMatrix.ps1'
if (-not (Test-Path -LiteralPath $installerMatrixFixture -PathType Leaf)) {
    throw 'Isolated installer transaction and selection matrix fixture is missing.'
}
$installerMatrixText = Get-Content -LiteralPath $installerMatrixFixture -Raw
$installerMatrixTokens = $null
$installerMatrixParseErrors = $null
$installerMatrixAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $installerMatrixFixture,
    [ref]$installerMatrixTokens,
    [ref]$installerMatrixParseErrors)
if ($installerMatrixParseErrors.Count -ne 0) {
    throw "Installer matrix fixture does not parse: $($installerMatrixParseErrors[0].Message)"
}
$installerMatrixExitStatements = @($installerMatrixAst.FindAll({
    param($Node)
    $Node -is [System.Management.Automation.Language.ExitStatementAst]
}, $true))
if ($installerMatrixExitStatements.Count -ne 0) {
    throw 'Installer matrix must return to its caller; an exit statement would terminate the shared release PowerShell host.'
}
$releaseWorkflowPath = Join-Path $repoRoot '.github\workflows\release.yml'
$releaseWorkflowText = Get-Content -LiteralPath $releaseWorkflowPath -Raw
$maintenanceShutdownProbePath = Join-Path $scriptRoot 'Invoke-InstalledServiceMaintenanceShutdown.ps1'
$maintenanceShutdownProbeText = Get-Content -LiteralPath $maintenanceShutdownProbePath -Raw
$probeTokens = $null
$probeParseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile(
    $maintenanceShutdownProbePath,
    [ref]$probeTokens,
    [ref]$probeParseErrors)
if ($probeParseErrors.Count -ne 0) {
    throw 'Installed service maintenance shutdown probe is not valid PowerShell.'
}
$workflowLimitCheck = @'
const fs = require('node:fs');
const YAML = require('yaml');
const document = YAML.parse(fs.readFileSync(process.argv[1], 'utf8'));
let exceeded = false;
function visit(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'run' && typeof child === 'string' && child.length > 20500) exceeded = true;
    visit(child);
  }
}
visit(document);
if (exceeded) process.exit(1);
'@
& node -e $workflowLimitCheck $releaseWorkflowPath
if ($LASTEXITCODE -ne 0) {
    throw 'A GitHub Actions run block exceeds the guarded 20,500-character limit.'
}
$ciWorkflowText = Get-Content -LiteralPath (Join-Path $repoRoot '.github\workflows\ci.yml') -Raw
foreach ($workflowEntry in @(
    [pscustomobject]@{ Name = 'CI'; Text = $ciWorkflowText },
    [pscustomobject]@{ Name = 'Release'; Text = $releaseWorkflowText }
)) {
    foreach ($pathProbeInvariant in @(
        'Verify real Windows drive probe in isolation',
        "CSO_RUN_REAL_WINDOWS_PATH_PROBE: '1'",
        'run: npm run test:path-probe:windows',
        'Verify real Windows health transport in isolation',
        "CSO_RUN_REAL_WINDOWS_HEALTH_PROBE: '1'",
        'run: npm run test:health-probe:windows'
    )) {
        if (-not $workflowEntry.Text.Contains($pathProbeInvariant)) {
            throw "$($workflowEntry.Name) workflow omits the isolated real Windows path probe: $pathProbeInvariant"
        }
    }
}
$tagPublishCondition = 'if: ${{ github.event_name == ''push'' && startsWith(github.ref, ''refs/tags/v'') }}'
if ([regex]::Matches($releaseWorkflowText, [regex]::Escape($tagPublishCondition)).Count -ne 3) {
    throw 'Manual release workflow runs must never stage notes or enter the publish job, including when dispatched from a tag.'
}
foreach ($releaseIdentityInvariant in @(
    'source_sha: ${{ steps.release.outputs.source_sha }}',
    '"source_sha=$($env:GITHUB_SHA.ToLowerInvariant())" >> $env:GITHUB_OUTPUT',
    'BUILT_SOURCE_SHA: ${{ needs.build-and-smoke.outputs.source_sha }}',
    '$refJson = & gh api --method GET "repos/$Repository/git/ref/tags/$encodedTag"',
    '$tagJson = & gh api --method GET "repos/$Repository/git/tags/$objectSha"',
    'if ($resolvedCommit -ne $BuiltSourceSha)',
    'Release tag moved after build:'
)) {
    if (-not $releaseWorkflowText.Contains($releaseIdentityInvariant)) {
        throw "Release workflow source/tag identity gate is missing: $releaseIdentityInvariant"
    }
}
$tagMatchInvocation = 'Assert-RemoteTagMatchesBuild -Tag $tag -Repository $repository -BuiltSourceSha $builtSourceSha'
if ([regex]::Matches($releaseWorkflowText, [regex]::Escape($tagMatchInvocation)).Count -ne 3) {
    throw 'Release workflow must verify the tag before draft creation, after asset upload, and after publication.'
}
$draftCreateIndex = $releaseWorkflowText.IndexOf('& gh release create $tag', [StringComparison]::Ordinal)
$firstTagCheckIndex = $releaseWorkflowText.IndexOf($tagMatchInvocation, [StringComparison]::Ordinal)
$assetUploadIndex = $releaseWorkflowText.IndexOf('& gh release upload $tag @releaseFiles', $draftCreateIndex, [StringComparison]::Ordinal)
$prePublishTagCheckIndex = $releaseWorkflowText.IndexOf($tagMatchInvocation, $assetUploadIndex, [StringComparison]::Ordinal)
$publishDraftIndex = $releaseWorkflowText.IndexOf('& gh release edit $tag --repo $repository --draft=false', $prePublishTagCheckIndex, [StringComparison]::Ordinal)
$postPublishTagCheckIndex = $releaseWorkflowText.IndexOf($tagMatchInvocation, $publishDraftIndex, [StringComparison]::Ordinal)
$cleanupReleaseIndex = $releaseWorkflowText.IndexOf('& gh release delete $tag --repo $repository --yes', $postPublishTagCheckIndex, [StringComparison]::Ordinal)
if ($firstTagCheckIndex -lt 0 -or $draftCreateIndex -le $firstTagCheckIndex -or $assetUploadIndex -le $draftCreateIndex -or
    $prePublishTagCheckIndex -le $assetUploadIndex -or $publishDraftIndex -le $prePublishTagCheckIndex -or
    $postPublishTagCheckIndex -le $publishDraftIndex -or $cleanupReleaseIndex -le $postPublishTagCheckIndex) {
    throw 'Release workflow must upload only to a draft, reverify before and after publication, and clean an incomplete Release on failure.'
}
$draftCreateBlock = $releaseWorkflowText.Substring($draftCreateIndex, $assetUploadIndex - $draftCreateIndex)
if (-not $draftCreateBlock.Contains('--draft') -or $releaseWorkflowText.Contains('--cleanup-tag')) {
    throw 'Release workflow must create a draft and preserve the investigated tag during rollback.'
}
foreach ($rollbackSmokeInvariant in @(
    'Publish deterministic failing-health upgrade fixture',
    '$initialInstallLog = Join-Path $env:RUNNER_TEMP ''cso-initial-install.log''',
    '$initialInstallArgs = "$installArgs /LOG=`"$initialInstallLog`""',
    'SETUP-DIAGNOSTIC:',
    'INSTALLED-LAUNCHER-DIAGNOSTIC: pointerValid=$pointerValid hashesEqual=$launcherHashesEqual',
    'INSTALLED-HEALTH-DIAGNOSTIC: directExitCode=$($directHealthProcess.ExitCode) stableExitCode=$($stableHealthProcess.ExitCode)',
    'if ($directHealthProcess.ExitCode -ne 0 -or $stableHealthProcess.ExitCode -ne 0)',
    '$seedProcess = Start-Process -FilePath $stableLauncher -ArgumentList @(''--headless'', ''--ensure-service'') -PassThru -WindowStyle Hidden',
    'if (-not $seedProcess.WaitForExit(60000))',
    '$seedProcess.Kill($true)',
    '$seedProcess.WaitForExit(5000) | Out-Null',
    'if ($seedProcess.ExitCode -ne 0)',
    '$seedProcess.Dispose()',
    '& ./scripts/release/Invoke-InstalledServiceMaintenanceShutdown.ps1',
    '-DataRoot $dataRoot',
    '-VersionRoot $versionRoot',
    '-ExpectedVersion $version',
    '-StableLauncher $stableLauncher',
    'if (-not $?) { exit 1 }',
    '$rollbackHealthProcess = Start-Process -FilePath $stableLauncher -ArgumentList ''--health-check'' -Wait -PassThru -WindowStyle Hidden',
    'if ($rollbackHealthProcess.ExitCode -ne 0)',
    '$portableHealthProcess = Start-Process -FilePath (Join-Path $portableRoot ''SkillOrganizerForCodex.exe'') -ArgumentList ''--health-check'' -Wait -PassThru -WindowStyle Hidden',
    'if ($portableHealthProcess.ExitCode -ne 0)',
    '$fixtureHealthProcess = Start-Process',
    'if ($fixtureHealthProcess.ExitCode -ne 71)',
    '$faultHealthProcess = Start-Process',
    'if ($faultHealthProcess.ExitCode -ne 71)',
    '$faultVersion = "$($versionMatch.Groups[1].Value).$($versionMatch.Groups[2].Value).$([int]$versionMatch.Groups[3].Value + 1)-health-failure-fixture"',
    'if ($faultProcess.ExitCode -ne 7)',
    "Assert-LogCount `$faultLogText 'Starting the installation process' 0",
    "throw 'A single failing-health preflight did not create exactly one verified database snapshot.'",
    '-Mode Transaction',
    '-Mode Selection',
    '-VersionPayloadRoot $payloadRoot',
    "throw 'Clean first-install preflight failure created the program root.'",
    "throw 'Clean first-install preflight failure created a shortcut.'",
    "throw 'Clean first-install preflight failure created an uninstall registration.'",
    '$cleanFaultResultPath = Join-Path $dataRoot ''upgrade-backup-result.json''',
    "throw 'Clean first-install preflight created unexpected persistent Organizer data.'",
    '[IO.Directory]::Delete($dataRoot, $false)'
)) {
    if (-not $releaseWorkflowText.Contains($rollbackSmokeInvariant)) {
        throw "Release workflow upgrade-rollback smoke is missing: $rollbackSmokeInvariant"
    }
}
$maintenanceShutdownInvocation = @'
& ./scripts/release/Invoke-InstalledServiceMaintenanceShutdown.ps1 `
            -DataRoot $dataRoot `
            -VersionRoot $versionRoot `
            -ExpectedVersion $version `
            -StableLauncher $stableLauncher
          if (-not $?) { exit 1 }
'@
if ([regex]::Matches(
        $releaseWorkflowText,
        [regex]::Escape($maintenanceShutdownInvocation.Trim())).Count -ne 1) {
    throw 'Release workflow must fail the outer GitHub step immediately when the maintenance shutdown probe exits nonzero.'
}
$bundledHealthTransportInvariants = @(
    'Verify bundled internal-health transport',
    'TEMP-IDENTITY: spellingEqual=',
    '$startInfo.Environment[''CSO_DESKTOP_PID''] = [string]$PID',
    '$startInfo.Environment[''CSO_INTERNAL_HEALTH_DATA_ROOT''] = $healthRoot',
    '$startInfo.Environment[''CSO_INTERNAL_HEALTH_PARENT_PID''] = [string]$PID',
    '$startInfo.Environment[''TEMP''] = $dotnetTemp',
    '$startInfo.Environment[''TMP''] = $dotnetTemp',
    '$startInfo.RedirectStandardError = $true',
    '$startInfo.ArgumentList.Add($serverPath)',
    '$startInfo.ArgumentList.Add(''--internal-health-check'')',
    "'data-root-unc-rejected'",
    "'data-root-parent-rejected'",
    "'data-root-id-rejected'",
    'BUNDLED-HEALTH-DIAGNOSTIC: category=',
    'if ([int]$descriptor.pid -ne $healthProcess.Id',
    '$descriptor.host -ne ''127.0.0.1''',
    '$descriptor.version -ne $version',
    '$healthProcess.Kill($true)',
    '$healthProcess.WaitForExit(5000)',
    '$healthProcess.Dispose()',
    '$parsedHealthId = [Guid]::Empty',
    '[Guid]::TryParseExact([IO.Path]::GetFileName($validatedRoot), ''N'', [ref]$parsedHealthId)',
    '[IO.Directory]::Delete($validatedRoot, $true)'
)
foreach ($bundledHealthTransportInvariant in $bundledHealthTransportInvariants) {
    if (-not $releaseWorkflowText.Contains($bundledHealthTransportInvariant)) {
        throw "Release workflow bundled internal-health transport check is missing: $bundledHealthTransportInvariant"
    }
}
if ($maintenanceShutdownProbeText -match '(?im)(?:Write-(?:Host|Output|Error|Warning|Verbose|Debug)|Out-File|Add-Content|Set-Content)[^\r\n]*\$(?:stderrText|shutdownErrorText)') {
    throw 'Release workflow must not print raw service stderr into the public Actions log.'
}
$serviceDiagnosticLine = 'Write-Host "INSTALLED-SERVICE-DIAGNOSTIC: phase=$phase descriptorFiles=$($diagnostic.DescriptorFileCount) parsed=$($diagnostic.ParsedDescriptorCount) valid=$($diagnostic.ValidDescriptorCount) descriptorReadFailed=$($diagnostic.DescriptorReadFailed) boundaryValid=$($diagnostic.BoundaryValid) versionMatches=$($diagnostic.VersionMatches) protocolCompatible=$($diagnostic.ProtocolCompatible) installRootMatches=$($diagnostic.InstallRootMatches) expectedNodeExists=$($diagnostic.ExpectedNodeExists) pidAlive=$($diagnostic.PidAlive) processPathReadable=$($diagnostic.ProcessPathReadable) processInspectionFailed=$($diagnostic.ProcessInspectionFailed) lexicalPathMatches=$($diagnostic.LexicalPathMatches) hashReadFailed=$($diagnostic.HashReadFailed) expectedContainsTilde=$($diagnostic.ExpectedNodeContainsTilde) processContainsTilde=$($diagnostic.ProcessPathContainsTilde) hashMatches=$($diagnostic.ProcessHashMatches)"'
$shutdownDiagnosticLine = 'Write-Host "INSTALLED-SHUTDOWN-DIAGNOSTIC: stage=$safeShutdownStage category=$safeShutdownCategory exitCode=$safeShutdownExitCode"'
if ([regex]::Matches($maintenanceShutdownProbeText, [regex]::Escape($serviceDiagnosticLine)).Count -ne 1 -or
    [regex]::Matches($maintenanceShutdownProbeText, [regex]::Escape($shutdownDiagnosticLine)).Count -ne 1 -or
    [regex]::Matches($maintenanceShutdownProbeText, 'INSTALLED-SERVICE-DIAGNOSTIC:').Count -ne 1 -or
    [regex]::Matches($maintenanceShutdownProbeText, 'INSTALLED-SHUTDOWN-DIAGNOSTIC:').Count -ne 1) {
    throw 'Release workflow service diagnostics must use the fixed safe scalar field allowlist exactly once.'
}
$shutdownDiagnosticIndex = $maintenanceShutdownProbeText.IndexOf($shutdownDiagnosticLine, [StringComparison]::Ordinal)
$shutdownFailureIndex = $maintenanceShutdownProbeText.LastIndexOf('if ($shutdownControlFailed -or $shutdownTimedOut -or $shutdownExitCode -ne 0 -or', $shutdownDiagnosticIndex, [StringComparison]::Ordinal)
$shutdownExitIndex = $maintenanceShutdownProbeText.IndexOf('exit 1', $shutdownDiagnosticIndex, [StringComparison]::Ordinal)
if ($shutdownFailureIndex -lt 0 -or $shutdownDiagnosticIndex -le $shutdownFailureIndex -or $shutdownExitIndex -le $shutdownDiagnosticIndex) {
    throw 'Release workflow shutdown diagnostics must remain inside the fail-closed nonzero-exit branch.'
}
$shutdownSuccessExit = 'exit 0'
if ([regex]::Matches($maintenanceShutdownProbeText, '(?m)^exit 0$').Count -ne 1 -or
    $maintenanceShutdownProbeText.IndexOf($shutdownSuccessExit, $shutdownExitIndex, [StringComparison]::Ordinal) -le $shutdownExitIndex -or
    -not $maintenanceShutdownProbeText.TrimEnd().EndsWith($shutdownSuccessExit, [StringComparison]::Ordinal)) {
    throw 'Installed service maintenance shutdown probe must return an explicit zero exit code only after the fail-closed branch.'
}
$shutdownFailureBlock = $maintenanceShutdownProbeText.Substring($shutdownFailureIndex, $shutdownExitIndex - $shutdownFailureIndex)
if ($shutdownFailureBlock.Contains('throw ') -or
    $shutdownFailureBlock -match '(?i)\$(?:shutdownErrorText|descriptor|actualProcessPath|expectedNodePath|dataRoot|productRoot|versionRoot|stableLauncher|shutdownErrorPath|env:USERNAME|env:USERPROFILE|env:HOME|env:LOCALAPPDATA)\b' -or
    $shutdownFailureBlock -match '(?i)(?:Exception\.Message|\.ToString\(|ConvertTo-Json|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT)') {
    throw 'Release workflow shutdown failure diagnostics must not expose raw errors, descriptor values, or local paths.'
}
$safeShutdownErrorUses = @(
    '$shutdownErrorText = ''''',
    '$shutdownErrorText = [string](Get-Content -LiteralPath $shutdownErrorPath -Raw -ErrorAction Stop)',
    '[string]::IsNullOrWhiteSpace($shutdownErrorText)',
    '$shutdownErrorText.Contains(''outside the installed product boundary'')',
    '$shutdownErrorText.Contains(''PID is not the bundled Organizer runtime'')',
    '$shutdownErrorText -match ''(?i)access.+denied|denied.+access|拒绝访问'''
)
foreach ($safeShutdownErrorUse in $safeShutdownErrorUses) {
    if ([regex]::Matches($maintenanceShutdownProbeText, [regex]::Escape($safeShutdownErrorUse)).Count -ne 1) {
        throw "Release workflow raw shutdown stderr is not confined to its fixed local classification use: $safeShutdownErrorUse"
    }
}
if ([regex]::Matches($maintenanceShutdownProbeText, '\$shutdownErrorText\b').Count -ne $safeShutdownErrorUses.Count -or
    [regex]::Matches($maintenanceShutdownProbeText, 'Get-Content -LiteralPath \$shutdownErrorPath').Count -ne 1) {
    throw 'Release workflow raw shutdown stderr must not be copied, aliased, or read through another path.'
}
$shutdownEmptyCheckIndex = $maintenanceShutdownProbeText.IndexOf('[string]::IsNullOrWhiteSpace($shutdownErrorText)', [StringComparison]::Ordinal)
$shutdownContainsIndex = $maintenanceShutdownProbeText.IndexOf('$shutdownErrorText.Contains(', [StringComparison]::Ordinal)
if ($shutdownEmptyCheckIndex -lt 0 -or $shutdownContainsIndex -le $shutdownEmptyCheckIndex) {
    throw 'Release workflow must normalize and reject empty shutdown stderr before fixed-message classification.'
}
$beforeDiagnosticCall = "Write-InstalledServiceDiagnostic 'before' `$beforeShutdownDiagnostic"
$afterDiagnosticCall = "Write-InstalledServiceDiagnostic 'after' `$afterShutdownDiagnostic"
if ([regex]::Matches($maintenanceShutdownProbeText, [regex]::Escape($beforeDiagnosticCall)).Count -ne 1 -or
    [regex]::Matches($maintenanceShutdownProbeText, [regex]::Escape($afterDiagnosticCall)).Count -ne 1 -or
    [regex]::Matches($maintenanceShutdownProbeText, 'Write-InstalledServiceDiagnostic\b').Count -ne 3) {
    throw 'Release workflow service diagnostic phases must remain the fixed before/after calls.'
}
foreach ($shutdownPostconditionInvariant in @(
    '$observedProcessIds = @($beforeShutdownDiagnostic.ProcessIds)',
    '$observedProcessesExited = Test-ObservedProcessesExited $observedProcessIds',
    '$descriptorFilesRemoved = $afterShutdownDiagnostic.DescriptorFileCount -eq 0',
    '-not $observedProcessesExited -or -not $descriptorFilesRemoved'
)) {
    if (-not $maintenanceShutdownProbeText.Contains($shutdownPostconditionInvariant)) {
        throw "Release smoke must prove the seeded process exited and its descriptor was removed: $shutdownPostconditionInvariant"
    }
}
if ([regex]::Matches($maintenanceShutdownProbeText, '\bProcessIds\b').Count -ne 2 -or
    $serviceDiagnosticLine.Contains('ProcessIds') -or
    $shutdownDiagnosticLine.Contains('ProcessIds')) {
    throw 'Release smoke may retain observed process IDs only for private postcondition checks, never public diagnostics.'
}
$shutdownErrorPathDeclaration = '$shutdownErrorPath = Join-Path $env:RUNNER_TEMP'
$shutdownErrorPathIndex = $maintenanceShutdownProbeText.IndexOf($shutdownErrorPathDeclaration, [StringComparison]::Ordinal)
$shutdownStartIndex = $maintenanceShutdownProbeText.IndexOf('$shutdownProcess = Start-Process', $shutdownErrorPathIndex, [StringComparison]::Ordinal)
$shutdownTryIndex = $maintenanceShutdownProbeText.LastIndexOf('try {', $shutdownStartIndex, [StringComparison]::Ordinal)
$shutdownFinallyIndex = $maintenanceShutdownProbeText.IndexOf('finally {', $shutdownStartIndex, [StringComparison]::Ordinal)
$shutdownDisposeIndex = $maintenanceShutdownProbeText.IndexOf('$shutdownProcess.Dispose()', $shutdownFinallyIndex, [StringComparison]::Ordinal)
$shutdownRemoveIndex = $maintenanceShutdownProbeText.IndexOf('Remove-Item -LiteralPath $shutdownErrorPath -Force -ErrorAction SilentlyContinue', $shutdownFinallyIndex, [StringComparison]::Ordinal)
$shutdownStageIndex = $maintenanceShutdownProbeText.IndexOf('$shutdownStage = if', $shutdownRemoveIndex, [StringComparison]::Ordinal)
if ($shutdownErrorPathIndex -lt 0 -or $shutdownTryIndex -le $shutdownErrorPathIndex -or
    $shutdownStartIndex -le $shutdownTryIndex -or $shutdownFinallyIndex -le $shutdownStartIndex -or
    $shutdownDisposeIndex -le $shutdownFinallyIndex -or $shutdownRemoveIndex -le $shutdownDisposeIndex -or
    $shutdownStageIndex -le $shutdownRemoveIndex -or
    [regex]::Matches($maintenanceShutdownProbeText, '\$shutdownErrorPath\b').Count -ne 5) {
    throw 'Release workflow must dispose the shutdown launcher and delete raw stderr in one outer finally block.'
}
if ([regex]::Matches($shutdownFailureBlock, '(?im)^\s*Write-Host\b').Count -ne 2 -or
    [regex]::Matches($shutdownFailureBlock, '(?im)^\s*Write-InstalledServiceDiagnostic\b').Count -ne 1 -or
    $shutdownFailureBlock -match '(?im)^\s*(?:Write-(?:Output|Error|Warning|Information|Verbose|Debug)|Out-Host|Out-File|Tee-Object|Add-Content|Set-Content)\b') {
    throw 'Release workflow shutdown failure branch may emit only the two fixed host lines and one safe scalar snapshot.'
}
$safeStageBlock = @'
$safeShutdownStage = switch ([string]$shutdownStage) {
    'process-control' { 'process-control' }
    'timeout' { 'timeout' }
    'verification' { 'verification' }
    'maintenance' { 'maintenance' }
    'stable-forwarding' { 'stable-forwarding' }
    default { 'unexpected' }
}
'@
$safeCategoryBlock = @'
$safeShutdownCategory = switch ([string]$shutdownCategory) {
    'process-control-failed' { 'process-control-failed' }
    'timeout' { 'timeout' }
    'process-still-running' { 'process-still-running' }
    'descriptor-still-present' { 'descriptor-still-present' }
    'success' { 'success' }
    'stderr-read-failed' { 'stderr-read-failed' }
    'no-stderr' { 'no-stderr' }
    'install-root-boundary-rejected' { 'install-root-boundary-rejected' }
    'runtime-process-boundary-rejected' { 'runtime-process-boundary-rejected' }
    'process-access-denied' { 'process-access-denied' }
    default { 'unclassified' }
}
'@
$safeExitBlock = @'
$safeShutdownExitCode = if ($shutdownExitCode -is [int]) {
    [int]$shutdownExitCode
} elseif ($shutdownExitCode -eq '<timeout>') {
    '<timeout>'
} else {
    '<unavailable>'
}
'@
if (-not $maintenanceShutdownProbeText.Contains($safeStageBlock.Trim()) -or
    -not $maintenanceShutdownProbeText.Contains($safeCategoryBlock.Trim()) -or
    -not $maintenanceShutdownProbeText.Contains($safeExitBlock.Trim()) -or
    [regex]::Matches($maintenanceShutdownProbeText, '\$safeShutdownStage\b').Count -ne 2 -or
    [regex]::Matches($maintenanceShutdownProbeText, '\$safeShutdownCategory\b').Count -ne 2 -or
    [regex]::Matches($maintenanceShutdownProbeText, '\$safeShutdownExitCode\b').Count -ne 2) {
    throw 'Release workflow must narrow shutdown stage, category, and exit code to fixed safe scalar values immediately before logging.'
}
$expectedHealthProbeArguments = "-ArgumentList '--health-check' -Wait -PassThru -WindowStyle Hidden"
if ([regex]::Matches($releaseWorkflowText, [regex]::Escape($expectedHealthProbeArguments)).Count -ne 6) {
    throw 'Release health probes must wait for the hidden child process and inspect their exit codes explicitly.'
}
if ($releaseWorkflowText.Contains('& $stableLauncher --') -or
    $releaseWorkflowText.Contains('& (Join-Path $portableRoot ''SkillOrganizerForCodex.exe'') --') -or
    $installerMatrixText.Contains('& $stableLauncher --')) {
    throw 'Windows GUI launchers must use Start-Process and an explicit wait before their exit codes are inspected.'
}
if ($releaseWorkflowText.Contains('$seedProcess = Start-Process -FilePath $stableLauncher -ArgumentList @(''--headless'', ''--ensure-service'') -Wait')) {
    throw 'The service seed must wait only for the direct launcher because the backend child is intentionally retained.'
}
foreach ($matrixInvariant in @(
    "if (`$env:GITHUB_ACTIONS -ne 'true')",
    "[ValidateSet('Transaction', 'Selection')]",
    "'/DTestActivationFault=1'",
    "Compile-ActivationFaultInstaller `$Version 'same-version'",
    '$newVersion = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)-activation-fixture"',
    '$sameLogText = Invoke-Setup $sameVersionFaultSetup "$silentBase /TYPE=desktop /COMPONENTS=workbench" 70 $sameLog',
    '$newLogText = Invoke-Setup $newVersionFaultSetup "$silentBase /TYPE=desktop /COMPONENTS=workbench" 70 $newLog',
    '$cleanLogText = Invoke-Setup $newVersionFaultSetup "$silentBase /TYPE=full" 70 $cleanLog',
    '$baselineHealthProcess = Start-Process -FilePath $stableLauncher -ArgumentList ''--health-check'' -Wait -PassThru -WindowStyle Hidden',
    'if ($baselineHealthProcess.ExitCode -ne 0)',
    '$reinstalledHealthProcess = Start-Process -FilePath $stableLauncher -ArgumentList ''--health-check'' -Wait -PassThru -WindowStyle Hidden',
    'if ($reinstalledHealthProcess.ExitCode -ne 0)',
    'Same-version activation rollback did not restore the complete install state byte-for-byte.',
    'Old-to-new activation rollback did not restore the complete install state byte-for-byte.',
    'Clean first-install activation rollback did not restore the absent program, registry, shortcut, plugin, and marketplace state.',
    "[pscustomobject]@{ Name = 'type-desktop'; Arguments = '/TYPE=desktop'; Plugin = `$false }",
    "[pscustomobject]@{ Name = 'type-full'; Arguments = '/TYPE=full'; Plugin = `$true }",
    "Arguments = '/TYPE=custom /COMPONENTS=workbench'",
    "Arguments = '/TYPE=custom /COMPONENTS=workbench,codexplugin'",
    'SetupType=custom',
    'Components=workbench,codexplugin',
    'Preserving the explicit command-line or answer-file component selection.',
    '$noCodexLogText = Invoke-Setup $SetupPath $silentBase 0 $noCodexLog',
    'Uninstall accepted a product-root junction.',
    'Uninstall accepted an Organizer data-root junction.',
    'Marker commit failure did not restore the exact pre-upgrade managed plugin.',
    'Marker commit failure did not restore the exact pre-upgrade marketplace.'
)) {
    if (-not $installerMatrixText.Contains($matrixInvariant)) {
        throw "Installer matrix fixture is missing: $matrixInvariant"
    }
}

$buildReleaseCommand = Get-Command -Name (Join-Path $scriptRoot 'Build-Release.ps1')
foreach ($parameterName in @('Version', 'DesktopPayloadDirectory', 'NodeRuntimeDirectory')) {
    $mandatory = @($buildReleaseCommand.Parameters[$parameterName].Attributes | Where-Object {
        $_ -is [System.Management.Automation.ParameterAttribute] -and $_.Mandatory
    })
    if ($mandatory.Count -ne 0) {
        throw "npm run build:release cannot use a mandatory $parameterName parameter."
    }
}
if ($package.scripts.'build:release' -ne 'pwsh -NoProfile -File scripts/release/Build-Release.ps1') {
    throw 'package.json build:release must use the no-argument release entry point.'
}
if (-not (Test-Path -LiteralPath (Join-Path $scriptRoot 'Test-ReleaseOutput.ps1') -PathType Leaf)) {
    throw 'Release output validator is missing.'
}
$buildReleaseText = Get-Content -LiteralPath (Join-Path $scriptRoot 'Build-Release.ps1') -Raw
foreach ($releaseInvariant in @(
    '& $nodeNpm ci',
    'scripts\version-contract.mjs',
    'product-version.json',
    'skill-organizer-version',
    '--desktop-assets',
    '--dotnet-sdk-version',
    'CONTENT-MANIFEST-version-full-$Version.json'
)) {
    if (-not $buildReleaseText.Contains($releaseInvariant)) { throw "Release reproducibility contract is missing: $releaseInvariant" }
}
$backupStateHelper = Join-Path $repoRoot 'scripts\runtime\backup-state.mjs'
if (-not (Test-Path -LiteralPath $backupStateHelper -PathType Leaf)) {
    throw 'SQLite upgrade-backup helper is missing.'
}

$pluginValidatorPath = Join-Path $scriptRoot 'Validate-Plugin.ps1'
$pluginValidatorText = Get-Content -LiteralPath $pluginValidatorPath -Raw
foreach ($securityInvariant in @('security-gate.mjs', '--plugin-root', '--marketplace-root')) {
    if (-not $pluginValidatorText.Contains($securityInvariant)) {
        throw "Plugin validator does not enforce the exact publish allowlist: $securityInvariant"
    }
}
& $pluginValidatorPath `
    -PluginRoot $pluginRoot `
    -MarketplacePath $marketplacePath `
    -ExpectedVersion $package.version

$rootIconHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'assets\skill-organizer.svg') -Algorithm SHA256).Hash
$pluginIconHash = (Get-FileHash -LiteralPath (Join-Path $pluginRoot 'assets\skill-organizer.svg') -Algorithm SHA256).Hash
if ($rootIconHash -ne $pluginIconHash) { throw 'Root and plugin icons diverged.' }
$iconText = Get-Content -LiteralPath (Join-Path $repoRoot 'assets\skill-organizer.svg') -Raw
if ($iconText -match '(?i)openai') { throw 'The original icon must not contain OpenAI branding.' }
$iconBuilder = Join-Path $repoRoot 'scripts\build-icon.mjs'
$desktopIcon = Join-Path $repoRoot 'desktop\Assets\app.ico'
& node $iconBuilder
if ($LASTEXITCODE -ne 0) { throw 'Reproducible Windows icon generation failed.' }
$firstIconHash = (Get-FileHash -LiteralPath $desktopIcon -Algorithm SHA256).Hash
& node $iconBuilder
if ($LASTEXITCODE -ne 0) { throw 'Second reproducible Windows icon generation failed.' }
if ((Get-FileHash -LiteralPath $desktopIcon -Algorithm SHA256).Hash -ne $firstIconHash) {
    throw 'Windows icon generation is not byte-for-byte reproducible.'
}
$iconBytes = [System.IO.File]::ReadAllBytes($desktopIcon)
if ($iconBytes.Length -lt 6 -or $iconBytes[0] -ne 0 -or $iconBytes[1] -ne 0 -or
    $iconBytes[2] -ne 1 -or $iconBytes[3] -ne 0 -or $iconBytes[4] -ne 7 -or $iconBytes[5] -ne 0) {
    throw 'Generated desktop icon is not the expected seven-image ICO.'
}

$installerText = Get-Content -LiteralPath (Join-Path $repoRoot 'installer\SkillOrganizerForCodex.iss') -Raw
$installerInvariants = @(
    'PrivilegesRequired=lowest',
    'ArchitecturesAllowed=x64compatible',
    'VersionPayloadRoot does not contain the pinned runtime\node.exe',
    "ExtractTemporaryFiles('{app}\versions\{#AppVersion}\*');",
    'BackupExistingDatabasePreflight();',
    'VerifyVersionHealthPreflight();',
    'ExecAndLogOutput(',
    'Health-check output:',
    'Bundled health-check process exited with code',
    'Installer preflight completed before the normal file-copy stage.',
    'tools\backup-state.mjs',
    '--data-dir',
    '--version',
    '--health-check',
    'ActivationFailureExitCode = 70;',
    'ActivationRollbackIncompleteExitCode = 74;',
    'GetCustomSetupExitCode(): Integer;',
    'RollbackFailedActivation(): Boolean;',
    'RemoveSetupCreatedFile(',
    'CaptureVersionRoot();',
    'CaptureUninstallRegistry();',
    'procedure EnsureSafeProductTree();',
    'procedure EnsureSafeDataTree();',
    'ProductTreeHasReparsePoint(ProductRoot())',
    'ExistingPathIsUnsafeReparse(ProgramsRoot)',
    'not IsFixedLocalPath(ProductRoot())',
    'not IsFixedLocalPath(DataRoot())',
    'ShouldPurgeUserData',
    'SetupIconFile={#SetupIconFileSource}',
    'Name: "workbench"',
    'Flags: fixed'
)
foreach ($invariant in $installerInvariants) {
    if (-not $installerText.Contains($invariant)) {
        throw "Installer safety contract is missing: $invariant"
    }
}
foreach ($selectionInvariant in @(
    "HasCommandLinePrefix('/COMPONENTS=')",
    "HasCommandLinePrefix('/TYPE=')",
    "HasCommandLinePrefix('/LOADINF=')",
    "WizardSelectComponents('workbench,!codexplugin')"
)) {
    if (-not $installerText.Contains($selectionInvariant)) {
        throw "Installer explicit component-selection contract is missing: $selectionInvariant"
    }
}
$needsRestartIndex = $installerText.IndexOf('NeedsRestart := False;', [StringComparison]::Ordinal)
$preflightCacheIndex = $installerText.IndexOf('if PreflightAttempted then', [StringComparison]::Ordinal)
$stopServiceIndex = $installerText.IndexOf('StopOrganizerService(StableLauncherPath());', [StringComparison]::Ordinal)
$extractPreflightIndex = $installerText.IndexOf('ExtractPreflightPayload();', $stopServiceIndex, [StringComparison]::Ordinal)
$backupPreflightIndex = $installerText.IndexOf('BackupExistingDatabasePreflight();', $extractPreflightIndex, [StringComparison]::Ordinal)
$healthPreflightIndex = $installerText.IndexOf('VerifyVersionHealthPreflight();', $backupPreflightIndex, [StringComparison]::Ordinal)
$captureRollbackIndex = $installerText.IndexOf('CaptureActivationRollbackState();', $healthPreflightIndex, [StringComparison]::Ordinal)
$safeProductTreeIndex = $installerText.IndexOf('EnsureSafeProductTree();', $preflightCacheIndex, [StringComparison]::Ordinal)
if ($needsRestartIndex -lt 0 -or $preflightCacheIndex -le $needsRestartIndex -or
    $safeProductTreeIndex -le $preflightCacheIndex -or $stopServiceIndex -le $safeProductTreeIndex -or
    $extractPreflightIndex -le $stopServiceIndex -or
    $backupPreflightIndex -le $extractPreflightIndex -or $healthPreflightIndex -le $backupPreflightIndex -or
    $captureRollbackIndex -le $healthPreflightIndex) {
    throw 'Installer preflight must be cached and complete shutdown, extraction, backup, exact health, and rollback capture before file copy.'
}
$installStepSafetyIndex = $installerText.IndexOf('if CurStep = ssInstall then', [StringComparison]::Ordinal)
$installStepEnsureIndex = $installerText.IndexOf('EnsureSafeProductTree();', $installStepSafetyIndex, [StringComparison]::Ordinal)
$initializeUninstallIndex = $installerText.IndexOf('function InitializeUninstall(): Boolean;', [StringComparison]::Ordinal)
$uninstallEnsureIndex = $installerText.IndexOf('EnsureSafeProductTree();', $initializeUninstallIndex, [StringComparison]::Ordinal)
$uninstallDataEnsureIndex = $installerText.IndexOf('EnsureSafeDataTree();', $uninstallEnsureIndex, [StringComparison]::Ordinal)
if ($installStepSafetyIndex -lt 0 -or $installStepEnsureIndex -le $installStepSafetyIndex -or
    $initializeUninstallIndex -lt 0 -or $uninstallEnsureIndex -le $initializeUninstallIndex -or
    $uninstallDataEnsureIndex -le $uninstallEnsureIndex) {
    throw 'Product and data reparse-point checks must run immediately before install writes and before uninstall deletion.'
}
$versionPayloadEntryMatches = [regex]::Matches(
    $installerText,
    [regex]::Escape('Source: "{#VersionPayloadRoot}\*"; DestDir: "{app}\versions\{#AppVersion}"'))
if ($versionPayloadEntryMatches.Count -ne 1) {
    throw 'The canonical version payload must appear exactly once in [Files]; preflight extraction must not duplicate the installer payload.'
}
$curStepIndex = $installerText.IndexOf('procedure CurStepChanged(CurStep: TSetupStep);', [StringComparison]::Ordinal)
$showUninstallIndex = $installerText.IndexOf('function ShowUninstallOptions(): Boolean;', $curStepIndex, [StringComparison]::Ordinal)
$postInstallBlock = $installerText.Substring($curStepIndex, $showUninstallIndex - $curStepIndex)
foreach ($forbiddenPostInstallCall in @('BackupExistingDatabasePreflight();', 'VerifyVersionHealthPreflight();')) {
    if ($postInstallBlock.Contains($forbiddenPostInstallCall)) {
        throw "Post-install repeats a preflight-only operation: $forbiddenPostInstallCall"
    }
}
foreach ($requiredPostInstallInvariant in @(
    'ActivateVersion();',
    'SetupFailureExitCode := ActivationFailureExitCode;',
    'SetupFailureExitCode := ActivationRollbackIncompleteExitCode;',
    'Activation failed; rollback complete; setup will exit with code 70:',
    'Activation failed; rollback incomplete; setup will exit with code 74:',
    'RollbackSucceeded := RollbackFailedActivation();',
    'Result := SetupFailureExitCode;'
)) {
    if (-not $installerText.Contains($requiredPostInstallInvariant)) {
        throw "Installer residual-failure contract is missing: $requiredPostInstallInvariant"
    }
}
$testFaultStart = $installerText.IndexOf('#ifdef TestActivationFault', [StringComparison]::Ordinal)
$testFaultEnd = $installerText.IndexOf('#endif', $testFaultStart, [StringComparison]::Ordinal)
if ($testFaultStart -lt 0 -or $testFaultEnd -le $testFaultStart) {
    throw 'Activation fault injection must be enclosed in the test-only Inno preprocessor guard.'
}
$testFaultBlock = $installerText.Substring($testFaultStart, $testFaultEnd - $testFaultStart)
if (-not $testFaultBlock.Contains('TEST ONLY deterministic post-copy activation failure.')) {
    throw 'The guarded activation fault does not fail deterministically.'
}
if ($buildReleaseText.Contains('TestActivationFault')) {
    throw 'The production release builder must never enable the test-only activation fault.'
}
$descriptorGateIndex = $installerText.IndexOf('if not HasRuntimeDescriptor() then', [StringComparison]::Ordinal)
$launcherExistenceIndex = $installerText.IndexOf('if not FileExists(LauncherPath) then', $descriptorGateIndex, [StringComparison]::Ordinal)
if ($descriptorGateIndex -lt 0 -or $launcherExistenceIndex -le $descriptorGateIndex) {
    throw 'Maintenance shutdown must skip only when no runtime descriptor exists, while descriptor-bearing failures remain fail-closed.'
}
foreach ($pluginIntegrationInvariant in @(
    "CompareText(ParamStr(Index), '/ADOPTLEGACYPLUGIN') = 0",
    "' --adopt-legacy-0.1.1 ' + AdoptValue",
    "' --defer-finalize true'",
    "if ExitCode = 75 then",
    "MarkerPath := AddBackslash(ProductRoot()) + 'plugin-registered.marker';",
    "MarkerStagingPath := MarkerPath + '.next';",
    "'.skill-organizer-managed.json'",
    'PluginUpdatePendingPath()',
    'CleanupSucceeded := Exec(',
    'SetupFailureExitCode := PluginFailureExitCode;',
    "AddQuotes(HelperPath) + ' rollback-install'",
    "AddQuotes(HelperPath) + ' finalize-install'",
    "if not Exec(VersionLauncherPath(), '--complete-plugin-install'",
    "if not Exec(VersionLauncherPath(), '--remove-plugin-install'",
    "AddQuotes(HelperPath) + ' remove'"
)) {
    if (-not $installerText.Contains($pluginIntegrationInvariant)) {
        throw "Installer plugin lifecycle contract is missing: $pluginIntegrationInvariant"
    }
}
if (-not [Regex]::IsMatch(
        $installerText,
        'if ExitCode = 75 then\s*begin[\s\S]*?Exit;\s*end;\s*if ExitCode <> 0',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
    throw 'Installer exit 75 handling must return before writing success state or invoking Codex.'
}
$pendingExitIndex = $installerText.IndexOf('if ExitCode = 75 then', [StringComparison]::Ordinal)
$registerPluginIndex = $installerText.IndexOf('procedure RegisterCodexPlugin();', [StringComparison]::Ordinal)
$helperExecIndex = $installerText.IndexOf(
    'if not Exec(NodePath, Arguments, VersionRoot(), SW_HIDE, ewWaitUntilTerminated, ExitCode) then',
    $registerPluginIndex,
    [StringComparison]::Ordinal)
$helperExecFailureIndex = $installerText.IndexOf(
    'SetupFailureExitCode := PluginFailureExitCode;',
    $helperExecIndex,
    [StringComparison]::Ordinal)
$helperNonzeroIndex = $installerText.IndexOf('if ExitCode <> 0 then', $pendingExitIndex, [StringComparison]::Ordinal)
$helperNonzeroFailureIndex = $installerText.IndexOf(
    'SetupFailureExitCode := PluginFailureExitCode;',
    $helperNonzeroIndex,
    [StringComparison]::Ordinal)
if ($registerPluginIndex -lt 0 -or $helperExecIndex -le $registerPluginIndex -or
    $helperExecFailureIndex -le $helperExecIndex -or $helperExecFailureIndex -ge $pendingExitIndex -or
    $helperNonzeroIndex -le $pendingExitIndex -or $helperNonzeroFailureIndex -le $helperNonzeroIndex) {
    throw 'Explicit optional-plugin helper launch and safety failures must produce a non-zero setup exit.'
}
$registeredMarkerIndex = $installerText.IndexOf(
    '    MarkerStagingPath,',
    $pendingExitIndex,
    [StringComparison]::Ordinal)
$markerRollbackIndex = $installerText.IndexOf(
    "AddQuotes(HelperPath) + ' rollback-install'",
    $registeredMarkerIndex,
    [StringComparison]::Ordinal)
$markerRollbackResultIndex = $installerText.IndexOf(
    'CleanupSucceeded := Exec(',
    $markerRollbackIndex,
    [StringComparison]::Ordinal)
$finalizeInstallIndex = $installerText.IndexOf(
    "AddQuotes(HelperPath) + ' finalize-install'",
    $markerRollbackResultIndex,
    [StringComparison]::Ordinal)
$completeInstallIndex = $installerText.IndexOf(
    "if not Exec(VersionLauncherPath(), '--complete-plugin-install'",
    [StringComparison]::Ordinal)
if ($pendingExitIndex -lt 0 -or $registeredMarkerIndex -le $pendingExitIndex -or
    $markerRollbackIndex -le $registeredMarkerIndex -or
    $markerRollbackResultIndex -le $markerRollbackIndex -or
    $finalizeInstallIndex -le $markerRollbackResultIndex -or
    $completeInstallIndex -le $finalizeInstallIndex) {
    throw 'Installer must roll back a failed ownership-marker commit, finalize a successful transaction, and only then invoke native Codex add.'
}
$nativeRemoveIndex = $installerText.IndexOf(
    "if not Exec(VersionLauncherPath(), '--remove-plugin-install'",
    [StringComparison]::Ordinal)
$marketplaceRemoveIndex = $installerText.IndexOf(
    "AddQuotes(HelperPath) + ' remove'",
    $nativeRemoveIndex,
    [StringComparison]::Ordinal)
if ($nativeRemoveIndex -lt 0 -or $marketplaceRemoveIndex -le $nativeRemoveIndex) {
    throw 'Installer must remove the native Codex plugin before removing its marketplace source.'
}
$stableUpdateIndex = $installerText.IndexOf('function UpdateStableLauncher(): Boolean;', [StringComparison]::Ordinal)
$stableNextIndex = $installerText.IndexOf(
    "NextPath := StableLauncherPath() + '.next';",
    $stableUpdateIndex,
    [StringComparison]::Ordinal)
$stableCopyIndex = $installerText.IndexOf(
    'Result := CopyFile(VersionLauncherPath(), NextPath, False);',
    $stableNextIndex,
    [StringComparison]::Ordinal)
$stableMoveIndex = $installerText.IndexOf('Result := MoveFileEx(', $stableCopyIndex, [StringComparison]::Ordinal)
$stableFlagsIndex = $installerText.IndexOf(
    'MoveFileReplaceExisting or MoveFileWriteThrough);',
    $stableMoveIndex,
    [StringComparison]::Ordinal)
$activateLauncherIndex = $installerText.IndexOf('if not UpdateStableLauncher() then', [StringComparison]::Ordinal)
$commitManifestIndex = $installerText.IndexOf(
    'if not CommitCurrentManifest() then',
    $activateLauncherIndex,
    [StringComparison]::Ordinal)
if ($stableUpdateIndex -lt 0 -or $stableNextIndex -le $stableUpdateIndex -or
    $stableCopyIndex -le $stableNextIndex -or $stableMoveIndex -le $stableCopyIndex -or
    $stableFlagsIndex -le $stableMoveIndex -or $activateLauncherIndex -lt 0 -or
    $commitManifestIndex -le $activateLauncherIndex) {
    throw 'Stable launcher activation must use a write-through atomic replacement before committing current.json.'
}
$marketplaceHelperText = Get-Content -LiteralPath (Join-Path $repoRoot 'installer\tools\manage-personal-marketplace.mjs') -Raw
if (-not $marketplaceHelperText.Contains('plugin-update-pending.json')) {
    throw 'Plugin replacement helper does not record a pending Codex restart.'
}
if (-not $marketplaceHelperText.Contains('is not owned by this installer')) {
    throw 'Plugin replacement helper does not enforce installer ownership.'
}
foreach ($markerTransactionInvariant in @(
    'plugin-install-transaction.json',
    'awaiting-marker-commit',
    'export async function rollbackInstallCommand',
    'export async function finalizeInstallCommand',
    'Personal marketplace changed after plugin staging; rollback was refused.'
)) {
    if (-not $marketplaceHelperText.Contains($markerTransactionInvariant)) {
        throw "Plugin marker transaction contract is missing: $markerTransactionInvariant"
    }
}
$pluginInstallerText = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop\Infrastructure\PluginInstaller.cs') -Raw
foreach ($desktopPluginInvariant in @(
    'private const int HelperPendingExitCode = 75;',
    '"complete-pending",',
    '["plugin", "add", PluginId]',
    'if (!await IsExpectedPluginInstalledAsync(cliPath).ConfigureAwait(false))',
    '["plugin", "list", "--json"]',
    'version.GetString() == expectedVersion',
    '["plugin", "remove", PluginId, "--json"]',
    '|| await IsPluginInstalledAsync(cliPath, expectedVersion: null).ConfigureAwait(false)'
)) {
    if (-not $pluginInstallerText.Contains($desktopPluginInvariant)) {
        throw "Desktop plugin lifecycle contract is missing: $desktopPluginInvariant"
    }
}
$completePendingCallIndex = $pluginInstallerText.IndexOf(
    'var helperResult = await CompleteMarketplacePendingAsync().ConfigureAwait(false);',
    [StringComparison]::Ordinal)
$helperPendingIndex = $pluginInstallerText.IndexOf(
    'if (helperResult.ExitCode == HelperPendingExitCode)',
    [StringComparison]::Ordinal)
$pluginAddIndex = $pluginInstallerText.IndexOf('["plugin", "add", PluginId]', [StringComparison]::Ordinal)
$pluginVersionCheckIndex = $pluginInstallerText.IndexOf(
    'if (!await IsExpectedPluginInstalledAsync(cliPath).ConfigureAwait(false))',
    [StringComparison]::Ordinal)
$registeredMarkerWriteIndex = $pluginInstallerText.IndexOf('WriteRegisteredMarker();', [StringComparison]::Ordinal)
if ($completePendingCallIndex -lt 0 -or $helperPendingIndex -le $completePendingCallIndex -or
    $pluginAddIndex -le $helperPendingIndex -or
    $pluginVersionCheckIndex -le $pluginAddIndex -or
    $registeredMarkerWriteIndex -le $pluginVersionCheckIndex) {
    throw 'Desktop plugin install must complete the verified pending source before add, list/version verification, and success marking.'
}
if (-not [Regex]::IsMatch(
        $pluginInstallerText,
        'if \(helperResult\.ExitCode == HelperPendingExitCode\)[\s\S]*?return ReplacementPendingExitCode;[\s\S]*?if \(helperResult\.ExitCode != 0\)[\s\S]*?return MarketplaceSafetyExitCode;[\s\S]*?\["plugin", "add", PluginId\]',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
    throw 'Desktop plugin install must not call native add after helper pending or safety failures.'
}
if (-not [Regex]::IsMatch(
        $pluginInstallerText,
        '\["plugin", "remove", PluginId, "--json"\][\s\S]*?removeResult\.ExitCode != 0[\s\S]*?IsPluginInstalledAsync\(cliPath, expectedVersion: null\)',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
    throw 'Desktop native remove must verify the plugin is absent before reporting success.'
}
$desktopAppText = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop\App.xaml.cs') -Raw
$backendHostText = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop\Infrastructure\BackendHost.cs') -Raw
$installLayoutText = Get-Content -LiteralPath (Join-Path $repoRoot 'desktop\Infrastructure\InstallLayout.cs') -Raw
$serverMainText = Get-Content -LiteralPath (Join-Path $repoRoot 'src\server\main.ts') -Raw
foreach ($healthIsolationInvariant in @(
    'BackendHost.CreateHealthCheck(healthRoot)',
    'startInfo.ArgumentList.Add("--internal-health-check")',
    'startInfo.Environment["CSO_INTERNAL_HEALTH_DATA_ROOT"]',
    'startInfo.Environment["CSO_INTERNAL_HEALTH_PARENT_PID"]',
    'startInfo.Environment["TEMP"] = healthTemporaryRoot',
    'startInfo.Environment["TMP"] = healthTemporaryRoot',
    'resolveServerDataDirectory({'
)) {
    if (-not ($desktopAppText + $backendHostText + $serverMainText).Contains($healthIsolationInvariant)) {
        throw "Installer health check is missing its isolated internal data transport: $healthIsolationInvariant"
    }
}
if ($backendHostText.Contains('CSO_DATA_DIR') -or $serverMainText.Contains('CSO_DATA_DIR')) {
    throw 'Release desktop and server must not restore the generic CSO_DATA_DIR override.'
}
if (-not $installLayoutText.Contains('Path.TrimEndingDirectorySeparator(directory.FullName)') -or
    -not $backendHostText.Contains('Path.TrimEndingDirectorySeparator(Path.GetFullPath(installRoot))')) {
    throw 'Runtime install roots must remove AppContext.BaseDirectory trailing separators before descriptor and product-boundary use.'
}
$terminateExactStart = $backendHostText.IndexOf(
    'private static async Task TerminateExactProcessAsync(Process process)',
    [StringComparison]::Ordinal)
$deleteDescriptorStart = $backendHostText.IndexOf(
    'private static async Task DeleteDescriptorIfUnchangedAsync(',
    [StringComparison]::Ordinal)
if ($terminateExactStart -lt 0 -or $deleteDescriptorStart -le $terminateExactStart) {
    throw 'Exact runtime termination and descriptor cleanup helpers are missing or reordered.'
}
$terminateExactBlock = $backendHostText.Substring(
    $terminateExactStart,
    $deleteDescriptorStart - $terminateExactStart)
foreach ($terminationInvariant in @(
    'using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));',
    'await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);',
    'catch (InvalidOperationException) when (process.HasExited)',
    'catch (OperationCanceledException error)',
    'if (process.HasExited)',
    'throw new TimeoutException('
)) {
    if (-not $terminateExactBlock.Contains($terminationInvariant)) {
        throw "Exact runtime termination must fail closed before descriptor cleanup: $terminationInvariant"
    }
}
if (-not [Regex]::IsMatch(
        $terminateExactBlock,
        'catch \(OperationCanceledException error\)\s*\{\s*if \(process\.HasExited\)\s*\{\s*return;\s*\}\s*throw new TimeoutException\([\s\S]*?error\);\s*\}',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
    throw 'A termination timeout may return only after HasExited is true; uncertain process state must propagate or throw.'
}
$stopCompatibleStart = $backendHostText.IndexOf(
    'public async Task StopCompatibleServiceAsync()',
    [StringComparison]::Ordinal)
$probeDescriptorsStart = $backendHostText.IndexOf(
    'private async Task<BackendSession?> ProbeDescriptorsAsync(',
    $stopCompatibleStart,
    [StringComparison]::Ordinal)
$stopCompatibleBlock = $backendHostText.Substring(
    $stopCompatibleStart,
    $probeDescriptorsStart - $stopCompatibleStart)
$terminateBeforeDescriptorDelete = $stopCompatibleBlock.IndexOf(
    'await TerminateExactProcessAsync(process).ConfigureAwait(false);',
    [StringComparison]::Ordinal)
$descriptorDeleteAfterTermination = $stopCompatibleBlock.IndexOf(
    'await DeleteDescriptorIfUnchangedAsync(descriptorPath, descriptor.Token).ConfigureAwait(false);',
    $terminateBeforeDescriptorDelete,
    [StringComparison]::Ordinal)
if ($terminateBeforeDescriptorDelete -lt 0 -or $descriptorDeleteAfterTermination -le $terminateBeforeDescriptorDelete) {
    throw 'Maintenance shutdown must confirm exact process exit before deleting its runtime descriptor.'
}
foreach ($desktopRouteInvariant in @(
    'e.Args.Contains("--complete-plugin-install", StringComparer.OrdinalIgnoreCase)',
    'var exitCode = await PluginInstaller.CompleteAsync(e.Args).ConfigureAwait(true);',
    'e.Args.Contains("--remove-plugin-install", StringComparer.OrdinalIgnoreCase)',
    'var exitCode = await PluginInstaller.RemoveFromCodexAsync(e.Args).ConfigureAwait(true);'
)) {
    if (-not $desktopAppText.Contains($desktopRouteInvariant)) {
        throw "Desktop plugin maintenance route is missing: $desktopRouteInvariant"
    }
}
$normalStartupShowIndex = $desktopAppText.IndexOf('_mainWindow.Show();', [StringComparison]::Ordinal)
$normalStartupRetryIndex = $desktopAppText.IndexOf(
    '_ = RetryPendingPluginInstallWithBackoffAsync(e.Args, _lifecycleCancellation.Token);',
    [StringComparison]::Ordinal)
foreach ($normalStartupRetryInvariant in @(
    'private static readonly TimeSpan[] PendingPluginRetryDelays',
    'private static readonly TimeSpan CappedPendingPluginRetryDelay = TimeSpan.FromMinutes(10);',
    'private async Task RetryPendingPluginInstallWithBackoffAsync(',
    'for (var attempt = 0; !cancellationToken.IsCancellationRequested; attempt++)',
    ': CappedPendingPluginRetryDelay;',
    'await Task.Delay(delay, cancellationToken).ConfigureAwait(false)',
    '_ = TryCompletePendingPluginInstallAsync(e.Args, _lifecycleCancellation.Token);',
    'private async Task<bool> TryCompletePendingPluginInstallAsync(',
    'if (!PluginInstaller.HasPendingInstall)',
    'await PluginInstaller.CompleteAsync(arguments).ConfigureAwait(false)'
)) {
    if (-not $desktopAppText.Contains($normalStartupRetryInvariant)) {
        throw "Normal desktop startup does not safely retry a pending plugin install: $normalStartupRetryInvariant"
    }
}
if ($normalStartupShowIndex -lt 0 -or $normalStartupRetryIndex -le $normalStartupShowIndex) {
    throw 'Pending plugin completion must start asynchronously only after the normal desktop window is shown.'
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('cso-release-test-' + [Guid]::NewGuid().ToString('N'))
$oldUserProfile = $env:USERPROFILE
$oldHome = $env:HOME
$oldLocalAppData = $env:LOCALAPPDATA
try {
    $userHome = Join-Path $temporaryRoot 'user'
    $localAppData = Join-Path $temporaryRoot 'local'
    $programRoot = Join-Path $localAppData 'Programs\SkillOrganizerForCodex'
    $source = Join-Path $programRoot "versions\$($package.version)\plugin\codex-skill-organizer"
    $personalMarketplace = Join-Path $userHome '.agents\plugins\marketplace.json'
    $destination = Join-Path $userHome 'plugins\codex-skill-organizer'
    $dataDir = Join-Path $localAppData 'SkillOrganizerForCodex'
    New-Item -ItemType Directory -Path $source -Force | Out-Null
    Get-ChildItem -LiteralPath $pluginRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $source -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $personalMarketplace) -Force | Out-Null
    $fixtureMarketplace = @{
        name = 'personal'
        interface = @{ displayName = 'My Personal Marketplace' }
        plugins = @(
            @{
                name = 'unrelated-plugin'
                source = @{ source = 'local'; path = './plugins/unrelated-plugin' }
                policy = @{ installation = 'AVAILABLE'; authentication = 'ON_USE' }
                category = 'Other'
            }
        )
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($personalMarketplace, $fixtureMarketplace, [System.Text.UTF8Encoding]::new($false))

    $env:USERPROFILE = $userHome
    $env:HOME = $userHome
    $env:LOCALAPPDATA = $localAppData
    $helper = Join-Path $repoRoot 'installer\tools\manage-personal-marketplace.mjs'
    & node $helper install `
        --marketplace $personalMarketplace `
        --plugin-destination $destination `
        --data-dir $dataDir `
        --plugin-source $source `
        --version $package.version
    if ($LASTEXITCODE -ne 0) { throw 'Fresh plugin registration fixture failed.' }

    $installedMarketplace = Get-Content -LiteralPath $personalMarketplace -Raw | ConvertFrom-Json
    if (@($installedMarketplace.plugins | Where-Object name -eq 'unrelated-plugin').Count -ne 1) {
        throw 'Marketplace merge changed an unrelated entry.'
    }
    if (@($installedMarketplace.plugins | Where-Object name -eq 'codex-skill-organizer').Count -ne 1) {
        throw 'Marketplace merge did not add exactly one Organizer entry.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $destination '.skill-organizer-managed.json') -PathType Leaf)) {
        throw 'Installed plugin does not contain the ownership marker.'
    }

    & node $helper install `
        --marketplace $personalMarketplace `
        --plugin-destination $destination `
        --data-dir $dataDir `
        --plugin-source $source `
        --version $package.version
    if ($LASTEXITCODE -ne 0) { throw 'Idempotent plugin replacement fixture failed.' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $dataDir 'plugin-backups') -Directory).Count -lt 1) {
        throw 'Plugin replacement did not preserve a recoverable backup.'
    }

    & node $helper remove `
        --marketplace $personalMarketplace `
        --plugin-destination $destination `
        --data-dir $dataDir
    if ($LASTEXITCODE -ne 0) { throw 'Plugin removal fixture failed.' }
    $removedMarketplace = Get-Content -LiteralPath $personalMarketplace -Raw | ConvertFrom-Json
    if (@($removedMarketplace.plugins | Where-Object name -eq 'codex-skill-organizer').Count -ne 0) {
        throw 'Plugin removal left the Organizer marketplace entry.'
    }
    if (@($removedMarketplace.plugins | Where-Object name -eq 'unrelated-plugin').Count -ne 1) {
        throw 'Plugin removal changed an unrelated entry.'
    }

    $removedMarketplace.plugins += @{
        name = 'codex-skill-organizer'
        source = @{ source = 'local'; path = './plugins/different-organizer-source' }
        policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
        category = 'Productivity'
    }
    [System.IO.File]::WriteAllText(
        $personalMarketplace,
        ($removedMarketplace | ConvertTo-Json -Depth 8),
        [System.Text.UTF8Encoding]::new($false))
    & node $helper install `
        --marketplace $personalMarketplace `
        --plugin-destination $destination `
        --data-dir $dataDir `
        --plugin-source $source `
        --version $package.version
    if ($LASTEXITCODE -eq 0) { throw 'A conflicting same-name marketplace source was overwritten.' }
    if (Test-Path -LiteralPath $destination) { throw 'Conflict handling wrote plugin files before rejecting the marketplace entry.' }

    $unownedMarketplace = @{
        name = 'personal'
        interface = @{ displayName = 'My Personal Marketplace' }
        plugins = @(
            @{
                name = 'unrelated-plugin'
                source = @{ source = 'local'; path = './plugins/unrelated-plugin' }
                policy = @{ installation = 'AVAILABLE'; authentication = 'ON_USE' }
                category = 'Other'
            },
            @{
                name = 'codex-skill-organizer'
                source = @{ source = 'local'; path = './plugins/codex-skill-organizer' }
                policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
                category = 'Productivity'
            }
        )
    }
    [System.IO.File]::WriteAllText(
        $personalMarketplace,
        ($unownedMarketplace | ConvertTo-Json -Depth 8),
        [System.Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Get-ChildItem -LiteralPath $pluginRoot -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
    }
    & node $helper remove `
        --marketplace $personalMarketplace `
        --plugin-destination $destination `
        --data-dir $dataDir
    if ($LASTEXITCODE -eq 0) { throw 'An unowned Organizer directory was removed.' }
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) { throw 'Unowned Organizer files were not preserved.' }
    $afterUnownedRemoval = Get-Content -LiteralPath $personalMarketplace -Raw | ConvertFrom-Json
    if (@($afterUnownedRemoval.plugins | Where-Object name -eq 'codex-skill-organizer').Count -ne 1) {
        throw 'Marketplace entry changed before the unowned directory was rejected.'
    }

    $manifestFixtureA = Join-Path $temporaryRoot 'manifest-a'
    $manifestFixtureB = Join-Path $temporaryRoot 'manifest-b'
    New-Item -ItemType Directory -Path $manifestFixtureA, $manifestFixtureB -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $manifestFixtureA 'sample.txt'), 'same', [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $manifestFixtureB 'sample.txt'), 'same', [System.Text.UTF8Encoding]::new($false))
    $manifestA = Join-Path $temporaryRoot 'manifest-a.json'
    $manifestB = Join-Path $temporaryRoot 'manifest-b.json'
    & (Join-Path $scriptRoot 'New-ContentManifest.ps1') -Root $manifestFixtureA -OutputPath $manifestA | Out-Null
    & (Join-Path $scriptRoot 'New-ContentManifest.ps1') -Root $manifestFixtureB -OutputPath $manifestB | Out-Null
    & (Join-Path $scriptRoot 'Compare-ContentManifest.ps1') -ReferenceManifest $manifestA -CandidateManifest $manifestB | Out-Null
}
finally {
    $env:USERPROFILE = $oldUserProfile
    $env:HOME = $oldHome
    $env:LOCALAPPDATA = $oldLocalAppData
    $fullTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if ($fullTemporaryRoot.StartsWith($systemTemp + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $fullTemporaryRoot).StartsWith('cso-release-test-')) {
        Remove-Item -LiteralPath $fullTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$global:LASTEXITCODE = 0
Write-Output 'Release scaffold validation passed.'
