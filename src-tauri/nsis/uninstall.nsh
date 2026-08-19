!include "LogicLib.nsh"

# ============ 安装器 GUI 初始化前置检测 ============
# "安装前卸载"升级路径会在向导页面阶段直接执行旧版卸载器：
# 旧版卸载器遇到以管理员权限运行的 WinPaste 时会中止，导致新安装器
# 报通用的"无法卸载"错误。因此在任何页面显示之前先检测运行中的
# WinPaste：能结束就结束；结束失败（提权运行）则给出明确引导后退出。
# 注意：此函数在钩子文件被 include 时即编译，此时 nsis_tauri_utils 插件
# 目录尚未注册，因此这里使用 NSIS 自带的 nsExec + 系统 tasklist/taskkill，
# 二进制名与 Cargo.toml 的 package name 保持一致（字面量）。
# MUI 已定义 .onGUIInit，通过 MUI_CUSTOMFUNCTION_GUIINIT 挂接（需在
# MUI_LANGUAGE 展开之前定义，本文件 include 位置满足此要求）。
!define MUI_CUSTOMFUNCTION_GUIINIT WinPasteGuiInit
Function WinPasteGuiInit
  ClearErrors
  ; 用 find 过滤 tasklist 输出：命中时退出码 0，未命中时退出码 1，
  ; 不解析输出文本，避免编码/换行差异。
  nsExec::ExecToStack 'cmd /C tasklist | find /I "winpaste-app.exe"'
  Pop $0
  ${If} $0 = 0
    MessageBox MB_OKCANCEL|MB_ICONQUESTION "WinPaste 正在运行。点击「确定」将自动结束进程并继续，点击「取消」中止操作。$\nWinPaste is running. Click OK to close it and continue, or Cancel to abort." IDOK wp_guiinit_kill IDCANCEL wp_guiinit_cancel
    wp_guiinit_kill:
      nsExec::ExecToStack 'cmd /C taskkill /IM winpaste-app.exe /F'
      Pop $0
      ${If} $0 = 0
      ${OrIf} $0 = 128
        Goto wp_guiinit_done
      ${EndIf}
      MessageBox MB_ICONEXCLAMATION|MB_OK "无法结束 WinPaste 进程。这通常是因为它以管理员权限运行。请先退出 WinPaste（系统托盘图标 -> 右键 -> 退出），然后重新运行本程序。$\n$\nUnable to close WinPaste. It is probably running as administrator. Please exit WinPaste first (tray icon -> right click -> Exit), then run this installer again."
      Quit
    wp_guiinit_cancel:
      Quit
    wp_guiinit_done:
  ${EndIf}
FunctionEnd

# 检测运行中的 WinPaste：先尝试常规结束进程；
# 若无法结束（典型原因：进程以管理员权限运行，非提权的安装/卸载程序无权终止），
# 给出明确引导后中止，而不是生硬地报"无法终止"。
!macro WINPASTE_CHECK_RUNNING_AND_KILL idPrefix
  ClearErrors
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 0
    IfSilent kill_${idPrefix} 0
    MessageBox MB_OKCANCEL|MB_ICONQUESTION "WinPaste 正在运行。点击「确定」将自动结束进程并继续，点击「取消」中止操作。$\nWinPaste is running. Click OK to close it and continue, or Cancel to abort." IDOK kill_${idPrefix} IDCANCEL cancel_${idPrefix}
    kill_${idPrefix}:
      nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
      Pop $0
      Sleep 500
      ${If} $0 = 0
      ${OrIf} $0 = 2
        Goto killed_${idPrefix}
      ${EndIf}
      IfSilent silent_${idPrefix} 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "无法结束 WinPaste 进程。这通常是因为它以管理员权限运行。请先退出 WinPaste（系统托盘图标 -> 右键 -> 退出），然后重新运行本程序。$\n$\nUnable to close WinPaste. It is probably running as administrator. Please exit WinPaste first (tray icon -> right click -> Exit), then run this installer again."
      silent_${idPrefix}:
      Abort
    cancel_${idPrefix}:
      Abort
    killed_${idPrefix}:
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WINPASTE_CHECK_RUNNING_AND_KILL preinstall
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WINPASTE_CHECK_RUNNING_AND_KILL preuninstall
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  # Check if we actually need to restore the registry (i.e. did old registry takeover modifications exist?)
  # We check DisallowClipboardHistory policy which was uniquely created by our old registry optimization.
  ClearErrors
  ReadRegDWORD $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" "DisallowClipboardHistory"
  IfErrors no_restore

  DetailPrint "Restoring Windows Clipboard settings..."
  
  # 1. Restore EnableClipboardHistory and EnableCloudClipboard to default (1)
  # This ensures Win+V works again even if the app was used to disable it.
  WriteRegDWORD HKCU "Software\Microsoft\Clipboard" "EnableClipboardHistory" 1
  WriteRegDWORD HKCU "Software\Microsoft\Clipboard" "EnableCloudClipboard" 1
  
  # 2. Remove 'V' from DisabledHotkeys
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys"
  ${If} $0 != ""
    # Simple primitive string removal for 'V' and 'v'
    Push "V" # String to replace
    Push ""  # Replace with
    Push $0  # Original string
    Call un.StrReplace
    Pop $0
    
    Push "v" # String to replace
    Push ""  # Replace with
    Push $0  # Original string
    Call un.StrReplace
    Pop $0
    
    ${If} $0 == ""
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys"
    ${Else}
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "DisabledHotkeys" $0
    ${EndIf}
  ${EndIf}

  # 3. Clean up Policy if it exists
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" "DisallowClipboardHistory"
  DeleteRegValue HKCU "Software\Policies\Microsoft\Windows\System" "AllowClipboardHistory"
  DeleteRegValue HKCU "Software\Policies\Microsoft\Windows\System" "AllowCrossDeviceClipboard"
  
  DetailPrint "Windows Clipboard settings restored."
  
  # 4. Restart Explorer to make DisabledHotkeys changes take effect
  # We use a silent powershell command to be as non-intrusive as possible
  DetailPrint "Restarting Explorer to apply changes..."
  nsExec::Exec '"powershell.exe" -NoProfile -WindowStyle Hidden -Command "Stop-Process -Name explorer -Force; Start-Process explorer"'
  DetailPrint "Explorer restarted."

  no_restore:
!macroend

# Function for string replacement (Uninstall version)
Function un.StrReplace
  Exch $0 # Original string (input/output)
  Exch
  Exch $1 # Replace with
  Exch
  Exch 2
  Exch $2 # String to replace
  Exch 2
  Push $3 # Length of string to replace
  Push $4 # Current original string length
  Push $5 # Length of replacement string
  Push $6 # Current index
  Push $7 # Current substring
  
  StrLen $3 $2
  ${If} $3 == 0
    Goto StrReplace_End
  ${EndIf}
  
  StrLen $4 $0
  StrLen $5 $1
  StrCpy $6 0
  
  StrReplace_Loop:
    StrCpy $7 $0 $3 $6
    ${If} $7 == $2
      # Found a match
      StrCpy $7 $0 $6 # Text before match
      IntOp $6 $6 + $3
      StrCpy $0 $0 "" $6 # Text after match
      StrCpy $0 $7$1$0 # New string
      StrLen $4 $0 # New length
      IntOp $6 $7 + $5 # Move index past replacement
    ${Else}
      IntOp $6 $6 + 1
    ${EndIf}
    
    ${If} $6 < $4
      Goto StrReplace_Loop
    ${EndIf}
    
  StrReplace_End:
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd
