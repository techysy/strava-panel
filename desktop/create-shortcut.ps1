# 为便携版/绿色版 exe 创建桌面快捷方式(NSIS 安装版不需要,安装时自动创建)
# 用法: .\create-shortcut.ps1 -TargetExe "D:\Apps\InspectionVisualizer-Portable-1.0.0.exe"
#       .\create-shortcut.ps1 -TargetExe "C:\x\app.exe" -Name "巡检数据可视化" -Icon "C:\x\icon.ico"
param(
    [Parameter(Mandatory = $true)][string]$TargetExe,
    [string]$Name = "",
    [string]$Icon = ""
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $TargetExe)) { throw "目标不存在: $TargetExe" }
if (-not $Name) { $Name = [IO.Path]::GetFileNameWithoutExtension($TargetExe) }
if (-not $Icon) { $Icon = $TargetExe }

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $ws.CreateShortcut((Join-Path $desktop "$Name.lnk"))
$lnk.TargetPath = (Resolve-Path $TargetExe).Path
$lnk.WorkingDirectory = (Get-Item $TargetExe).DirectoryName
$lnk.IconLocation = $Icon
$lnk.Description = "Strava Panel"
$lnk.Save()

Write-Host "桌面快捷方式已创建: $(Join-Path $desktop "$Name.lnk")" -ForegroundColor Green
