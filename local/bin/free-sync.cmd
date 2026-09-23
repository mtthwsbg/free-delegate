@echo off
REM Publish the free-model roster to the dashboard's Delegation tab.
node "%USERPROFILE%\.claude\bin\lib\delegation-export.mjs" %*
