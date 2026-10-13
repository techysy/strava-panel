#!/usr/bin/env bash
# Strava Panel 发版前审查脚本（13 项检查）
# 用法：bash scripts/release-check.sh
# 约定：server/VERSION 是唯一事实来源；先跑 scripts/sync-version.sh 再跑本脚本。
# 若 v<VERSION> 的 tag 已存在且 CHANGELOG 已归档该版本，则视为「已发布版本复查」，不算错误。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 颜色（仅 TTY 启用，重定向到文件/CI 日志时输出纯文本）
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

ERRORS=0
WARNINGS=0
TOTAL=13

echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Strava Panel 发版前审查${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo ""

err() { echo -e "  ${RED}✗ $1${NC}"; ERRORS=$((ERRORS + 1)); }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; WARNINGS=$((WARNINGS + 1)); }
ok() { echo -e "  ${GREEN}✓ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ $1${NC}"; }

# ── 1. server/VERSION 存在且为语义化版本 ──────────────────
echo -e "${YELLOW}[1/${TOTAL}] 🔢 server/VERSION 存在且为 semver${NC}"
VERSION=""
if [ ! -f server/VERSION ]; then
  err "server/VERSION 不存在"
else
  VERSION="$(tr -d '[:space:]' < server/VERSION)"
  if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'; then
    ok "VERSION = $VERSION"
  else
    err "server/VERSION 内容不是合法 semver: '$VERSION'"
    VERSION=""
  fi
fi
echo ""

if [ -z "$VERSION" ]; then
  echo -e "${RED}无法确定版本号，后续依赖版本号的检查（2/6/7）跳过${NC}"
  ERRORS=$((ERRORS + 3))
  echo ""
fi

# ── 2. 四处版本号一致 ──────────────────────────────────────
echo -e "${YELLOW}[2/${TOTAL}] 🔢 四处版本号一致（VERSION = fnos manifest = desktop = cli）${NC}"
if [ -n "$VERSION" ]; then
  read_manifest_version() {
    sed -nE 's/^version[[:space:]]*=[[:space:]]*([^[:space:]]+).*/\1/p' "$1" | head -1 | tr -d '\r'
  }
  read_pkg_version() {
    sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$1" | head -1 | tr -d '\r'
  }
  V_MANIFEST="$(read_manifest_version fnos-packaging/manifest)"
  V_DESKTOP="$(read_pkg_version desktop/package.json)"
  V_CLI="$(read_pkg_version cli/package.json)"
  MISMATCH=0
  for pair in "fnos-packaging/manifest:$V_MANIFEST" "desktop/package.json:$V_DESKTOP" "cli/package.json:$V_CLI"; do
    name="${pair%%:*}"; val="${pair#*:}"
    if [ -z "$val" ]; then
      err "$name 中读不到版本号"
      MISMATCH=1
    elif [ "$val" != "$VERSION" ]; then
      err "$name ($val) ≠ server/VERSION ($VERSION)——运行 bash scripts/sync-version.sh"
      MISMATCH=1
    fi
  done
  if [ "$MISMATCH" -eq 0 ]; then
    ok "四处版本号一致：$VERSION"
  fi
fi
echo ""

# ── 3. Server Node.js 语法检查 ─────────────────────────────
echo -e "${YELLOW}[3/${TOTAL}] 🟢 Server Node 语法检查（server/*.js, server/package.json 存在）${NC}"
if [ ! -f server/package.json ]; then
  err "server/package.json 不存在（后端已纯 Node ESM,应含 {\"type\":\"module\"}）"
