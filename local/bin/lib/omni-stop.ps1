<#
  omni-stop.ps1 - emergency cleanup. Kills the OmniRoute gateway and the
  claude-mem worker if anything was left running.

  Uses node on the entry point rather than the `omniroute` command name, for the
  same reason as gateway-warm.ps1: bare-name resolution on Windows is inconsistent
  across ShellExecute / PATHEXT / execution policy. Dropped the `npx claude-mem
  stop` call too - npx takes 10-30s to start and the process kill below does the
  same job instantly.
#>

$ErrorActionPreference = 'SilentlyContinue'

$entry = Join-Path $env:APPDATA "npm\node_modules\omniroute\bin\omniroute.mjs"
if (Test-Path $entry) { & node $entry stop 2>&1 | Out-Null }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*omniroute*" } |
    ForEach-Object { "killing omniroute PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*claude-mem*" } |
    ForEach-Object { "killing claude-mem PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

foreach ($p in 20128, 20131, 20132, 37777) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { "port $p still listening (pid $($c.OwningProcess -join ','))" } else { "port $p free" }
}
