#Requires -Version 7
<#
.SYNOPSIS
    Sets the version, type-checks, builds and packages Rosetta.

.EXAMPLE
    .\build.ps1                 # prompts for the version
    .\build.ps1 -Version 1.2.0  # non-interactive
    .\build.ps1 -NoZip          # skip packaging
    .\build.ps1 -ChromeOnly     # skip the Firefox target
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$NoZip,
    [switch]$ChromeOnly
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$pkgPath = Join-Path $PSScriptRoot 'package.json'
if (-not (Test-Path $pkgPath)) { throw "package.json not found next to this script." }

$raw = Get-Content $pkgPath -Raw
if ($raw -notmatch '"version"\s*:\s*"([^"]+)"') { throw 'No version field in package.json.' }
$current = $Matches[1]

function Get-NextPatch([string]$v) {
    if ($v -match '^(\d+)\.(\d+)\.(\d+)$') {
        return "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
    }
    return $v
}

if (-not $Version) {
    $suggested = Get-NextPatch $current
    Write-Host "Current version: $current" -ForegroundColor Cyan
    $answer = Read-Host "New version [$suggested]"
    $Version = if ([string]::IsNullOrWhiteSpace($answer)) { $suggested } else { $answer.Trim() }
}

# Chrome requires up to four dot-separated integers in the manifest version.
if ($Version -notmatch '^\d+(\.\d+){1,3}$') {
    throw "Version '$Version' must look like 1.2.3 (numbers and dots only)."
}

if ($Version -ne $current) {
    # Patch only the first "version" field so the file's formatting survives.
    $updated = [regex]::Replace($raw, '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}", 1)
    Set-Content -Path $pkgPath -Value $updated -NoNewline -Encoding utf8
    Write-Host "package.json: $current -> $Version" -ForegroundColor Green
}
else {
    Write-Host "Version unchanged ($current)" -ForegroundColor Yellow
}

Write-Host "`nType-checking..." -ForegroundColor Cyan
npm run compile
if ($LASTEXITCODE -ne 0) { throw 'svelte-check failed - build aborted.' }

Write-Host "`nBuilding..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

if (-not $NoZip) {
    Write-Host "`nPackaging..." -ForegroundColor Cyan
    npm run zip
    if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
}

if (-not $ChromeOnly) {
    # A separate target, not a repackage of the Chrome build: AMO rejects
    # `background.service_worker`, so WXT emits `background.scripts` here, the
    # manifest picks up the gecko id and data-collection declaration, and the
    # offline model is dropped (no chrome.offscreen in Firefox).
    Write-Host "`nBuilding Firefox (MV3)..." -ForegroundColor Cyan
    if ($NoZip) { npm run build:firefox } else { npm run zip:firefox }
    if ($LASTEXITCODE -ne 0) { throw 'Firefox build failed.' }
}

$out = Join-Path $PSScriptRoot '.output'
Write-Host "`nRosetta $Version ready." -ForegroundColor Green
Write-Host "  unpacked: $(Join-Path $out 'chrome-mv3')"
if (-not $ChromeOnly) { Write-Host "  unpacked: $(Join-Path $out 'firefox-mv3')" }
if (-not $NoZip) {
    $take = if ($ChromeOnly) { 1 } else { 3 }
    Get-ChildItem $out -Filter '*.zip' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First $take |
        ForEach-Object {
            Write-Host "  zip:      $($_.FullName) ($([math]::Round($_.Length / 1KB)) KB)"
        }
}
Write-Host "`nLoad unpacked in brave://extensions to pick up the new build."
if (-not $ChromeOnly) {
    # Temporary add-on: Firefox drops it when the browser closes, and any file
    # inside the folder will do as the target.
    Write-Host "Firefox: about:debugging#/runtime/this-firefox -> Load Temporary Add-on ->"
    Write-Host "  $(Join-Path $out 'firefox-mv3\manifest.json')"
}
