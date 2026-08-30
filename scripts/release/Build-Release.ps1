[CmdletBinding()]
param(
    [string]$Version,

    [string]$DesktopPayloadDirectory,

    [string]$NodeRuntimeDirectory,

    [string]$OutputDirectory,
    [string]$IsccPath,
    [switch]$SkipProjectCheck,
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$releaseScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $releaseScriptRoot 'Get-CanonicalTextSha256.ps1')
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $releaseScriptRoot '..\..'))
$artifactsRoot = Join-Path $repoRoot 'artifacts'
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$runtimeLockPath = Join-Path $releaseScriptRoot 'runtime-lock.json'
$runtimeLock = Get-Content -LiteralPath $runtimeLockPath -Raw | ConvertFrom-Json
$globalJsonPath = Join-Path $repoRoot 'global.json'
$globalSdk = (Get-Content -LiteralPath $globalJsonPath -Raw | ConvertFrom-Json).sdk

if (-not $Version) {
    $Version = [string]$package.version
}
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Release version is not strict semver: $Version"
}
$assemblyVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
if ($package.version -ne $Version) {
    throw "package.json version $($package.version) does not match release $Version."
}
if ($globalSdk.version -notmatch '^\d+\.\d+\.\d+$' -or
    $globalSdk.rollForward -ne 'disable' -or $globalSdk.allowPrerelease -ne $false) {
    throw "global.json must pin an exact stable .NET SDK with rollForward=disable: $globalJsonPath"
}
$dotnetSdkVersion = (& dotnet --version).Trim()
if ($LASTEXITCODE -ne 0 -or $dotnetSdkVersion -ne $globalSdk.version) {
    throw "Release requires .NET SDK $($globalSdk.version), got '$dotnetSdkVersion'."
}
$desktopAssetsPath = Join-Path $repoRoot 'desktop\obj\project.assets.json'
$nugetLockPath = Join-Path $repoRoot 'desktop\packages.lock.json'
if (-not (Test-Path -LiteralPath $nugetLockPath -PathType Leaf)) {
    throw "Locked NuGet graph is missing: $nugetLockPath"
}
if ($runtimeLock.schemaVersion -ne 1 -or $runtimeLock.platform -ne 'win-x64' -or
    $runtimeLock.version -notmatch '^24\.\d+\.\d+$' -or
    $runtimeLock.archiveName -ne "node-v$($runtimeLock.version)-win-x64.zip" -or
    $runtimeLock.url -notmatch '^https://nodejs\.org/' -or
    $runtimeLock.archiveSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.nodeExeSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.licenseSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.npmVersion -notmatch '^\d+\.\d+\.\d+$' -or
    $runtimeLock.npmCmdSha256 -notmatch '^[0-9a-f]{64}$' -or
    $runtimeLock.npmCliSha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Pinned runtime lock is invalid: $runtimeLockPath"
}

$desktopPayloadWasDefaulted = -not $DesktopPayloadDirectory
if (-not $DesktopPayloadDirectory) {
    $DesktopPayloadDirectory = Join-Path $artifactsRoot 'desktop'
}
if (-not $NodeRuntimeDirectory) {
    if ($env:CSO_NODE_RUNTIME_DIRECTORY) {
        $NodeRuntimeDirectory = $env:CSO_NODE_RUNTIME_DIRECTORY
    }
    else {
        $toolchainRoot = Join-Path $artifactsRoot 'toolchain'
        $runtimeCandidates = @(
            Get-ChildItem -LiteralPath $toolchainRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -eq "node-v$($runtimeLock.version)-win-x64" -and
                    (Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') -PathType Leaf) -and
                    (Test-Path -LiteralPath (Join-Path $_.FullName 'LICENSE') -PathType Leaf)
                } |
                Select-Object -ExpandProperty FullName
        )
        if ($runtimeCandidates.Count -ne 1) {
            throw "Expected exactly one pinned Node runtime at artifacts\toolchain\node-v$($runtimeLock.version)-win-x64. Pass -NodeRuntimeDirectory or set CSO_NODE_RUNTIME_DIRECTORY."
        }
        $NodeRuntimeDirectory = $runtimeCandidates[0]
    }
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $artifactsRoot "release\$Version"
}
$finalRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$workRoot = [System.IO.Path]::GetFullPath((Join-Path $artifactsRoot "work\$Version"))
$desktopRoot = [System.IO.Path]::GetFullPath($DesktopPayloadDirectory)
$nodeRoot = [System.IO.Path]::GetFullPath($NodeRuntimeDirectory)

