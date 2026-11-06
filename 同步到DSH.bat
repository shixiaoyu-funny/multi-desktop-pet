@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\sync-plugin.ps1" %*
set "CODE=%ERRORLEVEL%"

if "%CODE%"=="1" (
  echo.
  pause
)
endlocal
exit /b %CODE%
