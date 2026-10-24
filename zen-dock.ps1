# zen-dock.ps1 - start the Zen-Dock local panel
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File "D:\work\Project\Zen-Dock\zen-dock.ps1"
#   ... -Restart          stop the old instance on the same port first
#   ... -NoOpen           do not open the browser
#   ... --port 7718       extra args are passed through to node index.mjs
#
# Two hard rules for PowerShell 5.1 (same as run-relay.ps1):
#   1. always use $PSScriptRoot, never hard-code a path containing non-ASCII
#      characters - a BOM-less .ps1 is decoded as GBK and would lose the anchor;
#   2. keep runtime strings ASCII, non-ASCII only in comments.
# This file is intentionally all-ASCII so it survives any code page.

param(
  [switch]$Restart,
  [switch]$NoOpen,
  [Parameter(ValueFromRemainingArguments = $true)] $RestArgs
)

$ErrorActionPreference = "Stop"
$toolDir = $PSScriptRoot
$entry = Join-Path $toolDir "index.mjs"
$nodeCmd = "node"

if (-not (Test-Path $entry)) {
  Write-Host "[zen-dock] index.mjs not found in $toolDir" -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

$nodeVersion = & $nodeCmd --version 2>$null
if (-not $nodeVersion) {
  Write-Host "[zen-dock] node not found in PATH. Install Node.js 20+ first." -ForegroundColor Red
  Read-Host "Press Enter to close"
  exit 1
}

# figure out which port we will listen on (default 7717, overridable via --port)
$port = 7717
for ($i = 0; $i -lt $RestArgs.Count; $i++) {
  if ($RestArgs[$i] -eq "--port" -and $i + 1 -lt $RestArgs.Count) {
    $port = [int]$RestArgs[$i + 1]
  }
}

function Get-PidOnPort([int]$p) {
  $rows = netstat -ano | Select-String -Pattern ":$p\s" | Select-String -Pattern "LISTENING"
  foreach ($row in $rows) {
    $cols = ($row.Line.Trim() -split '\s+')
    if ($cols.Length -ge 5) {
      $candidate = 0
      if ([int]::TryParse($cols[-1], [ref]$candidate)) { return $candidate }
    }
  }
  return $null
}

$existing = Get-PidOnPort $port
if ($existing) {
  if ($Restart) {
    Write-Host "[zen-dock] port $port is held by pid $existing, stopping it (-Restart)" -ForegroundColor Yellow
    try { & taskkill /PID $existing /T /F | Out-Null } catch { }
    Start-Sleep -Milliseconds 700
  } else {
    Write-Host "[zen-dock] port $port is already in use (pid $existing)." -ForegroundColor Yellow
    Write-Host "           run again with -Restart to replace it, or pass --port <n>." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
  }
}

$nodeArgs = @($entry)
if ($NoOpen) { $nodeArgs += "--no-open" }
if ($RestArgs.Count -gt 0) { $nodeArgs += $RestArgs }

Write-Host "[zen-dock] node $nodeVersion, starting..." -ForegroundColor Cyan
& $nodeCmd @nodeArgs

Write-Host ""
Write-Host "[zen-dock] stopped." -ForegroundColor DarkGray
Read-Host "Press Enter to close"