function Assert-OwnedPath([string]$Candidate, [string]$Owner, [string]$Label) {
    $fullCandidate = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    $fullOwner = [System.IO.Path]::GetFullPath($Owner).TrimEnd('\', '/')
    if ($fullCandidate -eq $fullOwner -or -not $fullCandidate.StartsWith($fullOwner + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be a child of $fullOwner, got $fullCandidate"
    }
}

function Reset-OwnedDirectory([string]$Directory, [string]$Owner) {
    Assert-OwnedPath $Directory $Owner 'Release working directory'
    if (Test-Path -LiteralPath $Directory) {
        Remove-Item -LiteralPath $Directory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Directory does not exist: $Source"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

$nodeExe = Join-Path $nodeRoot 'node.exe'
$nodeLicense = Join-Path $nodeRoot 'LICENSE'
$nodeNpm = Join-Path $nodeRoot 'npm.cmd'
$nodeNpmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
foreach ($requiredFile in @($nodeExe, $nodeLicense, $nodeNpm, $nodeNpmCli)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required release input is missing: $requiredFile"
    }
}
$nodeVersion = (& $nodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$($runtimeLock.version)") {
    throw "Bundled runtime must be the pinned Node.js v$($runtimeLock.version), got '$nodeVersion'."
}
$nodeExeHash = (Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant()
$nodeLicenseHash = (Get-FileHash -LiteralPath $nodeLicense -Algorithm SHA256).Hash.ToLowerInvariant()
$nodeNpmHash = (Get-FileHash -LiteralPath $nodeNpm -Algorithm SHA256).Hash.ToLowerInvariant()
$nodeNpmCliHash = (Get-FileHash -LiteralPath $nodeNpmCli -Algorithm SHA256).Hash.ToLowerInvariant()
if ($nodeExeHash -ne $runtimeLock.nodeExeSha256 -or
    $nodeLicenseHash -ne $runtimeLock.licenseSha256 -or
    $nodeNpmHash -ne $runtimeLock.npmCmdSha256 -or
    $nodeNpmCliHash -ne $runtimeLock.npmCliSha256) {
    throw 'Bundled Node runtime does not match scripts/release/runtime-lock.json.'
}
$nodeNpmVersion = (& $nodeNpm --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeNpmVersion -ne $runtimeLock.npmVersion) {
    throw "Bundled npm must be the pinned version $($runtimeLock.npmVersion), got '$nodeNpmVersion'."
}
& $nodeExe (Join-Path $repoRoot 'scripts\version-contract.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'Product version contract validation failed.' }

if (-not $SkipProjectCheck) {
    Push-Location $repoRoot
    try {
        & $nodeNpm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        & $nodeNpm run check
        if ($LASTEXITCODE -ne 0) { throw 'npm run check failed.' }
    }
    finally {
        Pop-Location
    }
}

$iconBuilder = Join-Path $repoRoot 'scripts\build-icon.mjs'
$desktopIcon = Join-Path $repoRoot 'desktop\Assets\app.ico'
if (-not (Test-Path -LiteralPath $iconBuilder -PathType Leaf)) {
    throw "Reproducible icon builder is missing: $iconBuilder"
}
& $nodeExe $iconBuilder
if ($LASTEXITCODE -ne 0) { throw 'Desktop icon generation failed.' }
$iconBytes = [System.IO.File]::ReadAllBytes($desktopIcon)
if ($iconBytes.Length -lt 6 -or $iconBytes[0] -ne 0 -or $iconBytes[1] -ne 0 -or
    $iconBytes[2] -ne 1 -or $iconBytes[3] -ne 0 -or $iconBytes[4] -ne 7 -or $iconBytes[5] -ne 0) {
    throw 'desktop/Assets/app.ico is not the expected seven-image Windows ICO.'
}

if ($desktopPayloadWasDefaulted) {
    New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null
    Reset-OwnedDirectory $desktopRoot $artifactsRoot
    & dotnet publish (Join-Path $repoRoot 'desktop\SkillOrganizerForCodex.Desktop.csproj') `
        -c Release -p:Platform=x64 -r win-x64 --self-contained true `
        -p:PublishSingleFile=true `
        "-p:Version=$Version" `
        "-p:AssemblyVersion=$assemblyVersion" `
        "-p:FileVersion=$assemblyVersion" `
        -o $desktopRoot
    if ($LASTEXITCODE -ne 0) { throw 'Self-contained desktop publish failed.' }
}

function Strip-SourceMapReferences([string]$Directory) {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    Get-ChildItem -LiteralPath $Directory -File -Recurse |
        Where-Object { $_.Extension -in @('.js', '.mjs', '.html') } |
        ForEach-Object {
            $text = [System.IO.File]::ReadAllText($_.FullName)
            $clean = [System.Text.RegularExpressions.Regex]::Replace(
                $text,
                '(?m)^\s*//# sourceMappingURL=.*(?:\r?\n|$)',
                '')
            if ($clean -ne $text) {
                [System.IO.File]::WriteAllText($_.FullName, $clean, $utf8)
            }
        }
}

foreach ($requiredDirectory in @($desktopRoot)) {
    if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
        throw "Required release input is missing: $requiredDirectory"
    }
}

$desktopExe = Join-Path $desktopRoot 'SkillOrganizerForCodex.exe'
foreach ($requiredFile in @($desktopExe)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required release input is missing: $requiredFile"
    }
}

$pluginRoot = Join-Path $repoRoot 'plugin\plugins\codex-skill-organizer'
$marketplacePath = Join-Path $repoRoot 'plugin\marketplace.json'
$backupStateSource = Join-Path $repoRoot 'scripts\runtime\backup-state.mjs'
if (-not (Test-Path -LiteralPath $backupStateSource -PathType Leaf)) {
    throw "SQLite upgrade-backup helper is missing: $backupStateSource"
}
& (Join-Path $releaseScriptRoot 'Validate-Plugin.ps1') `
    -PluginRoot $pluginRoot `
    -MarketplacePath $marketplacePath `
    -ExpectedVersion $Version

$distRoot = Join-Path $repoRoot 'dist'
foreach ($requiredBundle in @('server.mjs', 'mcp-sidecar.mjs', 'product-version.json', 'public\index.html')) {
    if (-not (Test-Path -LiteralPath (Join-Path $distRoot $requiredBundle) -PathType Leaf)) {
        throw "Production bundle is missing: dist\$requiredBundle"
    }
}
$builtVersion = Get-Content -LiteralPath (Join-Path $distRoot 'product-version.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($builtVersion.schemaVersion -ne 1 -or $builtVersion.productVersion -ne $Version) {
    throw "Production bundle version does not match package.json: expected $Version. Run npm run build."
}
$builtWebIndex = Get-Content -LiteralPath (Join-Path $distRoot 'public\index.html') -Raw -Encoding UTF8
$expectedWebMarker = '<meta name="skill-organizer-version" content="' + $Version + '" />'
if (-not $builtWebIndex.Contains($expectedWebMarker) -or $builtWebIndex.Contains('__PRODUCT_VERSION__')) {
    throw "Production web bundle has a stale or unresolved product version. Run npm run build."
}

New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null
Reset-OwnedDirectory $workRoot $artifactsRoot
Reset-OwnedDirectory $finalRoot $artifactsRoot

$metadataRoot = Join-Path $workRoot 'metadata'
New-Item -ItemType Directory -Path $metadataRoot -Force | Out-Null
$sbomPath = Join-Path $metadataRoot 'skill-organizer-for-codex.cdx.json'
$noticesPath = Join-Path $metadataRoot 'THIRD_PARTY_NOTICES.txt'
if (-not (Test-Path -LiteralPath $desktopAssetsPath -PathType Leaf)) {
    throw "Desktop restore evidence is missing after publish: $desktopAssetsPath"
}
& $nodeExe (Join-Path $releaseScriptRoot 'new-sbom.mjs') `
    --root $repoRoot `
    --output $sbomPath `
    --version $Version `
    --node-runtime-root $nodeRoot `
    --desktop-assets $desktopAssetsPath `
    --dotnet-sdk-version $dotnetSdkVersion
if ($LASTEXITCODE -ne 0) { throw 'SBOM generation failed.' }
& $nodeExe (Join-Path $releaseScriptRoot 'new-third-party-notices.mjs') `
    --root $repoRoot `
    --node-runtime-root $nodeRoot `
    --desktop-assets $desktopAssetsPath `
    --dotnet-sdk-version $dotnetSdkVersion `
    --output $noticesPath
if ($LASTEXITCODE -ne 0) { throw 'Third-party notice generation failed.' }

$versionPayload = Join-Path $workRoot 'version-payload'
New-Item -ItemType Directory -Path $versionPayload -Force | Out-Null
Copy-DirectoryContents $desktopRoot $versionPayload
Get-ChildItem -LiteralPath $versionPayload -File -Recurse |
    Where-Object { $_.Extension -in @('.pdb', '.xml') } |
    Remove-Item -Force
$runtimePayload = Join-Path $versionPayload 'runtime'
New-Item -ItemType Directory -Path $runtimePayload -Force | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtimePayload 'node.exe') -Force
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $runtimePayload 'LICENSE') -Force
Copy-DirectoryContents $distRoot (Join-Path $versionPayload 'app\dist')
Get-ChildItem -LiteralPath (Join-Path $versionPayload 'app\dist') -Filter '*.map' -File -Recurse | Remove-Item -Force
Strip-SourceMapReferences (Join-Path $versionPayload 'app\dist')
New-Item -ItemType Directory -Path (Join-Path $versionPayload 'tools') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot 'installer\tools\manage-personal-marketplace.mjs') `
    -Destination (Join-Path $versionPayload 'tools\manage-personal-marketplace.mjs') -Force
Copy-Item -LiteralPath $backupStateSource `
    -Destination (Join-Path $versionPayload 'tools\backup-state.mjs') -Force

