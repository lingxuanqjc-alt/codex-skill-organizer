[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,

    [switch]$RequireInstaller
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$releaseRoot = [System.IO.Path]::GetFullPath($ReleaseDirectory)
if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
    throw "Release directory does not exist: $releaseRoot"
}

$runtimeLock = Get-Content -LiteralPath (Join-Path $scriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$globalJsonPath = Join-Path $repoRoot 'global.json'
$nugetLockPath = Join-Path $repoRoot 'desktop\packages.lock.json'
$globalSdk = (Get-Content -LiteralPath $globalJsonPath -Raw | ConvertFrom-Json).sdk
if ($ExpectedVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)') {
    throw "Expected version is not semantic: $ExpectedVersion"
}
$expectedAssemblyVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$portableName = "SkillOrganizerForCodex-$ExpectedVersion-win-x64-portable.zip"
$installerName = "SkillOrganizerForCodex-$ExpectedVersion-win-x64-setup.exe"
$expectedNames = @(
    "CONTENT-MANIFEST-portable-$ExpectedVersion.json",
    "CONTENT-MANIFEST-version-$ExpectedVersion.json",
    "CONTENT-MANIFEST-version-full-$ExpectedVersion.json",
    'RELEASE-METADATA.json',
    'SHA256SUMS.txt',
    $portableName,
    'skill-organizer-for-codex.cdx.json',
    'THIRD_PARTY_NOTICES.txt'
)
if ($RequireInstaller) { $expectedNames += $installerName }
$actualNames = @(Get-ChildItem -LiteralPath $releaseRoot -File | Select-Object -ExpandProperty Name | Sort-Object)
$nameDifference = Compare-Object -ReferenceObject @($expectedNames | Sort-Object) -DifferenceObject $actualNames
if ($nameDifference) {
    throw "Release asset set differs from the contract:`n$($nameDifference | Out-String)"
}

$metadata = Get-Content -LiteralPath (Join-Path $releaseRoot 'RELEASE-METADATA.json') -Raw | ConvertFrom-Json
if ($metadata.schemaVersion -ne 1 -or $metadata.product -ne 'Skill Organizer for Codex' -or
    $metadata.repository -ne 'lingxuanqjc-alt/codex-skill-organizer' -or
    $metadata.version -ne $ExpectedVersion -or $metadata.assemblyVersion -ne $expectedAssemblyVersion -or
    $metadata.protocolMajor -ne 2 -or $metadata.platform -ne 'windows-x64' -or
    $metadata.nodeVersion -ne "v$($runtimeLock.version)" -or
    $metadata.nodeExeSha256 -ne $runtimeLock.nodeExeSha256 -or
    $metadata.npmVersion -ne $runtimeLock.npmVersion -or
    $metadata.dotnetSdkVersion -ne $globalSdk.version -or
    $metadata.globalJsonSha256 -ne (Get-FileHash -LiteralPath $globalJsonPath -Algorithm SHA256).Hash.ToLowerInvariant() -or
    $metadata.nugetLockSha256 -ne (Get-FileHash -LiteralPath $nugetLockPath -Algorithm SHA256).Hash.ToLowerInvariant() -or
    $metadata.runtimeLock -ne 'scripts/release/runtime-lock.json') {
    throw 'RELEASE-METADATA.json does not match the release/version/runtime contract.'
}

if ($env:GITHUB_REF_TYPE -eq 'tag' -and $env:GITHUB_REF_NAME -and $env:GITHUB_REF_NAME -ne "v$ExpectedVersion") {
    throw "Git tag $($env:GITHUB_REF_NAME) does not match release v$ExpectedVersion."
}

$checksumPath = Join-Path $releaseRoot 'SHA256SUMS.txt'
$checksumEntries = @{}
foreach ($line in Get-Content -LiteralPath $checksumPath) {
    if ($line -notmatch '^([0-9a-f]{64})  ([^/\\]+)$') { throw "Invalid checksum line: $line" }
    $name = $Matches[2]
    if ($checksumEntries.ContainsKey($name)) { throw "Duplicate checksum entry: $name" }
    $checksumEntries[$name] = $Matches[1]
}
$hashTargets = @($actualNames | Where-Object { $_ -ne 'SHA256SUMS.txt' } | Sort-Object)
$hashDifference = Compare-Object -ReferenceObject $hashTargets -DifferenceObject @($checksumEntries.Keys | Sort-Object)
if ($hashDifference) { throw "SHA256SUMS.txt does not cover the exact release asset set:`n$($hashDifference | Out-String)" }
foreach ($name in $hashTargets) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $releaseRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $checksumEntries[$name]) { throw "Checksum mismatch: $name" }
}

if ($RequireInstaller) {
    $installer = Get-Item -LiteralPath (Join-Path $releaseRoot $installerName)
    if ($installer.Length -gt 150MB) { throw "Installer exceeds 150 MB: $($installer.Length) bytes." }
}

