@echo off
REM Find unused free capacity and chain members that have gone bad.
node "%USERPROFILE%\.claude\bin\lib\free-scout.mjs" %*
