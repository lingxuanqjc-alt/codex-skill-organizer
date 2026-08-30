[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Transaction', 'Selection')]
    [string]$Mode,

    [Parameter(Mandatory)]
    [ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [Parameter(Mandatory)]
    [string]$SetupPath,

    [Parameter(Mandatory)]
    [string]$IsccPath,

    [Parameter(Mandatory)]
    [string]$VersionPayloadRoot,

    [Parameter(Mandatory)]
    [string]$PluginSourceRoot,

    [Parameter(Mandatory)]
    [string]$MarketplaceHelperSource,

    [Parameter(Mandatory)]
    [string]$LicenseFile,

    [Parameter(Mandatory)]
    [string]$SetupIconFileSource,

    [Parameter(Mandatory)]
    [string]$InstallerSource
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:GITHUB_ACTIONS -ne 'true') {
    throw 'Installer mutation fixtures are restricted to an isolated GitHub Actions runner.'
}

foreach ($requiredFile in @($SetupPath, $IsccPath, $MarketplaceHelperSource, $LicenseFile, $SetupIconFileSource, $InstallerSource)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required installer fixture input is missing: $requiredFile"
    }
}
foreach ($requiredDirectory in @($VersionPayloadRoot, $PluginSourceRoot)) {
    if (-not (Test-Path -LiteralPath $requiredDirectory -PathType Container)) {
        throw "Required installer fixture directory is missing: $requiredDirectory"
    }
}

$productRoot = Join-Path $env:LOCALAPPDATA 'Programs\SkillOrganizerForCodex'
$dataRoot = Join-Path $env:LOCALAPPDATA 'SkillOrganizerForCodex'
$stableLauncher = Join-Path $productRoot 'SkillOrganizerForCodex.exe'
$currentPointer = Join-Path $productRoot 'current.json'
$personalMarketplace = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
$personalPlugin = Join-Path $env:USERPROFILE 'plugins\codex-skill-organizer'
$uninstallRegistryKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{A8D9081E-C5DB-4B48-A772-574427CA3A27}_is1'
$shortcutPaths = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Skill Organizer for Codex.lnk'),
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Skill Organizer for Codex.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Skill Organizer for Codex.lnk')
)
$silentBase = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-'

function Get-TreeSnapshot([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return '<missing>' }
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    return (@(Get-ChildItem -LiteralPath $resolvedRoot -Force -Recurse | ForEach-Object {
        $relative = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\', '/').Replace('\', '/')
        if ($_.PSIsContainer) {
            "D|$relative|$([int]$_.Attributes)"
        }
        else {
            "F|$relative|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)|$([int]$_.Attributes)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
        }
    } | Sort-Object) -join "`n")
}

function Get-FileSetSnapshot([string[]]$Paths) {
    return (@($Paths | ForEach-Object {
        if (Test-Path -LiteralPath $_ -PathType Leaf) {
            $item = Get-Item -LiteralPath $_ -Force
            "$_|$($item.Length)|$($item.LastWriteTimeUtc.Ticks)|$([int]$item.Attributes)|$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)"
        }
        elseif (Test-Path -LiteralPath $_ -PathType Container) {
            "$_|<directory>"
        }
        else {
            "$_|<missing>"
        }
    } | Sort-Object) -join "`n")
}

