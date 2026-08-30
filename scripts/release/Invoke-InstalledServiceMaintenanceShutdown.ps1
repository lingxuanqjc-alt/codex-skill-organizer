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

function Get-InstalledServiceDiagnostic(
    [string]$root,
    [string]$installedVersionRoot,
    [string]$expectedVersion
) {
    $descriptorPaths = @(
        (Join-Path $root 'runtime.json'),
        (Join-Path $root 'runtime\runtime.json')
    )
    $descriptorFileCount = 0
    $descriptorReadFailed = $false
    $descriptors = @()
    foreach ($descriptorPath in $descriptorPaths) {
        try {
            if (Test-Path -LiteralPath $descriptorPath -PathType Leaf -ErrorAction Stop) {
                $descriptorFileCount += 1
                $candidateDescriptor = Get-Content -LiteralPath $descriptorPath -Raw -ErrorAction Stop |
                    ConvertFrom-Json -ErrorAction Stop
                if ($null -ne $candidateDescriptor) { $descriptors += $candidateDescriptor }
            }
        }
        catch {
            $descriptorReadFailed = $true
        }
    }

    $nowWithReuseMargin = [DateTimeOffset]::UtcNow.AddSeconds(1).ToUnixTimeMilliseconds()
    $validDescriptors = @($descriptors | Where-Object {
        try {
            $descriptorPort = [int]$_.port
            $descriptorPid = [int]$_.pid
            $descriptorExpiry = [long]$_.credentialExpiresAt
            $_.service -eq 'codex-skill-organizer' -and
                $_.host -eq '127.0.0.1' -and
                $descriptorPort -gt 0 -and $descriptorPort -le 65535 -and
                $descriptorPid -gt 0 -and
                -not [string]::IsNullOrWhiteSpace([string]$_.token) -and
                $descriptorExpiry -gt $nowWithReuseMargin
        }
        catch {
            $false
        }
    })
    $boundaryValid = $descriptorFileCount -gt 0 -and
        -not $descriptorReadFailed -and
        $validDescriptors.Count -eq $descriptorFileCount
    $versionMatches = $validDescriptors.Count -gt 0
    $protocolCompatible = $validDescriptors.Count -gt 0
    $installRootMatches = $validDescriptors.Count -gt 0
    $pidAlive = $validDescriptors.Count -gt 0
    $processPathReadable = $validDescriptors.Count -gt 0
    $lexicalPathMatches = $validDescriptors.Count -gt 0
    $processHashMatches = $validDescriptors.Count -gt 0
    $processInspectionFailed = $false
    $hashReadFailed = $false
    $processPathContainsTilde = $false
    $expectedNodePath = [IO.Path]::GetFullPath((Join-Path $installedVersionRoot 'runtime\node.exe'))
    $expectedNodeExists = Test-Path -LiteralPath $expectedNodePath -PathType Leaf -ErrorAction SilentlyContinue
    $expectedNodeContainsTilde = $expectedNodePath.Contains('~')

    foreach ($descriptor in $validDescriptors) {
        $versionMatches = $versionMatches -and $descriptor.version -eq $expectedVersion
        $protocolCompatible = $protocolCompatible -and
            ([string]$descriptor.protocolVersion).StartsWith('2.', [StringComparison]::Ordinal)
        try {
            $installRootMatches = $installRootMatches -and
                [IO.Path]::GetFullPath([string]$descriptor.installRoot).Equals(
                    [IO.Path]::GetFullPath($installedVersionRoot),
                    [StringComparison]::OrdinalIgnoreCase)
        }
        catch {
            $installRootMatches = $false
        }

        $descriptorProcess = $null
        try {
            try {
                $descriptorProcess = [Diagnostics.Process]::GetProcessById([int]$descriptor.pid)
            }
            catch {
                $pidAlive = $false
                $processPathReadable = $false
                $lexicalPathMatches = $false
                $processHashMatches = $false
                continue
            }
            try {
                $descriptorHasExited = $descriptorProcess.HasExited
            }
            catch {
                $pidAlive = $false
                $processInspectionFailed = $true
                $processPathReadable = $false
                $lexicalPathMatches = $false
                $processHashMatches = $false
                continue
            }
            if ($descriptorHasExited) {
                $pidAlive = $false
                $processPathReadable = $false
                $lexicalPathMatches = $false
                $processHashMatches = $false
                continue
            }
            try {
                $actualProcessPath = $descriptorProcess.MainModule.FileName
            }
            catch {
                $processInspectionFailed = $true
                $processPathReadable = $false
                $lexicalPathMatches = $false
                $processHashMatches = $false
                continue
            }
            if ([string]::IsNullOrWhiteSpace($actualProcessPath)) {
                $processPathReadable = $false
                $lexicalPathMatches = $false
                $processHashMatches = $false
                continue
            }
            try {
                $processPathContainsTilde = $processPathContainsTilde -or $actualProcessPath.Contains('~')
                $lexicalPathMatches = $lexicalPathMatches -and
                    [IO.Path]::GetFullPath($actualProcessPath).Equals(
                        $expectedNodePath,
                        [StringComparison]::OrdinalIgnoreCase)
            }
            catch {
                $processInspectionFailed = $true
                $lexicalPathMatches = $false
                $processHashMatches = $false
                continue
            }
            try {
                $processHashMatches = $processHashMatches -and $expectedNodeExists -and
                    (Get-FileHash -LiteralPath $actualProcessPath -Algorithm SHA256 -ErrorAction Stop).Hash -eq
                        (Get-FileHash -LiteralPath $expectedNodePath -Algorithm SHA256 -ErrorAction Stop).Hash
            }
            catch {
                $hashReadFailed = $true
                $processHashMatches = $false
            }
        }
        finally {
            if ($null -ne $descriptorProcess) {
                try { $descriptorProcess.Dispose() }
                catch { $processInspectionFailed = $true }
            }
        }
    }

    return [pscustomobject]@{
        DescriptorFileCount = $descriptorFileCount
        ParsedDescriptorCount = $descriptors.Count
        ValidDescriptorCount = $validDescriptors.Count
        DescriptorReadFailed = $descriptorReadFailed
        BoundaryValid = $boundaryValid
        VersionMatches = $versionMatches
        ProtocolCompatible = $protocolCompatible
        InstallRootMatches = $installRootMatches
        ExpectedNodeExists = $expectedNodeExists
        PidAlive = $pidAlive
        ProcessPathReadable = $processPathReadable
        LexicalPathMatches = $lexicalPathMatches
        ProcessInspectionFailed = $processInspectionFailed
        HashReadFailed = $hashReadFailed
        ExpectedNodeContainsTilde = $expectedNodeContainsTilde
        ProcessPathContainsTilde = $processPathContainsTilde
        ProcessHashMatches = $processHashMatches
    }
}

