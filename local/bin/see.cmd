@echo off
REM Image -> text via a free vision model on the local gateway. Writes to a file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\bin\lib\see.ps1" %*
