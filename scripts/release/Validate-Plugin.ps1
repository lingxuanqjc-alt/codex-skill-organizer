[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PluginRoot,

    [string]$MarketplacePath,

    [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PluginRoot)
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..'))
$securityGatePath = Join-Path $repoRoot 'scripts\security-gate.mjs'
if (-not $ExpectedVersion) {
    $ExpectedVersion = [string](
        Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw -Encoding UTF8 |
            ConvertFrom-Json
    ).version
}
if ($ExpectedVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "Expected plugin version must be strict semver: $ExpectedVersion"
}
$securityArguments = @('--plugin-root', $root)
if ($MarketplacePath) {
    $MarketplacePath = [System.IO.Path]::GetFullPath($MarketplacePath)
    $securityArguments += @('--marketplace-root', (Split-Path -Parent $MarketplacePath))
}
& node $securityGatePath @securityArguments
if ($LASTEXITCODE -ne 0) { throw 'Plugin publish tree failed the exact security allowlist.' }

$manifestPath = Join-Path $root '.codex-plugin\plugin.json'
$mcpPath = Join-Path $root '.mcp.json'
$skillPath = Join-Path $root 'skills\skill-organizer\SKILL.md'
$iconPath = Join-Path $root 'assets\skill-organizer.svg'
$launcherPath = Join-Path $root 'scripts\start-mcp.cmd'

foreach ($required in @($manifestPath, $mcpPath, $skillPath, $iconPath, $launcherPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required plugin file is missing: $required"
    }
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.name -ne 'codex-skill-organizer') { throw 'Plugin name must remain codex-skill-organizer.' }
if ($manifest.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw 'Plugin version must be strict semver.'
}
if ($manifest.version -ne $ExpectedVersion) {
    throw "Plugin version $($manifest.version) does not match expected $ExpectedVersion."
}
if ($manifest.author.name -ne 'lx' -or $manifest.license -ne 'MIT') { throw 'Plugin author/license metadata is incorrect.' }
if ($manifest.repository -ne 'https://github.com/lingxuanqjc-alt/codex-skill-organizer') { throw 'Plugin repository URL is incorrect.' }
if ($manifest.skills -ne './skills/' -or $manifest.mcpServers -ne './.mcp.json') { throw 'Plugin component paths are incorrect.' }
if ($manifest.interface.displayName -ne 'Skill Organizer for Codex') { throw 'Plugin display name is incorrect.' }
if ($manifest.interface.composerIcon -ne './assets/skill-organizer.svg') { throw 'Plugin icon path is incorrect.' }
if (@($manifest.interface.defaultPrompt).Count -gt 3) { throw 'Plugin defaultPrompt supports at most three entries.' }

$mcp = Get-Content -LiteralPath $mcpPath -Raw -Encoding UTF8 | ConvertFrom-Json
$server = $mcp.mcpServers.codex_skill_organizer
if ($server.type -ne 'stdio' -or $server.command -ne 'cmd.exe') { throw 'MCP must use the bounded Windows launcher script.' }
if (@($server.args) -notcontains 'scripts\start-mcp.cmd') { throw 'MCP launcher script is not configured.' }
$launcherText = Get-Content -LiteralPath $launcherPath -Raw -Encoding UTF8
if ($launcherText -match '(?im)^\s*(node|node\.exe)\b' -or $launcherText -match '(?i)where(?:\.exe)?\s+node') {
    throw 'Plugin launcher must never resolve Node from PATH.'
}

$skill = Get-Content -LiteralPath $skillPath -Raw -Encoding UTF8
if (-not $skill.StartsWith("---`n") -and -not $skill.StartsWith("---`r`n")) { throw 'SKILL.md must start with YAML frontmatter.' }
if ($skill -notmatch '(?m)^name:\s*skill-organizer\s*$' -or $skill -notmatch '(?m)^description:\s*\S') {
    throw 'SKILL.md frontmatter must contain the expected name and a description.'
}
if ($skill -match '\[TODO:') { throw 'SKILL.md contains an unfinished placeholder.' }

if ($MarketplacePath) {
    $marketplace = Get-Content -LiteralPath $MarketplacePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $entries = @($marketplace.plugins | Where-Object { $_.name -eq 'codex-skill-organizer' })
    if ($entries.Count -ne 1) { throw 'Marketplace must contain exactly one Organizer entry.' }
    $entry = $entries[0]
    if ($entry.source.source -ne 'local' -or $entry.source.path -ne './plugins/codex-skill-organizer') { throw 'Marketplace source is incorrect.' }
    if ($entry.policy.installation -ne 'AVAILABLE' -or $entry.policy.authentication -ne 'ON_INSTALL') { throw 'Marketplace policy is incomplete.' }
    if (-not $entry.category) { throw 'Marketplace entry requires a category.' }
}

Write-Output "Plugin validation passed: $root"