function Get-UninstallRegistrySnapshot() {
    & "$env:SystemRoot\System32\reg.exe" query $uninstallRegistryKey 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return '<missing>' }
    $exportPath = Join-Path $env:RUNNER_TEMP ('cso-uninstall-' + [Guid]::NewGuid().ToString('N') + '.reg')
    try {
        & "$env:SystemRoot\System32\reg.exe" export $uninstallRegistryKey $exportPath /y | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exportPath -PathType Leaf)) {
            throw 'Unable to export the Organizer uninstall registration.'
        }
        return (Get-FileHash -LiteralPath $exportPath -Algorithm SHA256).Hash
    }
    finally {
        Remove-Item -LiteralPath $exportPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-InstallStateSnapshot() {
    return ([ordered]@{
        productRoot = Get-TreeSnapshot $productRoot
        shortcuts = Get-FileSetSnapshot $shortcutPaths
        uninstallRegistry = Get-UninstallRegistrySnapshot
        marketplace = Get-FileSetSnapshot @($personalMarketplace)
        plugin = Get-TreeSnapshot $personalPlugin
    } | ConvertTo-Json -Compress)
}

function Assert-LogCount([string]$Text, [string]$Needle, [int]$Expected) {
    $actual = [regex]::Matches($Text, [regex]::Escape($Needle)).Count
    if ($actual -ne $Expected) {
        throw "Expected '$Needle' $Expected time(s) in setup log, got $actual."
    }
}

function Invoke-Setup(
    [string]$Installer,
    [string]$Arguments,
    [int]$ExpectedExitCode,
    [string]$LogPath) {
    Remove-Item -LiteralPath $LogPath -Force -ErrorAction SilentlyContinue
    $allArguments = "$Arguments /LOG=`"$LogPath`""
    $process = Start-Process -FilePath $Installer -ArgumentList $allArguments -Wait -PassThru
    if ($process.ExitCode -ne $ExpectedExitCode) {
        throw "Installer returned $($process.ExitCode), expected $ExpectedExitCode. See $LogPath"
    }
    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
        throw "Installer did not create its requested log: $LogPath"
    }
    return (Get-Content -LiteralPath $LogPath -Raw)
}

function Invoke-Uninstall([switch]$PurgeData) {
    $uninstaller = Get-ChildItem -LiteralPath $productRoot -Filter 'unins*.exe' -File -ErrorAction Stop |
        Sort-Object -Property Name | Select-Object -First 1 -ExpandProperty FullName
    $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
    if ($PurgeData) { $arguments += ' /PURGEDATA' }
    $process = Start-Process -FilePath $uninstaller -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Fixture uninstall failed: $($process.ExitCode)" }
}

function Compile-ActivationFaultInstaller([string]$FixtureVersion, [string]$Label) {
    $outputRoot = Join-Path $env:RUNNER_TEMP "cso-activation-fault-$Label"
    if (Test-Path -LiteralPath $outputRoot) {
        Remove-Item -LiteralPath $outputRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $outputRoot | Out-Null
    & $IsccPath `
        "/DAppVersion=$FixtureVersion" `
        "/DVersionPayloadRoot=$VersionPayloadRoot" `
        "/DPluginSourceRoot=$PluginSourceRoot" `
        "/DMarketplaceHelperSource=$MarketplaceHelperSource" `
        "/DLicenseFile=$LicenseFile" `
        "/DSetupIconFileSource=$SetupIconFileSource" `
        "/DOutputDirectory=$outputRoot" `
        '/DTestActivationFault=1' `
        $InstallerSource | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Activation-fault installer compilation failed for $Label." }
    $fixtureSetup = Join-Path $outputRoot "SkillOrganizerForCodex-$FixtureVersion-win-x64-setup.exe"
    if (-not (Test-Path -LiteralPath $fixtureSetup -PathType Leaf)) {
        throw "Activation-fault installer output is missing for $Label."
    }
    return $fixtureSetup
}

function Assert-CompleteActivationRollback([string]$LogText) {
    Assert-LogCount $LogText 'TEST ONLY activation fault hook fired after stable launcher replacement.' 1
    Assert-LogCount $LogText 'Activation failed; rollback complete; setup will exit with code 70:' 1
    Assert-LogCount $LogText 'Activation failed; rollback incomplete; setup will exit with code 74:' 0
}

function Assert-MarketplaceState([bool]$ExpectedOrganizer) {
    if (-not (Test-Path -LiteralPath $personalMarketplace -PathType Leaf)) {
        if ($ExpectedOrganizer) { throw 'Plugin selection did not create the personal marketplace.' }
        return
    }
    $marketplace = Get-Content -LiteralPath $personalMarketplace -Raw | ConvertFrom-Json
    if (@($marketplace.plugins | Where-Object name -eq 'unrelated-plugin').Count -ne 1) {
        throw 'Installer selection matrix changed the unrelated marketplace entry.'
    }
    $expectedCount = if ($ExpectedOrganizer) { 1 } else { 0 }
    if (@($marketplace.plugins | Where-Object name -eq 'codex-skill-organizer').Count -ne $expectedCount) {
        throw "Organizer marketplace entry count did not match the selected component state ($ExpectedOrganizer)."
    }
}

if ($Mode -eq 'Transaction') {
    if (-not (Test-Path -LiteralPath $stableLauncher -PathType Leaf) -or
        -not (Test-Path -LiteralPath $currentPointer -PathType Leaf)) {
        throw 'Transaction matrix requires the baseline desktop version to be installed first.'
    }
    & $stableLauncher --health-check
    if ($LASTEXITCODE -ne 0) { throw 'Baseline desktop version is unhealthy before transaction tests.' }

    $baselineState = Get-InstallStateSnapshot
    $sameVersionFaultSetup = Compile-ActivationFaultInstaller $Version 'same-version'
    $sameLog = Join-Path $env:RUNNER_TEMP 'cso-activation-same-version.log'
    $sameLogText = Invoke-Setup $sameVersionFaultSetup "$silentBase /TYPE=desktop /COMPONENTS=workbench" 70 $sameLog
    Assert-CompleteActivationRollback $sameLogText
    if ((Get-InstallStateSnapshot) -ne $baselineState) {
        throw 'Same-version activation rollback did not restore the complete install state byte-for-byte.'
    }

    if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "Fixture version is not semver: $Version" }
    $newVersion = "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)-activation-fixture"
    $newVersionFaultSetup = Compile-ActivationFaultInstaller $newVersion 'new-version'
    $newLog = Join-Path $env:RUNNER_TEMP 'cso-activation-new-version.log'
    $newLogText = Invoke-Setup $newVersionFaultSetup "$silentBase /TYPE=desktop /COMPONENTS=workbench" 70 $newLog
    Assert-CompleteActivationRollback $newLogText
    if ((Get-InstallStateSnapshot) -ne $baselineState) {
        throw 'Old-to-new activation rollback did not restore the complete install state byte-for-byte.'
    }
    if (Test-Path -LiteralPath (Join-Path $productRoot "versions\$newVersion")) {
        throw 'Old-to-new activation rollback retained the failed new version directory.'
    }

    Invoke-Uninstall -PurgeData
    if (Test-Path -LiteralPath $productRoot) { throw 'Fixture could not establish a clean first-install boundary.' }
    $cleanState = Get-InstallStateSnapshot
    $cleanLog = Join-Path $env:RUNNER_TEMP 'cso-activation-clean-first-install.log'
    $cleanLogText = Invoke-Setup $newVersionFaultSetup "$silentBase /TYPE=full" 70 $cleanLog
    Assert-CompleteActivationRollback $cleanLogText
    if ((Get-InstallStateSnapshot) -ne $cleanState) {
        throw 'Clean first-install activation rollback did not restore the absent program, registry, shortcut, plugin, and marketplace state.'
    }
    if ((Test-Path -LiteralPath $productRoot) -or (Test-Path -LiteralPath $personalPlugin)) {
        throw 'Clean first-install activation rollback left program or plugin files.'
    }

    $reinstallLog = Join-Path $env:RUNNER_TEMP 'cso-baseline-reinstall-after-transaction-matrix.log'
    $null = Invoke-Setup $SetupPath "$silentBase /TYPE=desktop /COMPONENTS=workbench" 0 $reinstallLog
    & $stableLauncher --health-check
    if ($LASTEXITCODE -ne 0) { throw 'Baseline reinstall was unhealthy after the transaction matrix.' }
    Write-Output 'Installer transaction matrix passed.'
    return
}

