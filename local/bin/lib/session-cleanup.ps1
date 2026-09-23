<#
  session-cleanup.ps1 - fast SessionEnd cleanup.

  Kills the OmniRoute gateway and the claude-mem worker directly by process
  match. Deliberately does NOT shell out to `omniroute stop` or `npx` — those
  take 10-60s to start and the hook gets cancelled before they finish.
#>

$ErrorActionPreference = 'SilentlyContinue'

Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe'" |
    Where-Object { $_.CommandLine -like "*omniroute*" -or $_.CommandLine -like "*claude-mem*" -or $_.CommandLine -like "*free-grow*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

exit 0