$legalRoot = Join-Path $versionPayload 'legal'
New-Item -ItemType Directory -Path $legalRoot -Force | Out-Null
foreach ($legalFile in @('LICENSE', 'NOTICE', 'PRIVACY.md', 'SECURITY.md')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $legalFile) -Destination $legalRoot -Force
}
Copy-Item -LiteralPath $sbomPath -Destination $legalRoot -Force
Copy-Item -LiteralPath $noticesPath -Destination $legalRoot -Force

$requiredPayloadFiles = @(
    'SkillOrganizerForCodex.exe',
    'runtime\node.exe',
    'runtime\LICENSE',
    'app\dist\server.mjs',
    'app\dist\mcp-sidecar.mjs',
    'app\dist\product-version.json',
    'tools\backup-state.mjs'
)
foreach ($relative in $requiredPayloadFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $versionPayload $relative) -PathType Leaf)) {
        throw "Assembled version payload is incomplete: $relative"
    }
}

$portableName = "SkillOrganizerForCodex-$Version-win-x64-portable"
$portableRoot = Join-Path $workRoot $portableName
New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $versionPayload 'SkillOrganizerForCodex.exe') -Destination $portableRoot -Force
$portableVersionRoot = Join-Path $portableRoot "versions\$Version"
Copy-DirectoryContents $versionPayload $portableVersionRoot
$currentJson = [ordered]@{
    schemaVersion = 1
    version = $Version
    relativePath = "versions/$Version"
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText(
    (Join-Path $portableRoot 'current.json'),
    $currentJson + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false))
