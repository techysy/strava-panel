# 构建 Windows 便携 Python 运行时(Embeddable,零依赖免 pip)
# Strava Panel 是纯标准库服务,只需把 Embeddable Python 解压即可用,无 pip 环节。
# 用法: .\build-python-runtime.ps1 [-PythonVersion 3.12.10] [-Proxy http://192.168.31.101:7890]
param(
    [string]$PythonVersion = "3.12.10",
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$build = Join-Path $root "build"
$pyDir = Join-Path $build "python"

if (Test-Path $pyDir) { Remove-Item -Recurse -Force $pyDir }
New-Item -ItemType Directory -Force -Path $pyDir | Out-Null

function Fetch($url, $out) {
    Write-Host "下载 $url"
    if ($Proxy) { Invoke-WebRequest -Uri $url -OutFile $out -Proxy $Proxy -UseBasicParsing }
    else { Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing }
}

# 1. 下载并解压 Embeddable Python
$zipPath = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
Fetch "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" $zipPath
Expand-Archive -Path $zipPath -DestinationPath $pyDir -Force

# 2. ._pth 模式不会把脚本目录加入 sys.path(踩坑实录 #2):
#    打包后布局为 resources\python + resources\app\server,启动 cwd 是 app\server,
#    `from db import StravaDB` 需要脚本目录在 sys.path 里 → 显式追加 ..\app\server
#    (相对 python 目录,打包前 build\python 与 build\app 布局一致,打包后不变)。
$pth = Get-ChildItem $pyDir -Filter "python*._pth" | Select-Object -First 1
if (-not $pth) { throw "未找到 ._pth 文件" }
if (-not (Select-String -Path $pth.FullName -Pattern '^\.+\\app\\server' -Quiet)) {
    Add-Content $pth.FullName "..\app\server" -Encoding ASCII
}

# 3. 自检(纯标准库,零第三方依赖)
$py = Join-Path $pyDir "python.exe"
& $py -c "import http.server, sqlite3, urllib.request; print('python runtime ok (stdlib only)')"
if ($LASTEXITCODE -ne 0) { throw "运行时自检失败" }

Write-Host ""
Write-Host "Python 运行时就绪: $pyDir" -ForegroundColor Green
