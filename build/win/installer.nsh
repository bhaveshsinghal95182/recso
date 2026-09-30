; recso-cli on PATH, if the person wants it (see docs/automation/README.md).
;
; The installer asks once; a silent install (/S) doesn't add it. Updates keep
; whatever was chosen: the old uninstaller leaves PATH alone and the new
; installer doesn't ask again. Uninstalling removes the entry.

!macro customInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Add recso-cli to your PATH?$\r$\n$\r$\nrecso-cli lets scripts and AI agents control recso once its Automation API is turned on in Settings." /SD IDNO IDNO recsoSkipPath
      nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$dir = '$INSTDIR'; $$path = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @(($$path -split ';') | Where-Object { $$_ }); if ($$parts -notcontains $$dir) { [Environment]::SetEnvironmentVariable('Path', (($$parts + $$dir) -join ';'), 'User') }"`
    recsoSkipPath:
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$dir = '$INSTDIR'; $$path = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$path) { $$parts = @(($$path -split ';') | Where-Object { $$_ -and $$_ -ne $$dir }); [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User') }"`
  ${endIf}
!macroend