Copy-DirectoryContents (Join-Path $repoRoot 'plugin') (Join-Path $portableRoot 'codex-plugin-marketplace')
foreach ($portableLegal in @('LICENSE', 'NOTICE', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $portableLegal) -Destination $portableRoot -Force
}
Copy-Item -LiteralPath $sbomPath -Destination $portableRoot -Force
Copy-Item -LiteralPath $noticesPath -Destination $portableRoot -Force

$fullVersionPayload = Join-Path $workRoot 'full-version-payload'
New-Item -ItemType Directory -Path $fullVersionPayload -Force | Out-Null
Copy-DirectoryContents $versionPayload $fullVersionPayload
Copy-DirectoryContents $pluginRoot (Join-Path $fullVersionPayload 'plugin\codex-skill-organizer')

$manifestVersionPath = Join-Path $finalRoot "CONTENT-MANIFEST-version-$Version.json"
$manifestFullVersionPath = Join-Path $finalRoot "CONTENT-MANIFEST-version-full-$Version.json"
$manifestPortablePath = Join-Path $finalRoot "CONTENT-MANIFEST-portable-$Version.json"
& (Join-Path $releaseScriptRoot 'New-ContentManifest.ps1') -Root $versionPayload -OutputPath $manifestVersionPath | Out-Null
& (Join-Path $releaseScriptRoot 'New-ContentManifest.ps1') -Root $fullVersionPayload -OutputPath $manifestFullVersionPath | Out-Null
& (Join-Path $releaseScriptRoot 'New-ContentManifest.ps1') -Root $portableRoot -OutputPath $manifestPortablePath | Out-Null

