function Get-CanonicalTextSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$LiteralPath
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($LiteralPath)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Canonical text hash input does not exist: $resolvedPath"
    }

    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $text = $utf8.GetString([System.IO.File]::ReadAllBytes($resolvedPath))
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) {
        throw "Canonical text hash input must be UTF-8 without a BOM: $resolvedPath"
    }
    $canonicalText = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    $canonicalBytes = $utf8.GetBytes($canonicalText)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return [System.BitConverter]::ToString($sha256.ComputeHash($canonicalBytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}
