#!/usr/bin/env bash
# 版本号同步脚本：把 app/server/VERSION 声明变量写入 manifest 的 version 字段。
# 用法：改 app/server/VERSION 一处，然后运行本脚本（或 fnpack build 前调用），
#       manifest 的 version 会自动同步，后端 APP_VERSION 从 VERSION 读，前端 brandVer 靠注入。
# 用法：bash scripts/sync-version.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER_FILE="$ROOT/server/VERSION"
MANIFEST="$ROOT/fnos-packaging/manifest"

if [ ! -f "$VER_FILE" ]; then
    echo "ERROR: $VER_FILE 不存在" >&2
    exit 1
fi

VERSION="$(cat "$VER_FILE" | tr -d '[:space:]')"
if [ -z "$VERSION" ]; then
    echo "ERROR: $VER_FILE 为空" >&2
    exit 1
fi

# 更新 manifest 的 version 行（保持缩进格式：`version               = X.Y.Z`）
if grep -q '^version' "$MANIFEST"; then
    sed -i "s/^version.*/version               = $VERSION/" "$MANIFEST"
else
    echo "ERROR: manifest 中找不到 version 行" >&2
    exit 1
fi

echo "✓ 版本号已同步：app/server/VERSION = $VERSION → manifest"
echo "  后端 APP_VERSION 从 VERSION 读，前端 brandVer 靠后端注入，均自动跟随。"