if (Test-Path -LiteralPath $productRoot) {
    throw 'Selection matrix requires a clean program root.'
}
if (Test-Path -LiteralPath $personalPlugin) {
    throw 'Selection matrix requires no pre-existing Organizer plugin directory.'
}
if (Test-Path -LiteralPath $dataRoot) {
    throw 'Selection matrix requires a clean Organizer data root.'
}

$codexHome = Join-Path $env:USERPROFILE '.codex'
$explicitCodexCli = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'Process')
if ((Test-Path -LiteralPath $codexHome -PathType Container) -or
    ($explicitCodexCli -and (Test-Path -LiteralPath $explicitCodexCli -PathType Leaf))) {
    throw 'No-Codex default-selection fixture requires an isolated runner without Codex detection evidence.'
}
$marketplaceBeforeNoCodex = Get-FileSetSnapshot @($personalMarketplace)
$noCodexLog = Join-Path $env:RUNNER_TEMP 'cso-no-codex-default-components.log'
$noCodexLogText = Invoke-Setup $SetupPath $silentBase 0 $noCodexLog
Assert-LogCount $noCodexLogText 'Preserving the explicit command-line or answer-file component selection.' 0
$defaultPackagedPlugin = Join-Path $productRoot "versions\$Version\plugin\codex-skill-organizer"
if (Test-Path -LiteralPath $defaultPackagedPlugin -PathType Container) {
    throw 'A no-Codex default install selected the optional packaged plugin.'
}
if (Test-Path -LiteralPath $personalPlugin -PathType Container) {
    throw 'A no-Codex default install registered the optional personal plugin.'
}
if ((Get-FileSetSnapshot @($personalMarketplace)) -ne $marketplaceBeforeNoCodex) {
    throw 'A no-Codex default install changed the personal marketplace.'
}

