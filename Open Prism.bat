@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem Prism launcher for Windows. Double-click this file.
rem Needs no administrator rights and installs nothing outside this folder:
rem   * uses a Node runtime inside this folder if present, else a system Node 22+,
rem     else unpacks a portable copy into runtime\ on first launch
rem   * dependencies are vendored in node_modules\, so nothing is installed
rem   * listens on an unprivileged port (3000 and up)
rem
rem Windows may show "Windows protected your PC" the first time (SmartScreen,
rem for files downloaded from the internet). Click "More info" -> "Run anyway";
rem it does not ask for an administrator password.

echo Prism
echo -----

if not defined PRISM_NODE_VERSION set "PRISM_NODE_VERSION=22.20.0"

set "RUNTIME_DIR=%CD%\runtime\win-x64"
set "NODE_BIN="
if exist "runtime\node.exe" set "NODE_BIN=%CD%\runtime\node.exe"
if not defined NODE_BIN if exist "runtime\bin\node.exe" set "NODE_BIN=%CD%\runtime\bin\node.exe"
if not defined NODE_BIN if exist "%RUNTIME_DIR%\node.exe" set "NODE_BIN=%RUNTIME_DIR%\node.exe"
if not defined NODE_BIN (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_BIN=node"
)

if not defined NODE_BIN (
  echo.
  echo Preparing Prism's own copy of Node.js ^(one time, about 30 MB^).
  echo It is unpacked into this folder - your administrator is not involved.
  echo.
  set "PRISM_NODE_URL_DEFAULT=https://nodejs.org/dist/v!PRISM_NODE_VERSION!/node-v!PRISM_NODE_VERSION!-win-x64.zip"
  if not defined PRISM_NODE_URL set "PRISM_NODE_URL=!PRISM_NODE_URL_DEFAULT!"
  set "PRISM_TMP=%CD%\runtime\.download"
  if exist "!PRISM_TMP!" rmdir /s /q "!PRISM_TMP!"
  mkdir "!PRISM_TMP!" 2>nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$ProgressPreference='SilentlyContinue';" ^
    "if (Test-Path '!PRISM_NODE_URL!' -PathType Leaf) { Copy-Item '!PRISM_NODE_URL!' '!PRISM_TMP!\node.zip' }" ^
    "else { Invoke-WebRequest -UseBasicParsing -Uri '!PRISM_NODE_URL!' -OutFile '!PRISM_TMP!\node.zip' }"
  if errorlevel 1 (
    echo Download failed. Check your connection and run this launcher again.
    pause
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "Expand-Archive -LiteralPath '!PRISM_TMP!\node.zip' -DestinationPath '!PRISM_TMP!\unpack' -Force;" ^
    "$d = Get-ChildItem '!PRISM_TMP!\unpack' -Directory | Select-Object -First 1;" ^
    "if (-not $d) { throw 'the runtime download was incomplete' };" ^
    "New-Item -ItemType Directory -Force -Path '!RUNTIME_DIR!' | Out-Null;" ^
    "Copy-Item (Join-Path $d.FullName '*') '!RUNTIME_DIR!' -Recurse -Force"
  if errorlevel 1 (
    echo Could not unpack the runtime download.
    rmdir /s /q "!PRISM_TMP!" 2>nul
    pause
    exit /b 1
  )
  rmdir /s /q "!PRISM_TMP!" 2>nul
  if exist "%RUNTIME_DIR%\node.exe" set "NODE_BIN=%RUNTIME_DIR%\node.exe"
)

if not defined NODE_BIN (
  echo.
  echo Prism could not get its Node runtime.
  echo.
  echo Prism ships without one so the download stays small; it fetches a portable
  echo copy on first launch, which needs an internet connection.
  echo.
  echo Already have Node.js 22 or newer? Prism will use it. Otherwise reconnect and
  echo run this launcher again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('"%NODE_BIN%" -v 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION (
  echo The Node runtime in this folder did not start. Delete the "runtime" folder
  echo and run this launcher again to re-download it.
  pause
  exit /b 1
)
echo Using Node !NODE_VERSION! (!NODE_BIN!)

if not exist "node_modules\express" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo.
    echo This bundle is missing its dependencies and there is no npm to fetch them.
    echo Download Prism again.
    pause
    exit /b 1
  )
  echo Preparing Prism's dependencies ^(one time^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if defined PRISM_LAUNCHER_CHECK (
  echo Launcher check passed.
  exit /b 0
)

rem Is a copy of Prism already running on a port we would use?
for %%P in (3000 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010) do (
  for /f "delims=" %%R in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://localhost:%%P/healthz).Content}catch{''}" 2^>nul') do (
    echo %%R | findstr /c:"\"prism\":true" >nul && (
      echo Prism is already running - opening http://localhost:%%P
      start "" "http://localhost:%%P"
      exit /b 0
    )
  )
)

echo Starting Prism...
set "PRISM_OPEN=1"
start "Prism server" cmd /c ""%NODE_BIN%" server.js"

rem Wait for the server, then open the browser at whatever port it took.
for /l %%I in (1,1,60) do (
  for %%P in (3000 3001 3002 3003 3004 3005 3006 3007 3008 3009 3010) do (
    for /f "delims=" %%R in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://localhost:%%P/healthz).Content}catch{''}" 2^>nul') do (
      echo %%R | findstr /c:"\"prism\":true" >nul && (
        start "" "http://localhost:%%P"
        exit /b 0
      )
    )
  )
  timeout /t 1 >nul
)

echo.
echo Prism did not answer in time. Check the "Prism server" window for details.
pause
exit /b 1
