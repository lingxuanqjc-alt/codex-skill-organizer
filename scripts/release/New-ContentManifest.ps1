[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Manifest root does not exist: $resolvedRoot"
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$files = @(
    Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force |
        Where-Object { [System.IO.Path]::GetFullPath($_.FullName) -ne $resolvedOutput } |
        ForEach-Object {
            $relative = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\', '/').Replace('\', '/')
            [ordered]@{
                path = $relative
                size = [int64]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } |
        Sort-Object -Property path
)

$manifest = [ordered]@{
    schemaVersion = 1
    algorithm = 'SHA-256'
    files = $files
}

$outputParent = Split-Path -Parent $resolvedOutput
if ($outputParent) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($resolvedOutput, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
Write-Output $resolvedOutput
