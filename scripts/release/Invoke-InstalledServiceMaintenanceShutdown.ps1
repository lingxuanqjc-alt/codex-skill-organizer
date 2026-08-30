#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$DataRoot,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$VersionRoot,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ExpectedVersion,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$StableLauncher
)

$ErrorActionPreference = 'Stop'

function Get-ExpectedServiceProcessIds(
    [string[]]$DescriptorPaths,
    [string]$InstalledVersionRoot,
    [string]$ExpectedProductVersion
) {
    $descriptors = @()
    foreach ($descriptorPath in $DescriptorPaths) {
        if (Test-Path -LiteralPath $descriptorPath -PathType Leaf -ErrorAction Stop) {
            $descriptor = Get-Content -LiteralPath $descriptorPath -Raw -ErrorAction Stop |
                ConvertFrom-Json -ErrorAction Stop
            if ($null -eq $descriptor) { throw 'Runtime descriptor is empty.' }
            $descriptors += $descriptor
        }
    }
    if ($descriptors.Count -eq 0) { throw 'Runtime descriptor is missing.' }

    $expectedNodePath = [IO.Path]::GetFullPath((Join-Path $InstalledVersionRoot 'runtime\node.exe'))
    if (-not (Test-Path -LiteralPath $expectedNodePath -PathType Leaf -ErrorAction Stop)) {
        throw 'Bundled runtime is missing.'
    }
    $expectedNodeHash = (Get-FileHash -LiteralPath $expectedNodePath -Algorithm SHA256 -ErrorAction Stop).Hash
    $expectedInstallRoot = [IO.Path]::TrimEndingDirectorySeparator(
        [IO.Path]::GetFullPath($InstalledVersionRoot))
    $nowWithReuseMargin = [DateTimeOffset]::UtcNow.AddSeconds(1).ToUnixTimeMilliseconds()
    $processIds = @()

    foreach ($descriptor in $descriptors) {
        $descriptorPort = [int]$descriptor.port
        $descriptorPid = [int]$descriptor.pid
        $descriptorExpiry = [long]$descriptor.credentialExpiresAt
        $descriptorInstallRoot = [IO.Path]::TrimEndingDirectorySeparator(
            [IO.Path]::GetFullPath([string]$descriptor.installRoot))
        if ($descriptor.service -ne 'codex-skill-organizer' -or
            $descriptor.host -ne '127.0.0.1' -or
            $descriptorPort -le 0 -or $descriptorPort -gt 65535 -or
            $descriptorPid -le 0 -or
            [string]::IsNullOrWhiteSpace([string]$descriptor.token) -or
            $descriptorExpiry -le $nowWithReuseMargin -or
            $descriptor.version -ne $ExpectedProductVersion -or
            -not ([string]$descriptor.protocolVersion).StartsWith('2.', [StringComparison]::Ordinal) -or
            -not $descriptorInstallRoot.Equals($expectedInstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Runtime descriptor failed the installed-service boundary.'
        }

        $descriptorProcess = $null
        try {
            $descriptorProcess = [Diagnostics.Process]::GetProcessById($descriptorPid)
            if ($descriptorProcess.HasExited) { throw 'Observed runtime process already exited.' }
            $actualProcessPath = $descriptorProcess.MainModule.FileName
            if ([string]::IsNullOrWhiteSpace($actualProcessPath) -or
                -not [IO.Path]::GetFullPath($actualProcessPath).Equals(
                    $expectedNodePath,
                    [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Observed runtime process is outside the installed product boundary.'
            }
            $actualProcessHash = (Get-FileHash -LiteralPath $actualProcessPath -Algorithm SHA256 -ErrorAction Stop).Hash
            if ($actualProcessHash -ne $expectedNodeHash) {
                throw 'Observed runtime process does not match the bundled runtime.'
            }
        }
        finally {
            if ($null -ne $descriptorProcess) { $descriptorProcess.Dispose() }
        }
        $processIds += $descriptorPid
    }

    return @($processIds | Select-Object -Unique)
}

function Test-ObservedProcessesExited([int[]]$ProcessIds) {
    if ($ProcessIds.Count -eq 0) { return $false }
    foreach ($processId in $ProcessIds) {
        $observedProcess = $null
        $observedProcessExited = $false
        $observedProcessDisposeFailed = $false
        try {
            $observedProcess = [Diagnostics.Process]::GetProcessById($processId)
            $observedProcessExited = $observedProcess.HasExited
        }
        catch [ArgumentException] {
            # The exact process observed before shutdown no longer exists.
            $observedProcessExited = $true
        }
        catch {
            return $false
        }
        finally {
            if ($null -ne $observedProcess) {
                try { $observedProcess.Dispose() }
                catch { $observedProcessDisposeFailed = $true }
            }
        }
        if ($observedProcessDisposeFailed -or -not $observedProcessExited) { return $false }
    }
    return $true
}

function Test-DescriptorFilesRemoved([string[]]$DescriptorPaths) {
    foreach ($descriptorPath in $DescriptorPaths) {
        try {
            if (Test-Path -LiteralPath $descriptorPath -ErrorAction Stop) { return $false }
        }
        catch {
            return $false
        }
    }
    return $true
}

$descriptorPaths = @(
    (Join-Path $DataRoot 'runtime.json'),
    (Join-Path $DataRoot 'runtime\runtime.json')
)
$observedProcessIds = @()
$preconditionFailed = $false
try {
    $observedProcessIds = @(
        Get-ExpectedServiceProcessIds $descriptorPaths $VersionRoot $ExpectedVersion)
}
catch {
    $preconditionFailed = $true
}
if ($preconditionFailed -or $observedProcessIds.Count -eq 0) {
    Write-Host '::error::Unable to verify the seeded backend before upgrade smoke.'
    exit 1
}

$shutdownErrorPath = $null
$shutdownProcess = $null
$shutdownTimedOut = $false
$shutdownControlFailed = $false
$shutdownExitCode = $null
try {
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
        throw 'Runner temporary directory is unavailable.'
    }
    $shutdownErrorPath = Join-Path $env:RUNNER_TEMP "cso-maintenance-shutdown-$([Guid]::NewGuid().ToString('N')).stderr"
    $shutdownProcess = Start-Process `
        -FilePath $StableLauncher `
        -ArgumentList '--shutdown-for-maintenance' `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardError $shutdownErrorPath
    $shutdownTimedOut = -not $shutdownProcess.WaitForExit(60000)
    if ($shutdownTimedOut) {
        try {
            $shutdownProcess.Kill($true)
            $shutdownProcess.WaitForExit(5000) | Out-Null
        }
        catch {
            $shutdownControlFailed = $true
        }
    }
    else {
        $shutdownExitCode = $shutdownProcess.ExitCode
    }
}
catch {
    $shutdownControlFailed = $true
}
finally {
    if ($null -ne $shutdownProcess) {
        try { $shutdownProcess.Dispose() }
        catch { $shutdownControlFailed = $true }
    }
    try {
        if ([string]::IsNullOrWhiteSpace($shutdownErrorPath)) {
            throw 'Shutdown stderr path was not initialized.'
        }
        if (Test-Path -LiteralPath $shutdownErrorPath -ErrorAction Stop) {
            Remove-Item -LiteralPath $shutdownErrorPath -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $shutdownErrorPath -ErrorAction Stop) {
            $shutdownControlFailed = $true
        }
    }
    catch {
        $shutdownControlFailed = $true
    }
}

$observedProcessesExited = Test-ObservedProcessesExited $observedProcessIds
$descriptorFilesRemoved = Test-DescriptorFilesRemoved $descriptorPaths
if ($shutdownControlFailed -or $shutdownTimedOut -or $shutdownExitCode -ne 0 -or
    -not $observedProcessesExited -or -not $descriptorFilesRemoved) {
    Write-Host '::error::Unable to stop the seeded backend before upgrade smoke.'
    exit 1
}

exit 0
