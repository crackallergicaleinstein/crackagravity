@echo off
rem crackagravity launcher — double-click this.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
if errorlevel 1 pause
endlocal
