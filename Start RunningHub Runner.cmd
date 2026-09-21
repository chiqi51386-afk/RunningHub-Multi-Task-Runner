@echo off
setlocal
cd /d "%~dp0"
set "RUNNER_EXE=%~dp0node_modules\electron\dist\electron.exe"
set "RUNNER_MAIN=%~dp0dist\src\desktop\main.js"
if not exist "%RUNNER_EXE%" goto :missing
if not exist "%RUNNER_MAIN%" goto :missing
start "" "%RUNNER_EXE%" "%RUNNER_MAIN%"
exit /b 0

:missing
title RunningHub Runner - first build
echo First launch files are missing. Building RunningHub Runner...
call npm run desktop:build
if errorlevel 1 goto :failed
start "" "%RUNNER_EXE%" "%RUNNER_MAIN%"
exit /b 0

:failed
echo.
echo RunningHub Runner failed to build. Keep this window open and send the error message for diagnosis.
pause
exit /b 1
