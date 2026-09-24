<#
  grow-weekly.ps1 - called at the END of the SessionStart warm-up.

  Runs `free-grow --probe` daily while models remain untested, weekly after, so the free-model roster
  keeps measuring itself without anyone remembering to do it. Costs zero
  Anthropic tokens: it talks to the local gateway and to free providers only,
  and writes its findings to a file Claude reads only when something changed.

  Bounded on purpose. free-grow waits for the gateway itself (so nothing here
  needs to sleep or retry) and enforces its own wall-clock deadline, so this can
  never become a job that outlives the reason for starting it. session-cleanup.ps1
  also matches free-grow by name, which ends a probe still running at session end.
#>

$ErrorActionPreference = 'SilentlyContinue'

# Daily and 30 at a time while free-grow reports untested models (.untried),
# weekly and 12 at a time once everything has been measured at least once.
# The weekly-only cadence left most of the catalogue never called (2026-09-24).
$untriedFile = Join-Path $env:USERPROFILE ".omniroute\.untried"
$untried = 0
if (Test-Path $untriedFile) { [int]::TryParse((Get-Content $untriedFile -Raw).Trim(), [ref]$untried) | Out-Null }
$days = 7; $limit = "12"
if ($untried -gt 0) { $days = 1; $limit = "30" }

$stamp = Join-Path $env:USERPROFILE ".omniroute\.last-grow"
if (Test-Path $stamp) {
    $age = (Get-Date) - (Get-Item $stamp).LastWriteTime
    if ($age.TotalDays -lt $days) { exit 0 }
}

$script = Join-Path $env:USERPROFILE ".claude\bin\lib\free-grow.mjs"
if (-not (Test-Path $script)) { exit 0 }

$logDir = Join-Path $env:USERPROFILE ".claude\optimize"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir "free-grow.last-run.log"

# node.exe is a real executable, so Start-Process resolves it without going
# through file association - the same reason gateway-warm.ps1 calls node rather
# than the `omniroute` command name.
Start-Process -FilePath "node" `
    -ArgumentList $script, "--probe", "--limit", $limit, "--deadline", "300" `
    -RedirectStandardOutput $log `
    -WindowStyle Hidden

exit 0
