@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js first: https://nodejs.org
  pause
  exit /b 1
)
node service-manager.cjs start
if errorlevel 1 (
  echo Failed to start the background game service. Check logs\game-lifecycle.log.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:4173"
exit /b 0
