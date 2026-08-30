#requires -Version 7.0

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'Installed service maintenance shutdown behavior tests require Windows.'
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$probePath = Join-Path $scriptRoot 'Invoke-InstalledServiceMaintenanceShutdown.ps1'
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$pwshPath = (Get-Command pwsh -CommandType Application -ErrorAction Stop).Source
$taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "cso-maintenance-test-$([Guid]::NewGuid().ToString('N'))"
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Stop-FixtureProcess([Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            $Process.Kill($true)
            $Process.WaitForExit(5000) | Out-Null
        }
    }
    finally {
        $Process.Dispose()
    }
}

function Invoke-MaintenanceScenario(
    [string]$Name,
    [bool]$CreateProcess,
    [bool]$UseExpectedNodePath,
    [bool]$CreateDescriptor,
    [bool]$RemoveDescriptor,
    [int]$ExpectedExitCode,
    [bool]$ExpectLauncher,
    [bool]$ExpectDescriptor,
    [bool]$ExpectProcessStopped,
    [string]$ExpectedOutput
) {
    $scenarioRoot = Join-Path $fixtureRoot $Name
    $versionRoot = Join-Path $scenarioRoot 'version'
    $runtimeRoot = Join-Path $versionRoot 'runtime'
    $dataRoot = Join-Path $scenarioRoot 'data'
    $descriptorPath = Join-Path $dataRoot 'runtime.json'
    $launcherPath = Join-Path $scenarioRoot 'stable-launcher.cmd'
    $launcherMarkerPath = Join-Path $scenarioRoot 'launcher-invoked.txt'
    $idleScriptPath = Join-Path $scenarioRoot 'idle.mjs'
    $fixtureProcess = $null

    New-Item -ItemType Directory -Path $runtimeRoot, $dataRoot -Force | Out-Null
    $expectedNodePath = Join-Path $runtimeRoot 'node.exe'
    Copy-Item -LiteralPath $nodePath -Destination $expectedNodePath
    [IO.File]::WriteAllText($idleScriptPath, 'setInterval(() => {}, 1000);', $utf8NoBom)

    try {
        if ($CreateProcess) {
            $processNodePath = if ($UseExpectedNodePath) { $expectedNodePath } else { $nodePath }
            $fixtureProcess = Start-Process `
                -FilePath $processNodePath `
                -ArgumentList "`"$idleScriptPath`"" `
                -PassThru `
                -WindowStyle Hidden
            if ($fixtureProcess.WaitForExit(250)) {
                throw "Maintenance fixture process exited before scenario '$Name'."
            }
        }

        if ($CreateDescriptor) {
            $descriptor = [ordered]@{
                service = 'codex-skill-organizer'
                host = '127.0.0.1'
                port = 49152
                pid = $fixtureProcess.Id
                token = 'fixture-session-token'
                credentialExpiresAt = [DateTimeOffset]::UtcNow.AddMinutes(5).ToUnixTimeMilliseconds()
                version = '0.2.0'
                protocolVersion = '2.0'
                installRoot = $versionRoot
            }
            [IO.File]::WriteAllText(
                $descriptorPath,
                ($descriptor | ConvertTo-Json -Compress),
                $utf8NoBom)
        }

        $launcherLines = @(
            '@echo off',
            'if not "%~1"=="--shutdown-for-maintenance" exit /b 3',
            "type nul > `"$launcherMarkerPath`""
        )
        if ($CreateProcess) {
            $launcherLines += "`"$taskkillPath`" /PID $($fixtureProcess.Id) /F >nul 2>nul"
        }
        if ($RemoveDescriptor) {
            $launcherLines += "del /f /q `"$descriptorPath`" >nul 2>nul"
        }
        $launcherLines += 'exit /b 0'
        [IO.File]::WriteAllLines($launcherPath, $launcherLines, $utf8NoBom)

        $previousRunnerTemp = $env:RUNNER_TEMP
        try {
            $env:RUNNER_TEMP = $scenarioRoot
            $probeOutput = @(
                & $pwshPath -NoProfile -File $probePath `
                    -DataRoot $dataRoot `
                    -VersionRoot $versionRoot `
                    -ExpectedVersion '0.2.0' `
                    -StableLauncher $launcherPath 2>&1
            )
            $probeExitCode = $LASTEXITCODE
        }
        finally {
            if ($null -eq $previousRunnerTemp) {
                Remove-Item Env:RUNNER_TEMP -ErrorAction SilentlyContinue
            }
            else {
                $env:RUNNER_TEMP = $previousRunnerTemp
            }
        }
        $actualOutput = (($probeOutput | ForEach-Object { [string]$_ }) -join "`n").Trim()
        if ($probeExitCode -ne $ExpectedExitCode) {
            throw "Maintenance scenario '$Name' exited $probeExitCode instead of $ExpectedExitCode."
        }
        if ($actualOutput -cne $ExpectedOutput) {
            $outputCategory = switch ($actualOutput) {
                '::error::Unable to verify the seeded backend before upgrade smoke.' { 'verify-failed' }
                '::error::Unable to stop the seeded backend before upgrade smoke.' { 'shutdown-failed' }
                '' { 'empty' }
                default {
                    if ($actualOutput.Contains('::error::Unable to stop the seeded backend before upgrade smoke.')) {
                        'shutdown-failed-with-extra-output'
                    }
                    elseif ($actualOutput.Contains('::error::Unable to verify the seeded backend before upgrade smoke.')) {
                        'verify-failed-with-extra-output'
                    }
                    else {
                        'unexpected'
                    }
                }
            }
            throw "Maintenance scenario '$Name' emitted output category '$outputCategory'."
        }
        if ((Test-Path -LiteralPath $launcherMarkerPath) -ne $ExpectLauncher) {
            throw "Maintenance scenario '$Name' launcher boundary did not match its expectation."
        }
        if ((Test-Path -LiteralPath $descriptorPath) -ne $ExpectDescriptor) {
            throw "Maintenance scenario '$Name' descriptor postcondition did not match its expectation."
        }
        if ($CreateProcess) {
            $fixtureProcess.Refresh()
            if (-not $fixtureProcess.HasExited) {
                $fixtureProcess.WaitForExit(5000) | Out-Null
                $fixtureProcess.Refresh()
            }
            if ($fixtureProcess.HasExited -ne $ExpectProcessStopped) {
                throw "Maintenance scenario '$Name' process postcondition did not match its expectation."
            }
        }
    }
    finally {
        Stop-FixtureProcess $fixtureProcess
        if (Test-Path -LiteralPath $scenarioRoot) {
            Remove-Item -LiteralPath $scenarioRoot -Recurse -Force
        }
    }
}

