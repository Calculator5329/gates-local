; Gates Local's running-app check for the Windows installer and uninstaller
; (docs/design/installed-updates.md, section 3, "The running-app check").
;
; The stock check kills every process whose path starts with the install
; folder, with no separator, so it also kills a copy in a sibling folder such
; as "gates-local-old". This one lists the processes whose path starts with
; "<install folder>\", waits for them to end (Restart to update quits the app
; just after it starts the installer), and never kills anything.
;
; The installer or uninstaller running the check is left out of the list: the
; update's fallback runs the old uninstaller in place.
;
; If PowerShell cannot run, the check cannot tell this install's processes from
; others. A silent run then stops with error level 2 before anything is removed,
; and an interactive run asks the person to close the app and click Retry. A
; silent run whose wait runs out stops the same way; the app's next launch says
; the update did not finish and names the installer.

!define GATES_LOCAL_WAIT_SECONDS 60

!macro customCheckAppRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "GATES_LOCAL_INSTDIR", t "$INSTDIR\")i'
  ${Do}
    DetailPrint "Waiting for Gates Local to close"
    ; 10: nothing of this install is running; 11: still running when the wait ran out; 12: no install folder.
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d=$$env:GATES_LOCAL_INSTDIR; if (-not $$d) { exit 12 }; $$me=(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$PID)).ParentProcessId; $$end=(Get-Date).AddSeconds(${GATES_LOCAL_WAIT_SECONDS}); while ($$true) { $$n=@(Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $$me -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }).Count; if ($$n -eq 0) { exit 10 }; if ((Get-Date) -gt $$end) { exit 11 }; Start-Sleep -Milliseconds 500 }"`
    Pop $R0
    ${If} $R0 == 10
      ${Break}
    ${EndIf}
    DetailPrint "Gates Local is still running or could not be checked ($R0)"
    ${If} ${Silent}
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Close every Gates Local window, then click Retry." IDRETRY +2
    Quit
    ; Retry. Without a working check, the person's word is all there is.
    ${If} $R0 != 11
      ${Break}
    ${EndIf}
  ${Loop}
!macroend
