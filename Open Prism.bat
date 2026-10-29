@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Prism needs Node.js 22 or newer.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo Installing Prism's dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your connection and try again.
    pause
    exit /b 1
  )
)

echo Starting Prism...
start "Prism server" /min cmd /c "node server.js"
timeout /t 2 >nul
start "" "http://localhost:3000"
endlocal
