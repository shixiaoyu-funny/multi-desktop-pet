@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "VCVARS=D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" (
  echo [错误] 找不到 MSVC 环境脚本：
  echo        %VCVARS%
  echo        请确认 Visual Studio 生成工具已装在 D:\BuildTools
  echo.
  pause
  exit /b 1
)

rem MSVC 编译器与 Windows SDK 环境
call "%VCVARS%" >nul
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem 先关掉已在运行的实例，避免出现两只
taskkill /IM raven-winpet.exe /F >nul 2>&1

cd /d "%ROOT%src-tauri"

echo [1/2] 编译中（增量编译通常几秒）...
cargo build
if errorlevel 1 (
  echo.
  echo [失败] 编译未通过，请查看上面的报错。
  echo.
  pause
  exit /b 1
)

echo [2/2] 启动桌宠...
cd /d "%ROOT%"
start "" "%ROOT%src-tauri\target\debug\raven-winpet.exe"

endlocal
exit /b 0
