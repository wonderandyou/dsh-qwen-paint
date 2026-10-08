@echo off
rem ===========================================================================
rem  dsh-qwen-paint -- one-click installer launcher.
rem
rem  WARNING: keep this file ASCII-only. .cmd files are read as ANSI, so any
rem  Chinese character written here turns into garbage on some systems.
rem  All Chinese messages live in scripts\quickstart.mjs instead.
rem
rem  (The self test enforces this -- it really did catch a Chinese word that
rem   had slipped into this very comment block.)
rem ===========================================================================
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [!] Node.js not found.
  echo.
  echo       Install the LTS build from https://nodejs.org first,
  echo       then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "scripts\quickstart.mjs"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo   Exit code: %RC%
  echo.
)
pause
exit /b %RC%
