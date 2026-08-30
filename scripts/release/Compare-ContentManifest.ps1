[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReferenceManifest,

    [Parameter(Mandatory = $true)]
    [string]$CandidateManifest
)

$ErrorActionPreference = 'Stop'

function Read-Manifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Content manifest does not exist: $Path"
    }
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($value.schemaVersion -ne 1 -or $value.algorithm -ne 'SHA-256' -or $null -eq $value.files) {
        throw "Unsupported content manifest: $Path"
    }
    return $value
}

$reference = Read-Manifest $ReferenceManifest
$candidate = Read-Manifest $CandidateManifest
$referenceLines = @($reference.files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.size, $_.sha256 })
$candidateLines = @($candidate.files | ForEach-Object { '{0}|{1}|{2}' -f $_.path, $_.size, $_.sha256 })
$difference = Compare-Object -ReferenceObject $referenceLines -DifferenceObject $candidateLines
if ($difference) {
    $rendered = $difference | ForEach-Object { '{0} {1}' -f $_.SideIndicator, $_.InputObject }
    throw "Release contents differ:`n$($rendered -join [Environment]::NewLine)"
}

Write-Output "Content manifests match: $($reference.files.Count) files."
