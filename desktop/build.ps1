# 一键打包桌面托盘版(应用源码 + Electron;服务端为纯 Node.js ESM,打包版经 ELECTRON_RUN_AS_NODE 运行,无需额外运行时)
# 用法: .\build.ps1 [-Proxy http://192.168.31.101:7890]
param(
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$repo = Split-Path $root -Parent
$build = Join-Path $root "build"

# 1. 汇集服务端源码 → build\app(排除 *.py/__pycache__ 等历史遗留)
Write-Host "[1/3] 汇集应用源码..." -ForegroundColor Cyan
$appDir = Join-Path $build "app"
if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
robocopy (Join-Path $repo "server") (Join-Path $appDir "server") /E /XD __pycache__ /XF *.py *.pyc *.db *.log *.pid strava.conf strava_tokens.json | Out-Null
robocopy (Join-Path $repo "www") (Join-Path $appDir "www") /E | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 (code=$LASTEXITCODE)" }
if (Test-Path (Join-Path $repo "build.json")) { Copy-Item (Join-Path $repo "build.json") (Join-Path $appDir "build.json") }
Write-Host "      → $appDir"

# 2. npm 依赖
Write-Host "[2/3] 安装 Electron 依赖..." -ForegroundColor Cyan
Push-Location $root
try {
    # 每次必跑:node_modules 已存在也要按 package.json 校验/升级(否则 Electron 大版本升级后仍会打出旧版)
    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
} finally { Pop-Location }

# 3. electron-builder 打包(NSIS 安装包 + 便携版)
Write-Host "[3/3] electron-builder 打包..." -ForegroundColor Cyan
Push-Location $root
try {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    if ($Proxy) {
        $env:HTTP_PROXY = $Proxy
        $env:HTTPS_PROXY = $Proxy
    }
    npx electron-builder --win --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
} finally {
    Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host ""
Write-Host "打包完成,产物见 $root\dist" -ForegroundColor Green