$productParent = [IO.Path]::GetFullPath((Split-Path -Parent $productRoot)).TrimEnd('\', '/')
$productUninstallJunctionTarget = [IO.Path]::GetFullPath((Join-Path $productParent (
    'SkillOrganizerForCodex-uninstall-junction-target-' + [Guid]::NewGuid().ToString('N'))))
if (-not $productUninstallJunctionTarget.StartsWith(
        $productParent + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Product uninstall-junction target escaped the Programs directory.'
}
$uninstallerName = Get-ChildItem -LiteralPath $productRoot -Filter 'unins*.exe' -File -ErrorAction Stop |
    Sort-Object -Property Name | Select-Object -First 1 -ExpandProperty Name
Move-Item -LiteralPath $productRoot -Destination $productUninstallJunctionTarget
New-Item -ItemType Junction -Path $productRoot -Target $productUninstallJunctionTarget | Out-Null
try {
    $productJunctionBefore = Get-TreeSnapshot $productUninstallJunctionTarget
    $productUninstallLog = Join-Path $env:RUNNER_TEMP 'cso-product-junction-uninstall.log'
    $productUninstallArguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`"$productUninstallLog`""
    $productUninstallProcess = Start-Process `
        -FilePath (Join-Path $productRoot $uninstallerName) `
        -ArgumentList $productUninstallArguments `
        -Wait `
        -PassThru
    if ($productUninstallProcess.ExitCode -eq 0) {
        throw 'Uninstall accepted a product-root junction.'
    }
    $productUninstallLogText = Get-Content -LiteralPath $productUninstallLog -Raw
    if (-not $productUninstallLogText.Contains(
            'The existing product directory boundary contains a junction, symlink, or reparse point')) {
        throw 'Product-root junction uninstall did not report the expected safety refusal.'
    }
    if ((Get-TreeSnapshot $productUninstallJunctionTarget) -ne $productJunctionBefore) {
        throw 'Product-root junction uninstall mutated its unrelated target.'
    }
}
finally {
    if (Test-Path -LiteralPath $productRoot) {
        [IO.Directory]::Delete($productRoot, $false)
    }
    if (Test-Path -LiteralPath $productUninstallJunctionTarget -PathType Container) {
        Move-Item -LiteralPath $productUninstallJunctionTarget -Destination $productRoot
    }
}

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$dataUninstallSentinel = Join-Path $dataRoot 'junction-uninstall-must-remain.txt'
[IO.File]::WriteAllText($dataUninstallSentinel, 'user-data', [Text.UTF8Encoding]::new($false))
$dataParent = [IO.Path]::GetFullPath((Split-Path -Parent $dataRoot)).TrimEnd('\', '/')
$dataUninstallJunctionTarget = [IO.Path]::GetFullPath((Join-Path $dataParent (
    'SkillOrganizerForCodex-data-uninstall-junction-target-' + [Guid]::NewGuid().ToString('N'))))
if (-not $dataUninstallJunctionTarget.StartsWith(
        $dataParent + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Data uninstall-junction target escaped LOCALAPPDATA.'
}
Move-Item -LiteralPath $dataRoot -Destination $dataUninstallJunctionTarget
New-Item -ItemType Junction -Path $dataRoot -Target $dataUninstallJunctionTarget | Out-Null
try {
    $productBeforeDataJunction = Get-TreeSnapshot $productRoot
    $dataJunctionBeforeUninstall = Get-TreeSnapshot $dataUninstallJunctionTarget
    $dataUninstallLog = Join-Path $env:RUNNER_TEMP 'cso-data-junction-uninstall.log'
    $dataUninstallArguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`"$dataUninstallLog`""
    $dataUninstallProcess = Start-Process `
        -FilePath (Join-Path $productRoot $uninstallerName) `
        -ArgumentList $dataUninstallArguments `
        -Wait `
        -PassThru
    if ($dataUninstallProcess.ExitCode -eq 0) {
        throw 'Uninstall accepted an Organizer data-root junction.'
    }
    $dataUninstallLogText = Get-Content -LiteralPath $dataUninstallLog -Raw
    if (-not $dataUninstallLogText.Contains(
            'The Organizer data boundary contains a junction, symlink, or reparse point')) {
        throw 'Data-root junction uninstall did not report the expected safety refusal.'
    }
    if ((Get-TreeSnapshot $dataUninstallJunctionTarget) -ne $dataJunctionBeforeUninstall -or
        -not (Test-Path -LiteralPath (Join-Path $dataUninstallJunctionTarget 'junction-uninstall-must-remain.txt') -PathType Leaf)) {
        throw 'Data-root junction uninstall mutated its unrelated target.'
    }
    if ((Get-TreeSnapshot $productRoot) -ne $productBeforeDataJunction) {
        throw 'Data-root junction uninstall changed the installed product before refusing.'
    }
}
finally {
    if (Test-Path -LiteralPath $dataRoot) {
        [IO.Directory]::Delete($dataRoot, $false)
    }
    if (Test-Path -LiteralPath $dataUninstallJunctionTarget -PathType Container) {
        Move-Item -LiteralPath $dataUninstallJunctionTarget -Destination $dataRoot
    }
}

Invoke-Uninstall -PurgeData
if (Test-Path -LiteralPath $productRoot) { throw 'No-Codex fixture uninstall retained the program root.' }
if (Test-Path -LiteralPath $dataRoot) { throw 'No-Codex fixture purge retained the data root.' }
if ((Get-FileSetSnapshot @($personalMarketplace)) -ne $marketplaceBeforeNoCodex) {
    throw 'No-Codex fixture uninstall changed the personal marketplace.'
}

$junctionTarget = Join-Path $env:RUNNER_TEMP ('cso-product-junction-target-' + [Guid]::NewGuid().ToString('N'))
$runnerTempBoundary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$junctionTarget = [IO.Path]::GetFullPath($junctionTarget)
if (-not $junctionTarget.StartsWith($runnerTempBoundary, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Junction fixture target escaped RUNNER_TEMP.'
}
New-Item -ItemType Directory -Path $junctionTarget | Out-Null
$junctionSentinel = Join-Path $junctionTarget 'must-remain.txt'
[IO.File]::WriteAllText($junctionSentinel, 'unrelated-target', [Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Path (Split-Path -Parent $productRoot) -Force | Out-Null
New-Item -ItemType Junction -Path $productRoot -Target $junctionTarget | Out-Null
try {
    $junctionBefore = Get-TreeSnapshot $junctionTarget
    $junctionLog = Join-Path $env:RUNNER_TEMP 'cso-product-root-junction.log'
    $junctionLogText = Invoke-Setup $SetupPath "$silentBase /TYPE=desktop /COMPONENTS=workbench" 7 $junctionLog
    Assert-LogCount $junctionLogText 'Installer preflight failed:' 1
    Assert-LogCount $junctionLogText 'Starting the installation process' 0
    if ((Get-TreeSnapshot $junctionTarget) -ne $junctionBefore -or
        -not (Test-Path -LiteralPath $junctionSentinel -PathType Leaf)) {
        throw 'A product-root junction allowed setup to mutate its unrelated target.'
    }
}
finally {
    if (Test-Path -LiteralPath $productRoot) {
        [IO.Directory]::Delete($productRoot, $false)
    }
    if (Test-Path -LiteralPath $junctionTarget -PathType Container) {
        Remove-Item -LiteralPath $junctionTarget -Recurse -Force
    }
}

if (Test-Path -LiteralPath $dataRoot) {
    throw 'Data-root junction fixture requires a clean Organizer data root.'
}
$dataJunctionTarget = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP ('cso-data-junction-target-' + [Guid]::NewGuid().ToString('N'))))
if (-not $dataJunctionTarget.StartsWith($runnerTempBoundary, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Data junction fixture target escaped RUNNER_TEMP.'
}
New-Item -ItemType Directory -Path $dataJunctionTarget | Out-Null
$dataJunctionSentinel = Join-Path $dataJunctionTarget 'must-remain.txt'
[IO.File]::WriteAllText($dataJunctionSentinel, 'unrelated-data-target', [Text.UTF8Encoding]::new($false))
New-Item -ItemType Junction -Path $dataRoot -Target $dataJunctionTarget | Out-Null
try {
    $dataJunctionBefore = Get-TreeSnapshot $dataJunctionTarget
    $dataJunctionLog = Join-Path $env:RUNNER_TEMP 'cso-data-root-junction.log'
    $dataJunctionLogText = Invoke-Setup $SetupPath "$silentBase /TYPE=desktop /COMPONENTS=workbench" 7 $dataJunctionLog
    Assert-LogCount $dataJunctionLogText 'Installer preflight failed:' 1
    Assert-LogCount $dataJunctionLogText 'Starting the installation process' 0
    if ((Get-TreeSnapshot $dataJunctionTarget) -ne $dataJunctionBefore -or
        -not (Test-Path -LiteralPath $dataJunctionSentinel -PathType Leaf)) {
        throw 'A data-root junction allowed setup to mutate its unrelated target.'
    }
}
finally {
    if (Test-Path -LiteralPath $dataRoot) {
        [IO.Directory]::Delete($dataRoot, $false)
    }
    if (Test-Path -LiteralPath $dataJunctionTarget -PathType Container) {
        Remove-Item -LiteralPath $dataJunctionTarget -Recurse -Force
    }
}

$marketplaceDirectory = Split-Path -Parent $personalMarketplace
New-Item -ItemType Directory -Path $marketplaceDirectory -Force | Out-Null
$unrelatedMarketplaceFixture = @{
    name = 'personal'
    interface = @{ displayName = 'Personal' }
    plugins = @(@{
        name = 'unrelated-plugin'
        source = @{ source = 'local'; path = './plugins/unrelated-plugin' }
        policy = @{ installation = 'AVAILABLE'; authentication = 'ON_USE' }
        category = 'Other'
    })
} | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText(
    $personalMarketplace,
    $unrelatedMarketplaceFixture,
    [Text.UTF8Encoding]::new($false))

New-Item -ItemType Directory -Path (Join-Path $productRoot 'plugin-registered.marker') -Force | Out-Null
$markerFailureLog = Join-Path $env:RUNNER_TEMP 'cso-plugin-marker-commit-failure.log'
$markerFailureText = Invoke-Setup `
    $SetupPath `
    "$silentBase /TYPE=full /COMPONENTS=workbench,codexplugin" `
    72 `
    $markerFailureLog
Assert-LogCount $markerFailureText 'Starting the installation process' 1
if (Test-Path -LiteralPath $personalPlugin) {
    throw 'Marker commit failure retained the managed plugin after compensating cleanup.'
}
Assert-MarketplaceState $false
$pluginTransactionPath = Join-Path $dataRoot 'plugin-install-transaction.json'
if (Test-Path -LiteralPath $pluginTransactionPath) {
    throw 'Clean marker commit failure retained its helper transaction.'
}
$markerBlockerPath = Join-Path $productRoot 'plugin-registered.marker'
if (Test-Path -LiteralPath $markerBlockerPath -PathType Container) {
    [IO.Directory]::Delete($markerBlockerPath, $false)
}
Invoke-Uninstall -PurgeData
if (Test-Path -LiteralPath $productRoot) {
    throw 'Marker-failure fixture uninstall retained the program root.'
}

$managedBaselineLog = Join-Path $env:RUNNER_TEMP 'cso-managed-plugin-baseline.log'
$null = Invoke-Setup `
    $SetupPath `
    "$silentBase /TYPE=full /COMPONENTS=workbench,codexplugin" `
    0 `
    $managedBaselineLog
if (-not (Test-Path -LiteralPath $personalPlugin -PathType Container)) {
    throw 'Managed marker-rollback fixture could not establish its baseline plugin.'
}
Assert-MarketplaceState $true
$managedPluginBeforeMarkerFailure = Get-TreeSnapshot $personalPlugin
$marketplaceBeforeMarkerFailure = [Convert]::ToBase64String([IO.File]::ReadAllBytes($personalMarketplace))
$registeredMarkerPath = Join-Path $productRoot 'plugin-registered.marker'
if (-not (Test-Path -LiteralPath $registeredMarkerPath -PathType Leaf)) {
    throw 'Managed marker-rollback fixture baseline has no registration marker.'
}
Remove-Item -LiteralPath $registeredMarkerPath -Force
New-Item -ItemType Directory -Path $registeredMarkerPath | Out-Null
try {
    $managedMarkerFailureLog = Join-Path $env:RUNNER_TEMP 'cso-managed-plugin-marker-commit-failure.log'
    $managedMarkerFailureText = Invoke-Setup `
        $SetupPath `
        "$silentBase /TYPE=full /COMPONENTS=workbench,codexplugin" `
        72 `
        $managedMarkerFailureLog
    Assert-LogCount $managedMarkerFailureText 'Starting the installation process' 1
    if ((Get-TreeSnapshot $personalPlugin) -ne $managedPluginBeforeMarkerFailure) {
        throw 'Marker commit failure did not restore the exact pre-upgrade managed plugin.'
    }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($personalMarketplace)) -ne
        $marketplaceBeforeMarkerFailure) {
        throw 'Marker commit failure did not restore the exact pre-upgrade marketplace.'
    }
    Assert-MarketplaceState $true
    if (Test-Path -LiteralPath $pluginTransactionPath) {
        throw 'Managed marker commit failure retained its helper transaction.'
    }
}
finally {
    if (Test-Path -LiteralPath $registeredMarkerPath -PathType Container) {
        [IO.Directory]::Delete($registeredMarkerPath, $false)
    }
}
Invoke-Uninstall -PurgeData
if ((Test-Path -LiteralPath $productRoot) -or
    (Test-Path -LiteralPath $personalPlugin) -or
    (Test-Path -LiteralPath $dataRoot)) {
    throw 'Managed marker-rollback fixture cleanup retained product, plugin, or data state.'
}
Assert-MarketplaceState $false

$answerFile = Join-Path $env:RUNNER_TEMP 'cso-selection-loadinf.ini'
$answerFileText = @(
    '[Setup]',
    'Lang=default',
    "Dir=$productRoot",
    'Group=Skill Organizer for Codex',
    'NoIcons=0',
    'SetupType=custom',
    'Components=workbench,codexplugin',
    'Tasks='
) -join "`r`n"
[IO.File]::WriteAllText($answerFile, $answerFileText + "`r`n", [Text.UTF8Encoding]::new($false))

$selectionCases = @(
    [pscustomobject]@{ Name = 'type-desktop'; Arguments = '/TYPE=desktop'; Plugin = $false },
    [pscustomobject]@{ Name = 'type-full'; Arguments = '/TYPE=full'; Plugin = $true },
    [pscustomobject]@{ Name = 'custom-desktop'; Arguments = '/TYPE=custom /COMPONENTS=workbench'; Plugin = $false },
    [pscustomobject]@{ Name = 'custom-full'; Arguments = '/TYPE=custom /COMPONENTS=workbench,codexplugin'; Plugin = $true },
    [pscustomobject]@{ Name = 'loadinf'; Arguments = "/LOADINF=`"$answerFile`""; Plugin = $true }
)

for ($index = 0; $index -lt $selectionCases.Count; $index++) {
    $case = $selectionCases[$index]
    $beforeMarketplace = Get-FileSetSnapshot @($personalMarketplace)
    $logPath = Join-Path $env:RUNNER_TEMP "cso-selection-$($case.Name).log"
    $logText = Invoke-Setup $SetupPath "$silentBase $($case.Arguments)" 0 $logPath
    Assert-LogCount $logText 'Preserving the explicit command-line or answer-file component selection.' 1

    $packagedPlugin = Join-Path $productRoot "versions\$Version\plugin\codex-skill-organizer"
    if ((Test-Path -LiteralPath $packagedPlugin -PathType Container) -ne $case.Plugin) {
        throw "Packaged plugin state did not match selection case $($case.Name)."
    }
    if ((Test-Path -LiteralPath $personalPlugin -PathType Container) -ne $case.Plugin) {
        throw "Managed plugin state did not match selection case $($case.Name)."
    }
    Assert-MarketplaceState $case.Plugin
    if (-not $case.Plugin -and (Get-FileSetSnapshot @($personalMarketplace)) -ne $beforeMarketplace) {
        throw "Desktop-only selection case $($case.Name) changed the personal marketplace."
    }

    if ($index -eq ($selectionCases.Count - 1)) {
        Invoke-Uninstall -PurgeData
    }
    else {
        Invoke-Uninstall
    }
    if (Test-Path -LiteralPath $productRoot) { throw "Uninstall after $($case.Name) retained the program root." }
    if (Test-Path -LiteralPath $personalPlugin) { throw "Uninstall after $($case.Name) retained the managed plugin." }
    Assert-MarketplaceState $false
}

if (Test-Path -LiteralPath $dataRoot) { throw 'Final selection-matrix purge retained Organizer data.' }
Write-Output 'Installer silent selection matrix passed.'
