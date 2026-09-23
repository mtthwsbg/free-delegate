@echo off
REM Audio or video -> text via Groq Whisper (free). Prints output paths only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\bin\lib\hear.ps1" %*