$versionManifest = Get-Content -LiteralPath (Join-Path $releaseRoot "CONTENT-MANIFEST-version-$ExpectedVersion.json") -Raw | ConvertFrom-Json
$versionFiles = @{}
foreach ($entry in @($versionManifest.files)) { $versionFiles[[string]$entry.path] = $entry }
foreach ($requiredPath in @(
    'SkillOrganizerForCodex.exe',
    'runtime/node.exe',
    'runtime/LICENSE',
    'app/dist/server.mjs',
    'app/dist/mcp-sidecar.mjs',
    'app/dist/product-version.json',
    'tools/backup-state.mjs',
    'legal/skill-organizer-for-codex.cdx.json',
    'legal/THIRD_PARTY_NOTICES.txt'
)) {
    if (-not $versionFiles.ContainsKey($requiredPath)) { throw "Version content manifest is missing $requiredPath." }
}
if ($versionFiles['runtime/node.exe'].sha256 -ne $runtimeLock.nodeExeSha256 -or
    $versionFiles['runtime/LICENSE'].sha256 -ne $runtimeLock.licenseSha256) {
    throw 'Version content manifest contains a runtime that differs from runtime-lock.json.'
}

$fullVersionManifest = Get-Content -LiteralPath (Join-Path $releaseRoot "CONTENT-MANIFEST-version-full-$ExpectedVersion.json") -Raw | ConvertFrom-Json
$fullVersionFiles = @{}
foreach ($entry in @($fullVersionManifest.files)) { $fullVersionFiles[[string]$entry.path] = $entry }
foreach ($entry in @($versionManifest.files)) {
    $fullEntry = $fullVersionFiles[[string]$entry.path]
    if ($null -eq $fullEntry -or $fullEntry.size -ne $entry.size -or $fullEntry.sha256 -ne $entry.sha256) {
        throw "Full version manifest does not preserve base payload file $($entry.path)."
    }
}
foreach ($requiredPluginPath in @(
    'plugin/codex-skill-organizer/.codex-plugin/plugin.json',
    'plugin/codex-skill-organizer/.mcp.json',
    'plugin/codex-skill-organizer/skills/skill-organizer/SKILL.md'
)) {
    if (-not $fullVersionFiles.ContainsKey($requiredPluginPath)) {
        throw "Full version content manifest is missing $requiredPluginPath."
    }
}

