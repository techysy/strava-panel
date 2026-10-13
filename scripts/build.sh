#!/usr/bin/env bash
# strava fpk 打包脚本 — 版本号自动累加测试版第4位 + fnpack build
#
# 布局: 核心源码在仓库根(server/ + www/),fnOS 打包工程在 fnos-packaging/。
# 本脚本先同步版本号,再把打包工程拷到临时目录(临时改 manifest/ui config,不动仓库文件),
# 在临时目录内 fnpack build,产物拷回仓库根。
#
# 用法(在仓库根运行):
#   bash scripts/build.sh                              # 自动累加第4位后打包(x86 / url)
#   bash scripts/build.sh 5                            # 手动指定第4位=5
#   bash scripts/build.sh --formal                     # 正式版:升第3位,去掉第4位(如 1.2.1 -> 1.2.2)
#   bash scripts/build.sh --arch arm                   # arm 版(产物名加 -arm)
#   bash scripts/build.sh --variant iframe             # 窗口版(产物名加 -iframe)
#   bash scripts/build.sh --arch arm --variant iframe  # strava-<ver>-arm-iframe.fpk
#
# 版本号单一来源:改 server/VERSION(三位基础),第4位由本脚本自动累加。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/fnos-packaging"
CUR_VER="$(cat "$ROOT/server/VERSION" 2>/dev/null | tr -d '[:space:]')"
[ -z "$CUR_VER" ] && CUR_VER="1.2.1"
COUNT_FILE="$ROOT/scripts/.build_num"

# --- 解析参数 ---
MODE=""        # ""=测试版累加 | --formal | 数字(手动第4位)
ARCH="x86"     # x86 | arm
VARIANT="url"  # url | iframe
while [ $# -gt 0 ]; do
    case "$1" in
        --formal) MODE="--formal" ;;
        --arch)
            ARCH="${2:?--arch 缺值,应为 x86|arm}"
            [ "$ARCH" = "x86" ] || [ "$ARCH" = "arm" ] || { echo "ERROR: --arch 只支持 x86|arm"; exit 1; }
            shift ;;
        --arch=*) ARCH="${1#--arch=}"
            [ "$ARCH" = "x86" ] || [ "$ARCH" = "arm" ] || { echo "ERROR: --arch 只支持 x86|arm"; exit 1; } ;;
        --variant)
            VARIANT="${2:?--variant 缺值,应为 url|iframe}"
            [ "$VARIANT" = "url" ] || [ "$VARIANT" = "iframe" ] || { echo "ERROR: --variant 只支持 url|iframe"; exit 1; }
            shift ;;
        --variant=*) VARIANT="${1#--variant=}"
            [ "$VARIANT" = "url" ] || [ "$VARIANT" = "iframe" ] || { echo "ERROR: --variant 只支持 url|iframe"; exit 1; } ;;
        [0-9]*) MODE="$1" ;;
        *) echo "ERROR: 未知参数 $1(用法见脚本头注释)"; exit 1 ;;
    esac
    shift
done

# --- 计算版本号 ---
if [ "$MODE" = "--formal" ]; then
    IFS='.' read -ra P <<< "$CUR_VER"
    VER="${P[0]}.${P[1]}.$(( ${P[2]:-0} + 1 ))"
    echo "ℹ️  正式版:$CUR_VER -> $VER"
elif [[ "$MODE" =~ ^[0-9]+$ ]]; then
    IFS='.' read -ra P <<< "$CUR_VER"
    VER="${P[0]}.${P[1]}.${P[2]}.$MODE"
    echo "ℹ️  手动第4位:$CUR_VER -> $VER"
else
    if [[ "$CUR_VER" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        VER="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}.$((BASH_REMATCH[4] + 1))"
    else
        VER="${CUR_VER}.1"
    fi
    echo "ℹ️  测试版:$CUR_VER -> $VER"
fi

# --- 产物文件名:x86/url 为默认(保持旧命名兼容),其余追加后缀 ---
SUFFIX=""
[ "$ARCH" = "arm" ] && SUFFIX="${SUFFIX}-arm"
[ "$VARIANT" = "iframe" ] && SUFFIX="${SUFFIX}-iframe"
OUT="strava-${VER}${SUFFIX}.fpk"

# --- 打包前确认 ---
echo "📦 即将打包版本:$VER(arch=$ARCH variant=$VARIANT)→ $OUT"
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

# --- 临时构建目录:manifest/platform 与 ui config 只改副本,不动 tracked 文件 ---
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
cp -r "$PKG" "$BUILD_DIR/fnos-packaging"
BPKG="$BUILD_DIR/fnos-packaging"

# 架构:manifest 现有 arch 键维持同步;fpk 的架构选择键是 platform(无则追加)
if grep -qE '^platform[[:space:]]*=' "$BPKG/manifest"; then
    sed -i "s/^platform[[:space:]]*=.*/platform              = $ARCH/" "$BPKG/manifest"
else
    echo "platform              = $ARCH" >> "$BPKG/manifest"
fi
if [ "$ARCH" = "arm" ]; then
    sed -i "s/^arch[[:space:]]*=.*/arch                  = arm64/" "$BPKG/manifest"
else
    sed -i "s/^arch[[:space:]]*=.*/arch                  = x86_64/" "$BPKG/manifest"
fi

# 形态:url(新标签页)/ iframe(桌面窗口)
if [ "$VARIANT" = "iframe" ]; then
    sed -i 's/"type": "url"/"type": "iframe"/' "$BPKG/app/ui/config"
    sed -i -E 's/^(desc[[:space:]]*=[[:space:]]*)(.*)$/\1\2 · 窗口版(在飞牛桌面窗口里打开)/' "$BPKG/manifest"
else
    sed -i 's/"type": "iframe"/"type": "url"/' "$BPKG/app/ui/config"
fi
echo "✓ 临时副本已就绪(arch=$ARCH variant=$VARIANT)"

# --- 汇集 server + www 到临时副本 app/ ---
rm -rf "$BPKG/app/server" "$BPKG/app/www"
cp -r "$ROOT/server" "$BPKG/app/server"
cp -r "$ROOT/www" "$BPKG/app/www"
find "$BPKG/app" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
echo "✓ server + www 已拷入临时副本"

# --- fnpack build ---
(cd "$BPKG" && rm -f strava.fpk && fnpack build >/dev/null 2>&1)
[ -f "$BPKG/strava.fpk" ] || { echo "ERROR: fnpack build 失败"; exit 1; }
mv "$BPKG/strava.fpk" "$ROOT/$OUT"

echo "✓ 构建完成:$OUT(仓库根)"
echo "当前测试版:$VER"
