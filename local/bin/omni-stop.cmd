@echo off
REM Emergency cleanup: kill the OmniRoute gateway and claude-mem worker.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\bin\lib\omni-stop.ps1" %*