New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
    Invoke-MaintenanceScenario `
        -Name 'missing-descriptor' `
        -CreateProcess $false `
        -UseExpectedNodePath $false `
        -CreateDescriptor $false `
        -RemoveDescriptor $false `
        -ExpectedExitCode 1 `
        -ExpectLauncher $false `
        -ExpectDescriptor $false `
        -ExpectProcessStopped $false `
        -ExpectedOutput '::error::Unable to verify the seeded backend before upgrade smoke.'

    Invoke-MaintenanceScenario `
        -Name 'unexpected-process-path' `
        -CreateProcess $true `
        -UseExpectedNodePath $false `
        -CreateDescriptor $true `
        -RemoveDescriptor $true `
        -ExpectedExitCode 1 `
        -ExpectLauncher $false `
        -ExpectDescriptor $true `
        -ExpectProcessStopped $false `
        -ExpectedOutput '::error::Unable to verify the seeded backend before upgrade smoke.'

    Invoke-MaintenanceScenario `
        -Name 'descriptor-retained' `
        -CreateProcess $true `
        -UseExpectedNodePath $true `
        -CreateDescriptor $true `
        -RemoveDescriptor $false `
        -ExpectedExitCode 1 `
        -ExpectLauncher $true `
        -ExpectDescriptor $true `
        -ExpectProcessStopped $true `
        -ExpectedOutput '::error::Unable to stop the seeded backend before upgrade smoke.'

    Invoke-MaintenanceScenario `
        -Name 'verified-shutdown' `
        -CreateProcess $true `
        -UseExpectedNodePath $true `
        -CreateDescriptor $true `
        -RemoveDescriptor $true `
        -ExpectedExitCode 0 `
        -ExpectLauncher $true `
        -ExpectDescriptor $false `
        -ExpectProcessStopped $true `
        -ExpectedOutput ''
}
finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}

Write-Host 'Installed service maintenance shutdown behavior validation passed.'
