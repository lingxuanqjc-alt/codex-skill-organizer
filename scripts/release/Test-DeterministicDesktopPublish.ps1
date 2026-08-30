[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$globalSdk = (Get-Content -LiteralPath (Join-Path $repoRoot 'global.json') -Raw | ConvertFrom-Json).sdk
$dotnetVersion = (& dotnet --version).Trim()
if ($LASTEXITCODE -ne 0 -or $dotnetVersion -ne $globalSdk.version) {
    throw "Deterministic publish requires .NET SDK $($globalSdk.version), got '$dotnetVersion'."
}
if ($package.version -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    throw "package.json contains an invalid version: $($package.version)"
}
$assemblyVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('cso-repro-' + [Guid]::NewGuid().ToString('N'))

function Copy-DesktopSource([string]$Destination) {
    New-Item -ItemType Directory -Path (Join-Path $Destination 'desktop') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'global.json') -Destination $Destination -Force
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'desktop') -Force |
        Where-Object { $_.Name -notin @('bin', 'obj') } |
        ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination 'desktop') -Recurse -Force
        }
}

function Assert-BinaryDoesNotContainAscii([string]$File, [string[]]$Needles) {
    $normalizedNeedles = @(
        $Needles |
            Where-Object { $_ } |
            ForEach-Object {
                Write-Output $_
                Write-Output ($_.Replace('\', '/'))
            } |
            Select-Object -Unique
    )
    $maxLength = ($normalizedNeedles | Measure-Object -Property Length -Maximum).Maximum
    $buffer = [byte[]]::new(1MB)
    $tail = ''
    $stream = [System.IO.File]::OpenRead($File)
    try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $text = $tail + [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            foreach ($needle in $normalizedNeedles) {
                if ($text.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    throw "Published executable contains an absolute build path: $needle"
                }
            }
            $tailLength = [Math]::Min([Math]::Max(0, $maxLength - 1), $text.Length)
            $tail = if ($tailLength -eq 0) { '' } else { $text.Substring($text.Length - $tailLength) }
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Invoke-Publish([string]$SourceRoot, [string]$OutputRoot, [string]$ManifestPath) {
    Copy-DesktopSource $SourceRoot
    $project = Join-Path $SourceRoot 'desktop\SkillOrganizerForCodex.Desktop.csproj'
    Push-Location $SourceRoot
    try {
        & dotnet restore $project -r win-x64 --locked-mode | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Locked restore failed under $SourceRoot" }
        & dotnet publish $project `
            -c Release -p:Platform=x64 -r win-x64 --self-contained true --no-restore `
            -p:PublishSingleFile=true `
            "-p:Version=$($package.version)" `
            "-p:AssemblyVersion=$assemblyVersion" `
            "-p:FileVersion=$assemblyVersion" `
            -o $OutputRoot | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Deterministic publish failed under $SourceRoot" }
    }
    finally {
        Pop-Location
    }
    Get-ChildItem -LiteralPath $OutputRoot -File -Recurse |
        Where-Object { $_.Extension -in @('.pdb', '.xml') } |
        Remove-Item -Force
    $executable = Join-Path $OutputRoot 'SkillOrganizerForCodex.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "Desktop publish did not create $executable"
    }
    Assert-BinaryDoesNotContainAscii $executable @($repoRoot, $SourceRoot)
    & (Join-Path $scriptRoot 'New-ContentManifest.ps1') -Root $OutputRoot -OutputPath $ManifestPath | Out-Null
    return $executable
}

try {
    $sourceA = Join-Path $temporaryRoot 'a'
    $sourceB = Join-Path $temporaryRoot 'a-much-longer-independent-source-directory'
    $outputA = Join-Path $temporaryRoot 'out-a'
    $outputB = Join-Path $temporaryRoot 'out-b'
    $manifestA = Join-Path $temporaryRoot 'manifest-a.json'
    $manifestB = Join-Path $temporaryRoot 'manifest-b.json'
    $executableA = Invoke-Publish $sourceA $outputA $manifestA
    $executableB = Invoke-Publish $sourceB $outputB $manifestB
    & (Join-Path $scriptRoot 'Compare-ContentManifest.ps1') `
        -ReferenceManifest $manifestA `
        -CandidateManifest $manifestB | Out-Null
    $hashA = (Get-FileHash -LiteralPath $executableA -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashB = (Get-FileHash -LiteralPath $executableB -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hashA -ne $hashB) { throw 'Desktop executable hashes differ across absolute source paths.' }
    Write-Output "Deterministic desktop publish passed: $hashA"
}
finally {
    $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if ($resolvedTemporaryRoot.StartsWith($systemTemp + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemporaryRoot).StartsWith('cso-repro-')) {
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
