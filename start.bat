@echo off
setlocal
chcp 65001 >nul
title US and A-share Stock Scanner
cd /d "%~dp0"

set "SCANNER_NODE="
for %%N in (node.exe) do set "SCANNER_NODE=%%~$PATH:N"
if not defined SCANNER_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "SCANNER_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined SCANNER_NODE (
    echo Node.js was not found. Please install Node.js 24, then try again.
    pause
    exit /b 1
)

"%SCANNER_NODE%" "%~dp0scripts\launch.cjs" %*
if errorlevel 1 (
    echo.
    echo Scanner startup failed. See the message above or .runtime\launch.log.
    pause
    exit /b 1
)
