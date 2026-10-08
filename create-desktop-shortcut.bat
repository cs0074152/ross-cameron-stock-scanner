@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "SCANNER_NODE="
for %%N in (node.exe) do set "SCANNER_NODE=%%~$PATH:N"
if not defined SCANNER_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "SCANNER_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined SCANNER_NODE (
    echo Node.js was not found. Please install Node.js 24, then try again.
    pause
    exit /b 1
)
"%SCANNER_NODE%" "%~dp0scripts\create-desktop-shortcut.cjs"
set "SCANNER_RESULT=%ERRORLEVEL%"
pause
exit /b %SCANNER_RESULT%
