@echo off
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not exist "server\dist\cli.js" (
  echo server\dist\cli.js not found. Run npm run server:build first.
  exit /b 1
)
node server\dist\cli.js official-install-service
