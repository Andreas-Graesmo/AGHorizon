; MIGRATION_PLAN.md 6.5: installing over the Electron app. When the Electron app has handed over to this one (its
; %APPDATA%\Tuner IPTV\migration.json exists), remove the Electron app's program files silently, so there aren't two
; "AG Horizon" entries in Start and in Apps. Its data folder is never touched: this app reads it on first start.
; Without migration.json nothing happens (the person installed this one by hand; both stay until they choose).
; The Electron app is found by its per-user uninstall entry: DisplayName "AG Horizon <version>" (electron-builder adds
; the version) with "Uninstall AG Horizon.exe"
; in its InstallLocation (this app's own entry has uninstall.exe instead).
!macro NSIS_HOOK_PREINSTALL
  ; the installer's own script uses these registers too: keep them as they were
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  IfFileExists "$APPDATA\Tuner IPTV\migration.json" 0 agh_electron_done
  StrCpy $R0 0
  agh_electron_next:
    EnumRegKey $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    StrCmp $R1 "" agh_electron_done
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCpy $R2 $R2 10
    StrCmp $R2 "AG Horizon" 0 agh_electron_next
    ReadRegStr $R3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "InstallLocation"
    ; some installers write the path in quotes
    StrCpy $R5 $R3 1
    StrCmp $R5 '"' 0 +3
    StrCpy $R3 $R3 "" 1
    StrCpy $R3 $R3 -1
    StrCmp $R3 "" agh_electron_next
    IfFileExists "$R3\Uninstall AG Horizon.exe" 0 agh_electron_next
    DetailPrint "Removing the previous version of AG Horizon (your data stays)"
    ; _?= runs the uninstaller in place, so ExecWait really waits for it; it can't delete itself then, so we do
    ExecWait '"$R3\Uninstall AG Horizon.exe" /S _?=$R3' $R4
    DetailPrint "Previous version removed (exit code $R4)"
    Delete "$R3\Uninstall AG Horizon.exe"
    RMDir "$R3"
  agh_electron_done:
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
