@echo off
rem FluentRead local CLI bridge launcher (Windows). Extra arguments are passed through, e.g. start.cmd --port 18800
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0cli.mjs" %*
if errorlevel 1 pause
