@echo off
REM Probe untried free models, score them, and rewrite ask-free routing.
node "%USERPROFILE%\.claudein\libree-grow.mjs" %*
