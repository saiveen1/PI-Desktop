@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1" %*
set "launch_exit=%errorlevel%"
if not "%launch_exit%"=="0" pause
exit /b %launch_exit%
