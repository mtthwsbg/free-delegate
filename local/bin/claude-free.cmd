@echo off
REM Claude Code on a free model through the local gateway. For when the Claude quota is out.
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\bin\lib\claude-free.ps1" %*
