#!/usr/bin/env bash
# 版本号同步脚本：server/VERSION 为唯一事实来源，把版本号写入四处镜像位置。
# 被写的位置：
#   1. fnos-packaging/manifest   — `version = X.Y.Z` 行（保留原有对齐宽度）
#   2. desktop/package.json      — "version" 字段（sed 原地替换，不动 key 顺序/格式）
#   3. cli/package.json          — "version" 字段（同上）
# 用法：bash scripts/sync-version.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER_FILE="$ROOT/server/VERSION"
MANIFEST="$ROOT/fnos-packaging/manifest"
DESKTOP_PKG="$ROOT/desktop/package.json"
CLI_PKG="$ROOT/cli/package.json"

if [ ! -f "$VER_FILE" ]; then
    echo "ERROR: $VER_FILE 不存在" >&2
    exit 1
fi

VERSION="$(tr -d '[:space:]' < "$VER_FILE")"
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'; then
    echo "ERROR: $VER_FILE 内容不是合法语义化版本号: '$VERSION'" >&2
    exit 1
fi

CHANGED=0
SYNCED=0

# fnos-packaging/manifest：`version               = X.Y.Z`，只替换值，保留对齐
manifest_read() {
    sed -nE 's/^version[[:space:]]*=[[:space:]]*([^[:space:]]+).*/\1/p' "$MANIFEST" | head -1 | tr -d '\r'
}
if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: $MANIFEST 不存在" >&2
    exit 1
fi
OLD="$(manifest_read)"
if [ -z "$OLD" ]; then
    echo "ERROR: manifest 中找不到 version 行" >&2
    exit 1
elif [ "$OLD" = "$VERSION" ]; then
    echo "  ✓ fnos-packaging/manifest   已是 $VERSION（无需改动）"
    SYNCED=$((SYNCED + 1))
else
    sed -i -E "s/^(version[[:space:]]*=[[:space:]]*)[0-9][0-9A-Za-z.+_-]*/\1${VERSION}/" "$MANIFEST"
    echo "  ✓ fnos-packaging/manifest   $OLD → $VERSION"
    CHANGED=$((CHANGED + 1))
fi

# package.json：只替换首个 "version" 行内的值，保留缩进、key 顺序与其余字段格式
pkg_read() {
    sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$1" | head -1 | tr -d '\r'
}
sync_pkg() {
    local file="$1" label="$2"
    if [ ! -f "$file" ]; then
        echo "ERROR: $file 不存在" >&2
        exit 1
    fi
    local old
    old="$(pkg_read "$file")"
    if [ -z "$old" ]; then
        echo "ERROR: $file 中找不到 \"version\" 字段" >&2
        exit 1
    elif [ "$old" = "$VERSION" ]; then
        echo "  ✓ $label   已是 $VERSION（无需改动）"
        SYNCED=$((SYNCED + 1))
    else
        sed -i -E "1,/\"version\"/s/\"version\":[[:space:]]*\"[^\"]*\"/\"version\": \"${VERSION}\"/" "$file"
        echo "  ✓ $label   $old → $VERSION"
        CHANGED=$((CHANGED + 1))
    fi
}
sync_pkg "$DESKTOP_PKG" "desktop/package.json "
sync_pkg "$CLI_PKG"     "cli/package.json     "

echo ""
if [ "$CHANGED" -eq 0 ]; then
    echo "✓ 版本号已同步（本次无需改动，当前 $VERSION）"
else
    echo "✓ 版本号已同步为 $VERSION（更新 $CHANGED 处，已一致 $SYNCED 处）"
fi
echo "  server/VERSION 是唯一事实来源；后端 APP_VERSION 从 VERSION 读，前端 brandVer 靠后端注入，均自动跟随。"