fi
JS_GLOB_FAIL=0
SRV_COUNT=0
for f in server/*.js; do
  [ -f "$f" ] && SRV_COUNT=$((SRV_COUNT + 1))
done
if [ "$SRV_COUNT" -eq 0 ]; then
  err "server/*.js 不存在（Node 后端尚未落地?发版前必须存在 server/app.js 等）"
  JS_GLOB_FAIL=1
fi
if ! command -v node >/dev/null 2>&1; then
  warn "找不到 node，跳过 Server JS 语法检查"
elif [ "$JS_GLOB_FAIL" -eq 0 ]; then
  SRV_FAIL=0
  for f in server/*.js; do
    [ -f "$f" ] || continue
    if ! node --check "$f" 2>/tmp/release-check-node.err; then
      err "$f 语法错误"
      sed 's/^/     /' /tmp/release-check-node.err | head -5
      SRV_FAIL=1
    fi
  done
  rm -f /tmp/release-check-node.err
  if [ "$SRV_FAIL" -eq 0 ]; then
    ok "所有 Server JS 文件语法正确（${SRV_COUNT} 个文件）"
  fi
fi
echo ""

# ── 4. JS 语法检查 ─────────────────────────────────────────
echo -e "${YELLOW}[4/${TOTAL}] 🗂️  JS 语法检查（server + desktop + cli）${NC}"
if ! command -v node >/dev/null 2>&1; then
  warn "找不到 node，跳过 JS 语法检查"
else
  JS_FAIL=0
  JS_COUNT=0
  JS_FILES="server/app.js server/db.js desktop/main.js cli/cli.js"
  for f in cli/src/*.js cli/src/*/*.js cli/hooks/*.js cli/scripts/*.js; do
    [ -f "$f" ] && JS_FILES="$JS_FILES $f"
  done
  for f in $JS_FILES; do
    JS_COUNT=$((JS_COUNT + 1))
    if ! node --check "$f" >/dev/null 2>&1; then
      err "$f 语法错误"
      JS_FAIL=1
    fi
  done
  if [ "$JS_FAIL" -eq 0 ]; then
    ok "所有 JS 入口文件语法正确（${JS_COUNT} 个文件）"
  fi
fi
echo ""

# ── 5. CLI 构建 + npm pack 内容检查 ───────────────────────
echo -e "${YELLOW}[5/${TOTAL}] 📦 cli 构建与 npm pack 内容检查${NC}"
if ! command -v npm >/dev/null 2>&1; then
  warn "找不到 npm，跳过 CLI 构建与打包检查"
else
  build_log="$(mktemp)"
  if (cd cli && npm run build) >"$build_log" 2>&1; then
    ok "npm run build 完成（server/ + www/ → cli/app/）"
  else
    err "npm run build 失败"
    tail -10 "$build_log" | sed 's/^/     /'
  fi
  pack_log="$(mktemp)"
  if (cd cli && npm pack --dry-run) >"$pack_log" 2>&1; then
    PACK_MISSING=0
    for want in 'app/server/app.js' 'app/www/index.html'; do
      if ! grep -qF "$want" "$pack_log"; then
        err "npm 包内容中缺少 $want（检查 cli/package.json 的 files 字段）"
        PACK_MISSING=1
      fi
    done
    if [ "$PACK_MISSING" -eq 0 ]; then
      ok "npm pack 内容包含 app/server/app.js 与 app/www/index.html"
    fi
  else
    err "npm pack --dry-run 失败"
    tail -10 "$pack_log" | sed 's/^/     /'
  fi
  rm -f "$build_log" "$pack_log"
fi
echo ""

# ── 6. CHANGELOG 包含本版本条目 ────────────────────────────
echo -e "${YELLOW}[6/${TOTAL}] 📋 CHANGELOG 包含本版本条目${NC}"
CHANGELOG_HAS_VERSION=0
if [ -n "$VERSION" ]; then
  # 兼容 `## v1.3.1 (...)` 与 `## [1.3.1] ...` 两种格式；\. 转义版本号里的点
  VRE="$(echo "$VERSION" | sed 's/\./\\./g')"
  if grep -qE "^## \[?v?${VRE}(\]| |[()]|$)" CHANGELOG.md; then
    ok "CHANGELOG.md 已包含 $VERSION 条目"
    CHANGELOG_HAS_VERSION=1
  else
    err "CHANGELOG.md 中没有找到 $VERSION 版本条目（不要凭空补历史，确认版本号是否已归档）"
  fi
fi
echo ""

# ── 7. Git tag 未被占用 ────────────────────────────────────
echo -e "${YELLOW}[7/${TOTAL}] 🏷️  Git tag 状态检查${NC}"
ALREADY_RELEASED=0
if [ -n "$VERSION" ]; then
  LOCAL_TAG=""
  LOCAL_TAG="$(git tag -l "v${VERSION}" 2>/dev/null | head -1)"
  REMOTE_HIT=""
  REMOTE_OK=0
  REMOTE_OUT=""
  if REMOTE_OUT="$(timeout 15 git ls-remote --tags origin 2>/dev/null)"; then
    REMOTE_OK=1
    REMOTE_HIT="$(echo "$REMOTE_OUT" | grep -F "refs/tags/v${VERSION}" || true)"
  fi
  if [ -n "$LOCAL_TAG" ] || [ -n "$REMOTE_HIT" ]; then
    if [ "$CHANGELOG_HAS_VERSION" = "1" ]; then
      ALREADY_RELEASED=1
      info "v${VERSION} tag 已存在（本地${REMOTE_HIT:+/远端}），且 CHANGELOG 已归档——本次为已发布版本复查"
    else
      err "v${VERSION} tag 已存在，但 CHANGELOG 无该版本条目——请先 bump 版本号"
    fi
  else
    ok "Tag v${VERSION} 尚未使用，可以发版"
  fi
  if [ "$REMOTE_OK" -eq 0 ]; then
    warn "无法访问远端（离线或超时），仅检查了本地 tag"
  fi
fi
echo ""

# ── 8. 无敏感文件 ──────────────────────────────────────────
echo -e "${YELLOW}[8/${TOTAL}] 🔒 无敏感文件（.env / *.pem / *.key / id_rsa）${NC}"
SENS_TRACKED="$(git ls-files 2>/dev/null | grep -iE '(\.env$|\.env\.|\.pem$|\.key$|(^|/)id_rsa)' \
  | grep -viE '(example|sample|template)' || true)"
if [ -n "$SENS_TRACKED" ]; then
  err "敏感文件被 git 跟踪，发版前必须移除："
  echo "$SENS_TRACKED" | sed 's/^/     /'
fi
SENS_LOCAL="$(find . -path ./.git -prune -o -path './desktop/node_modules' -prune -o -path './cli/node_modules' -prune \
  -o -type f \( -name '.env' -o -name '.env.*' -o -name '*.env' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' \) -print 2>/dev/null \
  | grep -viE '(example|sample|template)' || true)"
if [ -n "$SENS_LOCAL" ]; then
  warn "工作区存在未被跟踪的敏感文件（确认不被打包/提交）："
  echo "$SENS_LOCAL" | sed 's/^/     /'
fi
if [ -z "$SENS_TRACKED" ] && [ -z "$SENS_LOCAL" ]; then
  ok "未发现敏感文件"
fi
echo ""

# ── 9. 无遗留调试代码（宽松，仅警告） ──────────────────────
echo -e "${YELLOW}[9/${TOTAL}] 🧹 无遗留调试代码${NC}"
DBG=""
DBG_LEFT=""
DBG_LEFT="$(grep -nE '\bdebugger\b|TODO\(DEBUG\)' server/*.js 2>/dev/null || true)"
DBG="${DBG}${DBG_LEFT}"
DBG_LEFT="$(grep -rnE '\bdebugger\b|TODO\(DEBUG\)|[?&]debug=true' desktop/main.js www/index.html 2>/dev/null || true)"
DBG="${DBG}${DBG_LEFT}"
if [ -n "$DBG" ]; then
  warn "发现可能的调试残留（如有意保留请忽略）："
  echo "$DBG" | head -5 | sed 's/^/     /'
else
  ok "未发现 debugger / debug=true 残留"
fi
echo ""

# ── 10. Docker 端口与镜像名一致 ────────────────────────────
echo -e "${YELLOW}[10/${TOTAL}] 🐳 Dockerfile / docker-compose 端口与镜像名一致${NC}"
DK_FAIL=0
DKF_PORT="$(grep -E '^EXPOSE[[:space:]]+[0-9]+' Dockerfile | awk '{print $2}' | head -1)"
CMP_PORT="$(grep -oE '"[0-9]+:[0-9]+"' docker-compose.yml | head -1 | cut -d: -f2 | tr -d '"')"
if [ -z "$DKF_PORT" ] || [ "$DKF_PORT" != "20227" ]; then
  err "Dockerfile EXPOSE 端口异常：${DKF_PORT:-未找到}（期望 20227）"
  DK_FAIL=1
fi
if [ -z "$CMP_PORT" ] || [ "$CMP_PORT" != "$DKF_PORT" ]; then
  err "docker-compose 容器侧端口 (${CMP_PORT:-未找到}) ≠ Dockerfile EXPOSE ($DKF_PORT)"
  DK_FAIL=1
fi
if ! grep -q 'image: techysy/strava-panel' docker-compose.yml; then
  err "docker-compose.yml 的 image 不是 techysy/strava-panel"
  DK_FAIL=1
fi
if ! grep -q 'techysy/strava-panel' Dockerfile; then
  err "Dockerfile 注释中未出现镜像名 techysy/strava-panel（构建命令应与 compose 一致）"
  DK_FAIL=1
fi
if [ "$DK_FAIL" -eq 0 ]; then
  ok "端口一致（20227），镜像名一致（techysy/strava-panel）"
fi
echo ""

# ── 11. fnOS manifest 必填键 ───────────────────────────────
echo -e "${YELLOW}[11/${TOTAL}] 📋 fnOS manifest 必填字段检查${NC}"
M_FAIL=0
for key in appname version display_name desc arch source maintainer service_port desktop_uidir desktop_applaunchname; do
  if ! grep -qE "^${key}[[:space:]]*=" fnos-packaging/manifest; then
    err "fnos-packaging/manifest 缺少必填字段: $key"
    M_FAIL=1
  fi
done
SVC_PORT="$(sed -nE 's/^service_port[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' fnos-packaging/manifest | head -1 | tr -d '[:space:]')"
if [ -n "$SVC_PORT" ] && [ "$SVC_PORT" != "20227" ]; then
  err "manifest service_port = $SVC_PORT，与 Docker 端口 20227 不一致"
  M_FAIL=1
fi
if [ "$M_FAIL" -eq 0 ]; then
  ok "fnOS manifest 字段完整，service_port=20227"
fi
echo ""

# ── 12. www/index.html 版本占位符 + 无外部 CDN ─────────────
echo -e "${YELLOW}[12/${TOTAL}] 🌐 www/index.html 占位符与外部依赖检查${NC}"
WEB_FAIL=0
if ! grep -q '__APP_VERSION__' www/index.html; then
  err "www/index.html 缺少 __APP_VERSION__ 占位符（brandVer 注入依赖它）"
  WEB_FAIL=1
fi
CDN_HITS="$(grep -nE 'unpkg\.|jsdelivr|cdnjs|cdn\.' www/index.html || true)"
if [ -n "$CDN_HITS" ]; then
  err "www/index.html 引用了外部 CDN（面板须离线自包含）："
  echo "$CDN_HITS" | head -5 | sed 's/^/     /'
  WEB_FAIL=1
fi
if [ "$WEB_FAIL" -eq 0 ]; then
  ok "__APP_VERSION__ 占位符在，无外部 CDN 引用"
fi
echo ""

# ── 13. 仓库无构建产物入库 ─────────────────────────────────
echo -e "${YELLOW}[13/${TOTAL}] 🗃️  仓库无构建产物入库（fpk/exe/dmg/zip/tgz）${NC}"
ART_TRACKED="$(git ls-files 2>/dev/null | grep -iE '\.(fpk|exe|dmg|zip|tgz)$|\.tar\.gz$' || true)"
if [ -n "$ART_TRACKED" ]; then
  err "构建产物被 git 跟踪，请从未跟踪目录出包："
  echo "$ART_TRACKED" | sed 's/^/     /'
fi
ART_LOCAL="$(find . -path ./.git -prune -o -path './desktop/node_modules' -prune -o -path './cli/node_modules' -prune \
  -o -type f \( -iname '*.fpk' -o -iname '*.exe' -o -iname '*.dmg' -o -iname '*.zip' -o -iname '*.tgz' -o -iname '*.tar.gz' \) -print 2>/dev/null | head -5 || true)"
if [ -n "$ART_LOCAL" ]; then
  warn "工作区存在构建产物（gitignored 则无碍，确认别手滑 git add）："
  echo "$ART_LOCAL" | sed 's/^/     /'
fi
if [ -z "$ART_TRACKED" ] && [ -z "$ART_LOCAL" ]; then
  ok "未发现入库/遗留的构建产物"
fi
echo ""

# ── 附：提交统计 ───────────────────────────────────────────
# 取 HEAD 可达的最近 tag（sort -V 可能选到不在当前分支上的未来 tag）
LATEST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="$(git tag -l 'v*' 2>/dev/null | sort -V | tail -1)"
fi
if [ -n "$LATEST_TAG" ]; then
  COMMIT_COUNT="$(git rev-list --count HEAD ^"$LATEST_TAG" 2>/dev/null || echo 0)"
  if [ "$COMMIT_COUNT" -gt 0 ]; then
    info "自 ${LATEST_TAG} 以来有 ${COMMIT_COUNT} 个提交（最近 5 条）："
    git log --oneline -5 | sed 's/^/     /' || true
    echo ""
  fi
fi

# ── 汇总 ──────────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
if [ "$ERRORS" -eq 0 ]; then
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "${GREEN}  ✅ v${VERSION} 复查通过（该版本已发布）${NC}"
  else
    echo -e "${GREEN}  ✅ 发版前审查通过（v${VERSION}）${NC}"
  fi
  if [ "$WARNINGS" -gt 0 ]; then
    echo -e "${YELLOW}     警告：$WARNINGS 处（非阻塞）${NC}"
  fi
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo ""
  if [ "$ALREADY_RELEASED" != "1" ]; then
    echo "下一步："
    echo "  1. 确认 CHANGELOG.md 的 ${VERSION} 条目内容准确"
    echo "  2. git tag v${VERSION}"
    echo "  3. git push origin main --tags"
    echo "  4. 等待 build-fpk / build-desktop / build-cli / docker-publish 自动构建"
  fi
  echo ""
  exit 0
else
  echo -e "${RED}  ✗ 发版前审查失败：$ERRORS 个错误${NC}"
  if [ "$WARNINGS" -gt 0 ]; then
    echo -e "${YELLOW}     警告：$WARNINGS 处${NC}"
  fi
  echo -e "${RED}═══════════════════════════════════════════════${NC}"
  echo ""
  echo "请修复上述错误后重新运行审查"
  echo ""
  exit 1
fi
