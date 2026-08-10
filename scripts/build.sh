#!/usr/bin/env bash
# strava 打包脚本 — 版本号自动累加测试版第4位 + fnpack build (url/iframe) + 交付
#
# 用法（在 NAS 构建目录 /vol1/1000/fnOS App/build/strava-fnos/ 运行）:
#   bash scripts/build.sh            # 自动累加第4位后打包
#   bash scripts/build.sh 5          # 手动指定第4位=5
#   bash scripts/build.sh --formal   # 正式版：升第3位，去掉第4位（如 1.2.1 -> 1.2.2）
#
# 版本号单一来源：改 app/server/VERSION（三位基础），第4位由本脚本自动累加。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CUR_VER="$(cat "$ROOT/app/server/VERSION" 2>/dev/null | tr -d '[:space:]')"
[ -z "$CUR_VER" ] && CUR_VER="1.2.1"
COUNT_FILE="$ROOT/scripts/.build_num"
FPK_DIR="/vol1/1000/fnOS App/fpk/strava"
OLDFPK_DIR="/vol1/1000/fnOS App/fpk/oldfpk"

# --- 计算版本号 ---
MODE="${1:-}"
if [ "$MODE" = "--formal" ]; then
    # 正式版：升第3位，去掉第4位（1.2.1.12 -> 1.2.2）
    IFS='.' read -ra P <<< "$CUR_VER"
    VER="${P[0]}.${P[1]}.$(( ${P[2]:-0} + 1 ))"
    echo "ℹ️  正式版：$CUR_VER -> $VER"
else
    # 测试版：第4位自动累加（基于当前 VERSION）
    if [[ "$CUR_VER" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        VER="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}.$((BASH_REMATCH[4] + 1))"
    else
        VER="${CUR_VER}.1"
    fi
    echo "ℹ️  测试版：$CUR_VER -> $VER"
fi

# --- 打包前确认（遵守打包纪律；BUILD_AUTO=1 跳过确认用于自动化）---
echo "📦 即将打包版本：$VER"
echo "   改动见 docs/TEST_LOG.md 最新一节的「更新点」"
if [ "${BUILD_AUTO:-0}" != "1" ]; then
    read -r -p "确认打包 $VER ? [y/N] " ans
    if [[ ! "$ans" =~ ^[Yy]$ ]]; then
        echo "已取消"; exit 1
    fi
fi

# --- 更新 manifest version + VERSION 文件为当前包版本 ---
sed -i "s/^version.*/version               = $VER/" "$ROOT/manifest"
echo "$VER" > "$ROOT/app/server/VERSION"
echo "✓ manifest + VERSION = $VER"

# --- fnpack build url 版 ---
sed -i 's/"type": "iframe"/"type": "url"/' "$ROOT/app/ui/config"
(cd "$ROOT" && fnpack build >/dev/null 2>&1)
mv "$ROOT/strava.fpk" "$ROOT/strava-$VER.fpk"

# --- fnpack build iframe 版 ---
sed -i 's/"type": "url"/"type": "iframe"/' "$ROOT/app/ui/config"
(cd "$ROOT" && fnpack build >/dev/null 2>&1)
mv "$ROOT/strava.fpk" "$ROOT/strava-$VER-iframe.fpk"

echo "✓ 构建完成：strava-$VER.fpk / strava-$VER-iframe.fpk"

# --- 交付：旧包移 oldfpk，新包入 strava/ ---
mkdir -p "$OLDFPK_DIR"
mv "$FPK_DIR"/strava-*.fpk "$OLDFPK_DIR"/ 2>/dev/null || true
cp "$ROOT/strava-$VER.fpk" "$FPK_DIR/"
cp "$ROOT/strava-$VER-iframe.fpk" "$FPK_DIR/"

echo "✓ 已交付：$FPK_DIR/strava-$VER*.fpk"
echo "✓ 旧包已归档：$OLDFPK_DIR/"
echo "当前测试版：$VER"