$normalizedTime = [DateTime]::SpecifyKind([DateTime]'2000-01-01T00:00:00', [DateTimeKind]::Utc)
Get-ChildItem -LiteralPath $portableRoot -Force -Recurse | ForEach-Object { $_.LastWriteTimeUtc = $normalizedTime }
$portableZip = Join-Path $finalRoot "$portableName.zip"
Compress-Archive -LiteralPath $portableRoot -DestinationPath $portableZip -CompressionLevel Optimal

if (-not $SkipInstaller) {
    if (-not $IsccPath) {
        $knownCompilers = @(
            'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
            'C:\Program Files\Inno Setup 6\ISCC.exe'
        )
        $toolchainInno = @(
            Get-ChildItem -LiteralPath (Join-Path $artifactsRoot 'toolchain') -Directory -Filter 'inno-setup-*' -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'ISCC.exe' }
        )
        $compilerCandidates = @(
            @($knownCompilers + $toolchainInno) |
                Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
                ForEach-Object { [System.IO.Path]::GetFullPath($_) } |
                Select-Object -Unique
        )
        if ($compilerCandidates.Count -gt 1) {
            throw 'Multiple Inno Setup compilers were found. Pass -IsccPath with the verified compiler to use.'
        }
        $IsccPath = $compilerCandidates | Select-Object -First 1
    }
    if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
        throw 'Inno Setup 6 compiler was not found. Pass -IsccPath with an explicit verified compiler path.'
    }
    $installerSource = Join-Path $repoRoot 'installer\SkillOrganizerForCodex.iss'
    $marketplaceHelper = Join-Path $repoRoot 'installer\tools\manage-personal-marketplace.mjs'
    $isccArguments = @(
        "/DAppVersion=$Version",
        "/DVersionPayloadRoot=$versionPayload",
        "/DPluginSourceRoot=$pluginRoot",
        "/DMarketplaceHelperSource=$marketplaceHelper",
        "/DLicenseFile=$(Join-Path $repoRoot 'LICENSE')",
        "/DSetupIconFileSource=$desktopIcon",
        "/DOutputDirectory=$finalRoot",
        $installerSource
    )
    & $IsccPath @isccArguments
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }

    $installerPath = Join-Path $finalRoot "SkillOrganizerForCodex-$Version-win-x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
        throw "Inno Setup did not create the expected installer: $installerPath"
    }
    if ((Get-Item -LiteralPath $installerPath).Length -gt 150MB) {
        throw 'Installer exceeds the 150 MB release budget.'
    }
}

Copy-Item -LiteralPath $sbomPath -Destination $finalRoot -Force
Copy-Item -LiteralPath $noticesPath -Destination $finalRoot -Force
$releaseMetadata = [ordered]@{
    schemaVersion = 1
    product = 'Skill Organizer for Codex'
    repository = 'lingxuanqjc-alt/codex-skill-organizer'
    version = $Version
    assemblyVersion = $assemblyVersion
    protocolMajor = 2
    nodeVersion = $nodeVersion
    nodeExeSha256 = $nodeExeHash
    npmVersion = $nodeNpmVersion
    dotnetSdkVersion = $dotnetSdkVersion
    globalJsonSha256 = Get-CanonicalTextSha256 -LiteralPath $globalJsonPath
    nugetLockSha256 = Get-CanonicalTextSha256 -LiteralPath $nugetLockPath
    runtimeLock = 'scripts/release/runtime-lock.json'
    platform = 'windows-x64'
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    (Join-Path $finalRoot 'RELEASE-METADATA.json'),
    $releaseMetadata + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false))

$checksumLines = @(
    Get-ChildItem -LiteralPath $finalRoot -File |
        Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
        Sort-Object -Property Name |
        ForEach-Object {
            '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
        }
)
[System.IO.File]::WriteAllText(
    (Join-Path $finalRoot 'SHA256SUMS.txt'),
    ($checksumLines -join "`n") + "`n",
    [System.Text.UTF8Encoding]::new($false))

& (Join-Path $releaseScriptRoot 'Test-ReleaseOutput.ps1') `
    -ReleaseDirectory $finalRoot `
    -ExpectedVersion $Version `
    -RequireInstaller:(-not $SkipInstaller)

Write-Output "Release artifacts created at $finalRoot"
Get-ChildItem -LiteralPath $finalRoot -File | Sort-Object -Property Name | Select-Object Name, Length
