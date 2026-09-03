#!/usr/bin/env bash
# strava fpk 打包脚本 — 版本号自动累加测试版第4位 + fnpack build (url/iframe)
#
# 布局: 核心源码在仓库根(server/ + www/),fnOS 打包工程在 fnos-packaging/。
# 本脚本先把 server+www 拷进 fnos-packaging/app/,再在 fnos-packaging/ 内 fnpack build。
#
# 用法(在仓库根运行):
#   bash scripts/build.sh            # 自动累加第4位后打包
#   bash scripts/build.sh 5          # 手动指定第4位=5
#   bash scripts/build.sh --formal   # 正式版:升第3位,去掉第4位(如 1.2.1 -> 1.2.2)
#
# 版本号单一来源:改 server/VERSION(三位基础),第4位由本脚本自动累加。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/fnos-packaging"
CUR_VER="$(cat "$ROOT/server/VERSION" 2>/dev/null | tr -d '[:space:]')"
[ -z "$CUR_VER" ] && CUR_VER="1.2.1"
COUNT_FILE="$ROOT/scripts/.build_num"

# --- 计算版本号 ---
MODE="${1:-}"
if [ "$MODE" = "--formal" ]; then
    IFS='.' read -ra P <<< "$CUR_VER"
    VER="${P[0]}.${P[1]}.$(( ${P[2]:-0} + 1 ))"
    echo "ℹ️  正式版:$CUR_VER -> $VER"
else
    if [[ "$CUR_VER" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        VER="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}.$((BASH_REMATCH[4] + 1))"
    else
        VER="${CUR_VER}.1"
    fi
    echo "ℹ️  测试版:$CUR_VER -> $VER"
fi

# --- 打包前确认 ---
echo "📦 即将打包版本:$VER"
echo "   改动见 docs/TEST_LOG.md 最新一节的「更新点」"
if [ "${BUILD_AUTO:-0}" != "1" ]; then
    read -r -p "确认打包 $VER ? [y/N] " ans
    if [[ ! "$ans" =~ ^[Yy]$ ]]; then
        echo "已取消"; exit 1
    fi
fi

# --- 更新 manifest version + VERSION 文件 ---
sed -i "s/^version.*/version               = $VER/" "$PKG/manifest"
echo "$VER" > "$ROOT/server/VERSION"
echo "✓ manifest + VERSION = $VER"

# --- 汇集 server + www 到 fnos-packaging/app/ ---
rm -rf "$PKG/app/server" "$PKG/app/www"
cp -r "$ROOT/server" "$PKG/app/server"
cp -r "$ROOT/www" "$PKG/app/www"
find "$PKG/app" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
echo "✓ server + www 已拷入 fnos-packaging/app/"

# --- fnpack build url 版 ---
sed -i 's/"type": "iframe"/"type": "url"/' "$PKG/app/ui/config"
(cd "$PKG" && fnpack build >/dev/null 2>&1)
mv "$PKG/strava.fpk" "$ROOT/strava-$VER.fpk"

# --- fnpack build iframe 版 ---
sed -i 's/"type": "url"/"type": "iframe"/' "$PKG/app/ui/config"
(cd "$PKG" && fnpack build >/dev/null 2>&1)
mv "$PKG/strava.fpk" "$ROOT/strava-$VER-iframe.fpk"

# 清理拷贝,保持工作区干净
rm -rf "$PKG/app/server" "$PKG/app/www"

echo "✓ 构建完成:strava-$VER.fpk / strava-$VER-iframe.fpk(仓库根)"
echo "当前测试版:$VER"