function Write-InstalledServiceDiagnostic([string]$phase, [object]$diagnostic) {
    Write-Host "INSTALLED-SERVICE-DIAGNOSTIC: phase=$phase descriptorFiles=$($diagnostic.DescriptorFileCount) parsed=$($diagnostic.ParsedDescriptorCount) valid=$($diagnostic.ValidDescriptorCount) descriptorReadFailed=$($diagnostic.DescriptorReadFailed) boundaryValid=$($diagnostic.BoundaryValid) versionMatches=$($diagnostic.VersionMatches) protocolCompatible=$($diagnostic.ProtocolCompatible) installRootMatches=$($diagnostic.InstallRootMatches) expectedNodeExists=$($diagnostic.ExpectedNodeExists) pidAlive=$($diagnostic.PidAlive) processPathReadable=$($diagnostic.ProcessPathReadable) processInspectionFailed=$($diagnostic.ProcessInspectionFailed) lexicalPathMatches=$($diagnostic.LexicalPathMatches) hashReadFailed=$($diagnostic.HashReadFailed) expectedContainsTilde=$($diagnostic.ExpectedNodeContainsTilde) processContainsTilde=$($diagnostic.ProcessPathContainsTilde) hashMatches=$($diagnostic.ProcessHashMatches)"
}

