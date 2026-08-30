[CmdletBinding()]
param(
    [string]$Destination = ([Environment]::GetFolderPath('Desktop'))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'desktop-launch.ps1'
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "找不到启动器：$launcherPath"
}
if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

$shortcutPath = Join-Path $Destination 'Codex Skill Organizer.lnk'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $launcherPath
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = '打开 Codex Skill Organizer 本地工作台'
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',162'
$shortcut.Save()

Write-Output $shortcutPath
