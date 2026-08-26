#Requires -Version 7
<#
.SYNOPSIS
    Builds Rosetta, tags the commit, and publishes a GitHub release with the
    Chrome, Firefox and sources ZIPs attached.

.DESCRIPTION
    Wraps build.ps1, so the version bump, type-check, both browser builds and
    the packaging all happen here too. Needs the GitHub CLI (`gh`) installed
    and authenticated: https://cli.github.com

.EXAMPLE
    .\publish.ps1                  # prompts for the version
    .\publish.ps1 -Version 1.2.0   # non-interactive
    .\publish.ps1 -Draft           # create the release as a draft
    .\publish.ps1 -SkipBuild       # reuse the ZIPs already in .output
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Draft,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Require-Command([string]$name, [string]$hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name not found. $hint" }
}

Require-Command 'git' 'Install Git and make sure it is on PATH.'
Require-Command 'gh'  'Install the GitHub CLI: https://cli.github.com'

# Fail before building rather than after, when the push is what breaks.
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'gh is not authenticated. Run: gh auth login' }

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Host "Branch: $branch" -ForegroundColor Cyan

# Anything uncommitted other than the version bump would end up in the tag
# without being in the release, which is the kind of thing you only notice
# months later.
$dirty = (git status --porcelain) | Where-Object { $_ -notmatch '\s+package\.json$' }
if ($dirty) {
    Write-Host "`nUncommitted changes:" -ForegroundColor Yellow
    $dirty | ForEach-Object { Write-Host "  $_" }
    throw 'Commit or stash these first — the release should match the tag.'
}

if (-not $SkipBuild) {
    $buildArgs = @{}
    if ($Version) { $buildArgs['Version'] = $Version }
    # build.ps1 throws on failure, and $ErrorActionPreference stops us here.
    & "$PSScriptRoot\build.ps1" @buildArgs
}

# build.ps1 owns the version when it runs, so read back what it settled on.
# With -SkipBuild an explicit -Version wins, and package.json is the fallback.
if (-not $SkipBuild -or -not $Version) {
    $raw = Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw
    if ($raw -notmatch '"version"\s*:\s*"([^"]+)"') { throw 'No version field in package.json.' }
    $Version = $Matches[1]
}
$tag = "v$Version"

$out = Join-Path $PSScriptRoot '.output'
$assets = @(
    (Join-Path $out "rosetta-$Version-chrome.zip"),
    (Join-Path $out "rosetta-$Version-firefox.zip"),
    (Join-Path $out "rosetta-$Version-sources.zip")
)
$missing = $assets | Where-Object { -not (Test-Path $_) }
if ($missing) {
    throw "Missing ZIPs for $Version :`n  $($missing -join "`n  ")`nRun without -SkipBuild."
}

Write-Host "`nPublishing $tag" -ForegroundColor Cyan
$assets | ForEach-Object {
    Write-Host ("  {0} ({1:N0} KB)" -f (Split-Path $_ -Leaf), ((Get-Item $_).Length / 1KB))
}

if ((git tag --list $tag)) { throw "Tag $tag already exists. Bump the version or delete the tag." }

# The version bump is part of the release commit, not a stray change after it.
if ((git status --porcelain package.json)) {
    git add package.json
    git commit -m "Release $tag"
    if ($LASTEXITCODE -ne 0) { throw 'Commit failed.' }
}

git tag -a $tag -m "Rosetta $Version"
if ($LASTEXITCODE -ne 0) { throw 'Tagging failed.' }

git push origin $branch
if ($LASTEXITCODE -ne 0) { throw 'Push failed.' }
git push origin $tag
if ($LASTEXITCODE -ne 0) { git tag -d $tag; throw 'Pushing the tag failed; local tag removed.' }

$ghArgs = @('release', 'create', $tag, '--title', "Rosetta $Version", '--generate-notes')
if ($Draft) { $ghArgs += '--draft' }
$ghArgs += $assets

gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw "Release creation failed. The tag is pushed; retry with: gh release create $tag --title `"Rosetta $Version`" --generate-notes $($assets -join ' ')" }

Write-Host "`nPublished $tag" -ForegroundColor Green
gh release view $tag --json url --jq .url
if ($Draft) { Write-Host 'Draft — publish it from the GitHub UI when ready.' -ForegroundColor Yellow }
