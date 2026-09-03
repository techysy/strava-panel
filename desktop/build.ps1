# 一键打包桌面托盘版(应用源码 + Python 运行时 + Electron)
# 用法: .\build.ps1 [-Proxy http://192.168.31.101:7890] [-SkipRuntime]
param(
    [string]$Proxy = "",
    [switch]$SkipRuntime
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$repo = Split-Path $root -Parent
$build = Join-Path $root "build"

# 1. Python 运行时(已存在可 -SkipRuntime 或自动跳过)
if (-not (Test-Path (Join-Path $build "python\python.exe"))) {
    if ($SkipRuntime) { throw "-SkipRuntime 但 build\python 不存在,请先运行 build-python-runtime.ps1" }
    & (Join-Path $root "build-python-runtime.ps1") -PythonVersion "3.12.10" -Proxy $Proxy
    if ($LASTEXITCODE -ne 0) { throw "Python 运行时构建失败" }
} else {
    Write-Host "[1/4] Python 运行时已存在,跳过" -ForegroundColor Cyan
}

# 2. 汇集 Python 应用源码 → build\app
Write-Host "[2/4] 汇集应用源码..." -ForegroundColor Cyan
$appDir = Join-Path $build "app"
if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
robocopy (Join-Path $repo "server") (Join-Path $appDir "server") /E /XD __pycache__ /XF *.db *.log *.pid strava.conf strava_tokens.json | Out-Null
robocopy (Join-Path $repo "www") (Join-Path $appDir "www") /E | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 (code=$LASTEXITCODE)" }
Write-Host "      → $appDir"

# 3. npm 依赖
Write-Host "[3/4] 安装 Electron 依赖..." -ForegroundColor Cyan
Push-Location $root
try {
    if (-not (Test-Path (Join-Path $root "node_modules"))) {
        $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    }
} finally { Pop-Location }

# 4. electron-builder 打包(NSIS 安装包 + 便携版)
Write-Host "[4/4] electron-builder 打包..." -ForegroundColor Cyan
Push-Location $root
try {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    if ($Proxy) {
        $env:HTTP_PROXY = $Proxy
        $env:HTTPS_PROXY = $Proxy
    }
    npx electron-builder --win
    if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
} finally {
    Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ""
Write-Host "打包完成,产物见 $root\dist" -ForegroundColor Green
