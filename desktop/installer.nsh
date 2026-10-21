; Strava Panel 自定义 NSIS 钩子（electron-builder 约定：buildResources 下的 installer.nsh）
; 目标：安装完成页提供「打开安装目录」蓝字链接——用户反馈装完找不到程序装在哪。
;
; 约束：custom nsh 在 LogicLib/common.nsh 之前 include——${if}、模板宏、
; $launchLink 等模板变量都不可用（warning 6000 会被 electron-builder 当 error）。
; 函数体只用 NSIS 原生指令 + 自有变量。
;
; 机制（Contrib/Modern UI 2/Pages/Finish.nsh）：
;   - 链接文字 = ${MUI_FINISHPAGE_LINK}（编译期文本替换，可直接写中文）
;   - 链接颜色 = MUI_FINISHPAGE_LINK_COLOR
;   - 点击 = ExecShell open "${MUI_FINISHPAGE_LINK_LOCATION}"（对文件夹即资源管理器打开）
;
; customFinishPage 一旦定义，模板 else 分支的 StartApp/RUN 配置会被跳过，
; RUN 行为在此自给自足：ExecShell 经资源管理器（非提升上下文）启动应用本体，
; 避免 UAC 提升的安装器把管理员态带给应用。

!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartAppFunc"
  !define MUI_FINISHPAGE_LINK "打开安装目录（$INSTDIR）"
  !define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR"
  !define MUI_FINISHPAGE_LINK_COLOR "0000FF"
  !insertmacro MUI_PAGE_FINISH
!macroend

; 完成「运行应用」：直接启动安装目录里的主程序（electron-builder 产物名与
; productName 一致：StravaPanel.exe）。ExecShell 经 shell 打开，非提升上下文。
; 只在安装器轮定义（卸载器轮不引用该函数，全局定义会触发 makensis 6010
; 「not referenced」警告，electron-builder -WX 把警告当错误）。
!ifndef BUILD_UNINSTALLER
Function StartAppFunc
  ExecShell open "$INSTDIR\StravaPanel.exe"
FunctionEnd
!endif

!macro customInstall
  ; 记录安装目录（供排障/外部工具查询）
  WriteRegStr HKCU "Software\StravaPanel" "InstallDir" "$INSTDIR"
!macroend
