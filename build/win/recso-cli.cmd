@echo off
rem recso-cli: the client for recso's Automation API (see docs/automation/README.md).
rem The installer puts this next to recso.exe. It runs the CLI bundled in the
rem app with recso's own executable in Node mode, so no separate Node is needed.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0recso.exe" "%~dp0resources\app.asar\dist-electron\automation\cli\recso-cli.js" %*
exit /b %ERRORLEVEL%
