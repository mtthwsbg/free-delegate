<#
  gateway-warm.ps1 - SessionStart hook.

  Launches the OmniRoute gateway detached so delegation is ready when Claude needs
  it, without making the terminal wait ~40s. Exits immediately either way.
  The SessionEnd hook (session-cleanup.ps1) kills it when the session ends.

  Calls node on OmniRoute's entry point rather than the `omniroute` command name:
  Start-Process resolves a bare name through ShellExecute (file association), not
  PATHEXT, so it would land on omniroute.ps1 and open it in Notepad instead of
  running it. node.exe is a real executable, so there is nothing to resolve wrong.
#>

$ErrorActionPreference = 'SilentlyContinue'

# Already up? Nothing to do.
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:20128/api/monitoring/health" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $alreadyUp = $true }
} catch { }

$entry = Join-Path $env:APPDATA "npm\node_modules\omniroute\bin\omniroute.mjs"
if (-not $alreadyUp -and (Test-Path $entry)) {
    Start-Process -FilePath "node" `
        -ArgumentList $entry, "serve", "--daemon", "--no-open", "--no-tray" `
        -WindowStyle Hidden
}

# Once a week, let the roster measure itself. Detached and bounded; see the file.
$grow = Join-Path $env:USERPROFILE ".claude\bin\lib\grow-weekly.ps1"
if (Test-Path $grow) { & $grow }

exit 0
