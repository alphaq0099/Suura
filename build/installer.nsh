; Uninstall asks before removing app data.
;
; electron-builder's deleteAppDataOnUninstall stays false so the default choice
; is safe. This prompt makes deletion an explicit opt-in and names the one thing
; it will not touch: the music files the user saved into Music\Suura.

!macro customUnInstall
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete Suura's library database, settings, caches and logs?$\r$\n$\r$\nYour music files in Music\Suura will NOT be deleted. Choose No to keep your data for a later reinstall." \
      IDNO suura_keep_app_data
    RMDir /r "$APPDATA\Suura"
    suura_keep_app_data:
  ${EndIf}
!macroend
