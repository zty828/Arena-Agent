@echo off
rem Thin ASCII wrapper. All logic lives in Node, so batch encoding cannot break it.
rem
rem Launches the ArenaBridge desktop harness: a standalone Electron window that boots the
rem local bridge in-process and shows the operator console natively, with no browser and no
rem port or token to copy. Closing the window stops the daemon.
rem
rem This is the only entry point the project needs.
rem
rem Node is resolved in this order:
rem   1. runtime\node.exe next to this file - the bundled runtime. The folder is then
rem      self-contained: it does not matter what is on PATH or which Node is installed.
rem   2. node.exe on PATH - for a source checkout that did not take the release bundle.
rem
rem Nothing here is machine specific. The folder can be moved or copied anywhere.
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto run

set "NODE=node"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ArenaBridge] No Node runtime found.
  echo [ArenaBridge]   expected the bundled runtime at: %~dp0runtime\node.exe
  echo [ArenaBridge]   and there is no node.exe on PATH either.
  echo [ArenaBridge]
  echo [ArenaBridge] This folder is a source checkout without the bundled runtime.
  echo [ArenaBridge] Download the self-contained release bundle instead, or install Node 22
  echo [ArenaBridge] and run the dependency install in this folder.
  pause
  exit /b 1
)

:run
"%NODE%" "%~dp0scripts\desktop.mjs" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [ArenaBridge] The harness exited with code %EXITCODE%.
  pause
)
endlocal & exit /b %EXITCODE%