Write-InstalledServiceDiagnostic 'before' (
    Get-InstalledServiceDiagnostic $DataRoot $VersionRoot $ExpectedVersion
)
$shutdownErrorPath = Join-Path $env:RUNNER_TEMP "cso-maintenance-shutdown-$([Guid]::NewGuid().ToString('N')).stderr"
$shutdownProcess = $null
$shutdownTimedOut = $false
$shutdownControlFailed = $false
$shutdownExitCode = '<unavailable>'
$shutdownErrorText = ''
$shutdownErrorReadFailed = $false
try {
    $shutdownProcess = Start-Process `
        -FilePath $StableLauncher `
        -ArgumentList '--shutdown-for-maintenance' `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardError $shutdownErrorPath
    $shutdownTimedOut = -not $shutdownProcess.WaitForExit(60000)
    if ($shutdownTimedOut) {
        $shutdownExitCode = '<timeout>'
        try {
            $shutdownProcess.Kill($true)
            $shutdownProcess.WaitForExit(5000) | Out-Null
        }
        catch {
            $shutdownControlFailed = $true
        }
    }
    if (-not $shutdownTimedOut) {
        $shutdownExitCode = $shutdownProcess.ExitCode
    }
    if (Test-Path -LiteralPath $shutdownErrorPath -PathType Leaf -ErrorAction Stop) {
        try {
            $shutdownErrorText = [string](Get-Content -LiteralPath $shutdownErrorPath -Raw -ErrorAction Stop)
        }
        catch {
            $shutdownErrorReadFailed = $true
        }
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
    Remove-Item -LiteralPath $shutdownErrorPath -Force -ErrorAction SilentlyContinue
}

$shutdownStage = if ($shutdownControlFailed) {
    'process-control'
} elseif ($shutdownTimedOut) {
    'timeout'
} elseif ($shutdownExitCode -eq 1) {
    'maintenance'
} elseif ($shutdownExitCode -eq 2) {
    'stable-forwarding'
} else {
    'unexpected'
}
$shutdownCategory = if ($shutdownControlFailed) {
    'process-control-failed'
} elseif ($shutdownTimedOut) {
    'timeout'
} elseif ($shutdownExitCode -eq 0) {
    'success'
} elseif ($shutdownErrorReadFailed) {
    'stderr-read-failed'
} elseif ([string]::IsNullOrWhiteSpace($shutdownErrorText)) {
    'no-stderr'
} elseif ($shutdownErrorText.Contains('outside the installed product boundary')) {
    'install-root-boundary-rejected'
} elseif ($shutdownErrorText.Contains('PID is not the bundled Organizer runtime')) {
    'runtime-process-boundary-rejected'
} elseif ($shutdownErrorText -match '(?i)access.+denied|denied.+access|拒绝访问') {
    'process-access-denied'
} else {
    'unclassified'
}
$safeShutdownStage = switch ([string]$shutdownStage) {
    'process-control' { 'process-control' }
    'timeout' { 'timeout' }
    'maintenance' { 'maintenance' }
    'stable-forwarding' { 'stable-forwarding' }
    default { 'unexpected' }
}
$safeShutdownCategory = switch ([string]$shutdownCategory) {
    'process-control-failed' { 'process-control-failed' }
    'timeout' { 'timeout' }
    'success' { 'success' }
    'stderr-read-failed' { 'stderr-read-failed' }
    'no-stderr' { 'no-stderr' }
    'install-root-boundary-rejected' { 'install-root-boundary-rejected' }
    'runtime-process-boundary-rejected' { 'runtime-process-boundary-rejected' }
    'process-access-denied' { 'process-access-denied' }
    default { 'unclassified' }
}
$safeShutdownExitCode = if ($shutdownExitCode -is [int]) {
    [int]$shutdownExitCode
} elseif ($shutdownExitCode -eq '<timeout>') {
    '<timeout>'
} else {
    '<unavailable>'
}
$afterShutdownDiagnostic = Get-InstalledServiceDiagnostic $DataRoot $VersionRoot $ExpectedVersion
if ($shutdownControlFailed -or $shutdownTimedOut -or $shutdownExitCode -ne 0) {
    Write-Host "INSTALLED-SHUTDOWN-DIAGNOSTIC: stage=$safeShutdownStage category=$safeShutdownCategory exitCode=$safeShutdownExitCode"
    Write-InstalledServiceDiagnostic 'after' $afterShutdownDiagnostic
    Write-Host '::error::Unable to stop the seeded backend before upgrade smoke.'
    exit 1
}

exit 0