$sbom = Get-Content -LiteralPath (Join-Path $releaseRoot 'skill-organizer-for-codex.cdx.json') -Raw | ConvertFrom-Json
if ($sbom.bomFormat -ne 'CycloneDX' -or $sbom.specVersion -ne '1.6' -or
    $sbom.metadata.component.name -ne 'Skill Organizer for Codex' -or
    $sbom.metadata.component.version -ne $ExpectedVersion) {
    throw 'CycloneDX metadata does not match the release.'
}
if (@($sbom.metadata.component.properties | Where-Object {
    $_.name -eq 'skill-organizer:bundled-tool' -and $_.value -eq 'tools/backup-state.mjs'
}).Count -ne 1) {
    throw 'CycloneDX metadata does not list the SQLite upgrade-backup helper.'
}
$nodeComponents = @($sbom.components | Where-Object { $_.name -eq 'Node.js' -and $_.version -eq $runtimeLock.version })
if ($nodeComponents.Count -ne 1 -or
    @($nodeComponents[0].hashes | Where-Object { $_.alg -eq 'SHA-256' -and $_.content -eq $runtimeLock.nodeExeSha256 }).Count -ne 1) {
    throw 'CycloneDX SBOM does not identify the exact bundled Node.js runtime.'
}
$requiredDotnetComponents = @(
    @{ Name = 'Microsoft.Web.WebView2'; Scope = 'required'; Role = 'runtime'; Bundled = 'true' },
    @{ Name = 'Microsoft.NETCore.App.Runtime.win-x64'; Scope = 'required'; Role = 'runtime'; Bundled = 'true' },
    @{ Name = 'Microsoft.WindowsDesktop.App.Runtime.win-x64'; Scope = 'required'; Role = 'runtime'; Bundled = 'true' },
    @{ Name = 'Microsoft.NET.ILLink.Tasks'; Scope = 'excluded'; Role = 'build'; Bundled = 'false' },
    @{ Name = 'Microsoft.AspNetCore.App.Runtime.win-x64'; Scope = 'excluded'; Role = 'build'; Bundled = 'false' },
    @{ Name = 'Microsoft.Windows.SDK.NET.Ref'; Scope = 'excluded'; Role = 'build'; Bundled = 'false' }
)
foreach ($expected in $requiredDotnetComponents) {
    $componentMatches = @($sbom.components | Where-Object { $_.name -eq $expected.Name })
    if ($componentMatches.Count -ne 1 -or $componentMatches[0].scope -ne $expected.Scope -or
        @($componentMatches[0].hashes | Where-Object { $_.alg -eq 'SHA-512' -and $_.content -match '^[0-9a-f]{128}$' }).Count -ne 1 -or
        @($componentMatches[0].properties | Where-Object { $_.name -eq 'skill-organizer:dotnet-role' -and $_.value -eq $expected.Role }).Count -ne 1 -or
        @($componentMatches[0].properties | Where-Object { $_.name -eq 'skill-organizer:bundled' -and $_.value -eq $expected.Bundled }).Count -ne 1 -or
        (@($componentMatches[0].licenses).Count -eq 0 -and @($componentMatches[0].externalReferences | Where-Object type -eq 'license').Count -eq 0)) {
        throw "CycloneDX SBOM lacks exact .NET/NuGet evidence for $($expected.Name)."
    }
}
$dotnetSdkComponents = @($sbom.components | Where-Object { $_.name -eq '.NET SDK' -and $_.version -eq $globalSdk.version -and $_.scope -eq 'excluded' })
if ($dotnetSdkComponents.Count -ne 1) { throw 'CycloneDX SBOM does not identify the exact build-only .NET SDK.' }
$notices = Get-Content -LiteralPath (Join-Path $releaseRoot 'THIRD_PARTY_NOTICES.txt') -Raw
foreach ($componentName in @(
    'Microsoft.Web.WebView2',
    'Microsoft.NETCore.App.Runtime.win-x64',
    'Microsoft.WindowsDesktop.App.Runtime.win-x64',
    'Microsoft.NET.ILLink.Tasks',
    'Microsoft.AspNetCore.App.Runtime.win-x64',
    'Microsoft.Windows.SDK.NET.Ref',
    '.NET SDK'
)) {
    if (-not $notices.Contains($componentName)) { throw "Third-party notices omit $componentName." }
}
if (-not $notices.Contains('.NET/NuGet license evidence')) {
    throw 'Third-party notices do not contain restored .NET/NuGet license evidence.'
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('cso-release-output-' + [Guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath (Join-Path $releaseRoot $portableName) -DestinationPath $temporaryRoot
    $topFiles = @(Get-ChildItem -LiteralPath $temporaryRoot -File -Force)
    $topDirectories = @(Get-ChildItem -LiteralPath $temporaryRoot -Directory -Force)
    if ($topFiles.Count -ne 0 -or $topDirectories.Count -ne 1) {
        throw 'Portable ZIP must contain exactly one top-level product directory.'
    }
    $portableExecutable = Get-Item -LiteralPath (Join-Path $topDirectories[0].FullName "versions\$ExpectedVersion\SkillOrganizerForCodex.exe")
    if ($portableExecutable.VersionInfo.FileVersion -ne $expectedAssemblyVersion -or
        -not $portableExecutable.VersionInfo.ProductVersion.StartsWith($ExpectedVersion, [System.StringComparison]::Ordinal)) {
        throw "Desktop executable version does not match package version $ExpectedVersion."
    }
    $portableVersionRoot = Join-Path $topDirectories[0].FullName "versions\$ExpectedVersion"
    $portableBundleVersion = Get-Content -LiteralPath (Join-Path $portableVersionRoot 'app\dist\product-version.json') -Raw | ConvertFrom-Json
    if ($portableBundleVersion.schemaVersion -ne 1 -or $portableBundleVersion.productVersion -ne $ExpectedVersion) {
        throw 'Portable app bundle product version marker does not match package.json.'
    }
    $portableWebIndex = Get-Content -LiteralPath (Join-Path $portableVersionRoot 'app\dist\public\index.html') -Raw
    $expectedWebMarker = '<meta name="skill-organizer-version" content="' + $ExpectedVersion + '" />'
    if (-not $portableWebIndex.Contains($expectedWebMarker) -or $portableWebIndex.Contains('__PRODUCT_VERSION__')) {
        throw 'Portable web bundle contains a stale or unresolved product version.'
    }
    $candidateManifest = Join-Path $temporaryRoot 'portable-manifest.json'
    & (Join-Path $scriptRoot 'New-ContentManifest.ps1') `
        -Root $topDirectories[0].FullName `
        -OutputPath $candidateManifest | Out-Null
    & (Join-Path $scriptRoot 'Compare-ContentManifest.ps1') `
        -ReferenceManifest (Join-Path $releaseRoot "CONTENT-MANIFEST-portable-$ExpectedVersion.json") `
        -CandidateManifest $candidateManifest | Out-Null
}
finally {
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if ($resolvedTemporaryRoot.StartsWith($systemTemp + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemporaryRoot).StartsWith('cso-release-output-')) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output "Release output validation passed: $ExpectedVersion"
