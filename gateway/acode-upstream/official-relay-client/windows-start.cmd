@echo off
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not exist "server\dist\cli.js" (
  echo server\dist\cli.js not found. Run npm run server:build first.
  exit /b 1
)
set "ACODE_FRIENDLY_LOGS=true"
node server\dist\cli.js official-start
