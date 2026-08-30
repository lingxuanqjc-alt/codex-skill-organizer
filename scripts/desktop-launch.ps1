[CmdletBinding()]
param(
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $projectRoot 'dist\server.mjs'
$runtimeDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexSkillOrganizer'
$runtimePath = Join-Path $runtimeDirectory 'runtime.json'
$stdoutPath = Join-Path $runtimeDirectory 'service.stdout.log'
$stderrPath = Join-Path $runtimeDirectory 'service.stderr.log'
$mutexName = 'Local\CodexSkillOrganizerLauncher'
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false

function Get-OrganizerRuntime {
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
        return $null
    }

    try {
        $descriptor = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
        $port = [int]$descriptor.port
        if ($port -lt 1 -or $port -gt 65535 -or [string]::IsNullOrWhiteSpace([string]$descriptor.token)) {
            return $null
        }
        return $descriptor
    }
    catch {
        return $null
    }
}

function Test-OrganizerRuntime {
    param([Parameter(Mandatory = $true)]$Descriptor)

    try {
        $healthUrl = 'http://127.0.0.1:{0}/api/health' -f ([int]$Descriptor.port)
        $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        return $health.ok -eq $true -and $health.service -eq 'codex-skill-organizer'
    }
    catch {
        return $false
    }
}

function Open-OrganizerWorkbench {
    param([Parameter(Mandatory = $true)]$Descriptor)

    if ($NoBrowser) {
        return
    }
    $encodedToken = [Uri]::EscapeDataString([string]$Descriptor.token)
    $workbenchUrl = 'http://127.0.0.1:{0}/#bootstrap={1}' -f ([int]$Descriptor.port), $encodedToken
    Start-Process -FilePath $workbenchUrl | Out-Null
}

function Show-LaunchFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    if ($NoBrowser) {
        Write-Error $Message
        return
    }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        $Message,
        'Codex Skill Organizer 启动失败',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
}

try {
    try {
        $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(20))
    }
    catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw '另一个启动操作仍在进行。请稍候几秒后重试。'
    }

    $runtime = Get-OrganizerRuntime
    if ($null -ne $runtime -and (Test-OrganizerRuntime -Descriptor $runtime)) {
        Open-OrganizerWorkbench -Descriptor $runtime
        return
    }

    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw "缺少已构建服务：$serverPath。请先在项目目录运行 npm run build。"
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw '未找到 Node.js。请安装 Node.js 24 或更高版本后重试。'
    }

    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $process = Start-Process `
        -FilePath $nodeCommand.Source `
        -ArgumentList @(('"{0}"' -f $serverPath)) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $runtime = Get-OrganizerRuntime
        if ($null -ne $runtime -and (Test-OrganizerRuntime -Descriptor $runtime)) {
            Open-OrganizerWorkbench -Descriptor $runtime
            return
        }
        if ($process.HasExited) {
            $detail = if (Test-Path -LiteralPath $stderrPath) {
                (Get-Content -LiteralPath $stderrPath -Tail 12) -join [Environment]::NewLine
            }
            else {
                '服务未写出错误日志。'
            }
            throw "本地服务提前退出（代码 $($process.ExitCode)）。`n$detail"
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "本地服务在 30 秒内未就绪。请查看：$stderrPath"
}
catch {
    Show-LaunchFailure -Message $_.Exception.Message
    exit 1
}
finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
