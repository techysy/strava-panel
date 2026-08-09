# Strava Panel — fnOS App

[![GitHub release](https://img.shields.io/github/v/release/techysy/strava-panel-fnos?label=Latest&color=blue)](https://github.com/techysy/strava-panel-fnos/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/techysy/strava-panel-fnos/blob/main/LICENSE)
[![fnOS 1.1.31xx](https://img.shields.io/badge/fnOS-1.1.31xx+-orange.svg)](https://developer.fnnas.com/docs/guide)
[![Strava API](https://img.shields.io/badge/API-Strava-orange.svg)](https://developers.strava.com/)

> Strava 骑行数据面板 — 凭据管理、Token 自动刷新、骑行统计可视化
>
> Strava cycling panel — credential management, auto token refresh, riding stats visualization

部署到飞牛 NAS (fnOS) 的 Strava 骑行数据面板，纯 Python 标准库零依赖后端。

## 作者 / Author

洋芋 (YangYu) · 🚴 [Strava 主页](https://www.strava.com/athletes/121173304) · 🐂 [fnOS 应用系列](https://github.com/stars/techysy/lists/fnos-app)

---

## 功能 / Features

- 🧭 **侧边栏多 Tab 管理面板**：仪表板 / 骑行数据 / 设置，对齐 Hugo Blog 管理面板结构
- 📊 **三组服务状态**：🔗 Strava API（凭据/授权/同步）、🗄️ 本地数据库（缓存数/大小/路径）、🤖 Agent 外部调用（调用统计）
- 📜 **日志控制台**：读取 `strava.log`，按日期归档查看、刷新、下载
- 🔑 **凭据管理**：面板内配置 Client ID / Client Secret / Refresh Token
- 🔄 **Token 自动刷新**：每次访问 API 自动用 refresh_token 刷新 access_token（Strava token 6h 过期）
- 📄 **骑行数据**：骑行次数、总距离、总时长、总爬升 + 每周骑行图表 + 最近骑行分页列表
- 📅 **统计周期切换**：本年度 / 本月份，明确统计边界（默认年度）
- 🔑 **API token 管理**：查看 / 重新生成，立即生效
- 🤖 **API 使用指南**：面板内一键复制 agent 可用的 REST API 文档
- 🌗 **日夜模式**：暗/亮主题切换（记忆选择，默认跟随系统）
- 🌐 **i18n**：中/英双语界面切换
- 🗄️ **SQLite 本地缓存**：数据缓存到 NAS，读取更快、离线可看历史
- 📤 **agent 透出接口**：本地 agent 直接 HTTP 查询
- 🔒 **零依赖**：纯 Python 标准库（http.server + sqlite3），无第三方包

## 快速开始 / Quick Start

1. 从 [Releases](https://github.com/techysy/strava-fnos/releases) 下载 `strava-x.x.x.fpk`
2. 飞牛 App Center → **手动安装** → 选择 fpk 文件
3. 打开 Strava Panel（端口 `20127`）
4. 在面板填入 Strava 凭据 → 保存并验证

### 获取 Strava 凭据 / Get Strava Credentials

1. 访问 [Strava My API Application](https://www.strava.com/settings/api) 查看 **Client ID** 和 **Client Secret**
2. 用下面链接授权获取 **Refresh Token**（需勾选 `activity:read_all`）：
   ```
   https://www.strava.com/oauth/authorize?client_id={你的ClientID}&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read,activity:read_all
   ```
3. 跳转后复制 `code=` 后面的值，在 [Strava token 交换](https://www.strava.com/oauth/token) 或用工具换取 refresh_token

## 端口 / Port

- **面板端口**：`20127`（高位不常见端口，降低被扫描探测风险）

## 数据目录 / Data

- 凭据 + API token：`/vol4/@appdata/strava/strava.conf`（权限 600，仅应用用户可读）
- Token 缓存：`/vol4/@appdata/strava/strava_tokens.json`
- **SQLite 缓存**：`/vol4/@appdata/strava/strava.db`（activities 表）
- 应用日志：`/vol4/@appdata/strava/strava.log`（历史按天归档到 `logs/`）

## HTTP API（本地 agent 查询）

应用提供 REST API，本地 Hermes agent 或其他工具可直接查询（`http://192.168.31.101:20127`）。除 `/api/bootstrap` 和 `/api/status` 外，所有 `/api/*` 需 `Authorization: Bearer <api_token>`。

> 🔑 先拿 token（免认证）：`GET /api/bootstrap` → 返回 `{"api_token": ...}`，也可在面板「仪表板 → 创建 token」查看。

```bash
BASE="http://192.168.31.101:20127"
TOKEN=$(curl -s "$BASE/api/bootstrap" | python3 -c "import sys,json;print(json.load(sys.stdin)['api_token'])")
AUTH="Authorization: Bearer $TOKEN"

# 服务状态（免认证）
curl -s "$BASE/api/status"

# 服务信息（含版本/端口/缓存数）
curl -s -H "$AUTH" "$BASE/api/info"

# 骑行统计（读缓存，快；可带日期范围）
curl -s -H "$AUTH" "$BASE/api/stats"
curl -s -H "$AUTH" "$BASE/api/stats?start=2026-07-01&end=2026-07-31"   # 按月

# 活动列表（支持过滤）
curl -s -H "$AUTH" "$BASE/api/activities?type=Ride&limit=10"
curl -s -H "$AUTH" "$BASE/api/activities?start=2026-07-01"

# 每周聚合
curl -s -H "$AUTH" "$BASE/api/weekly"

# 手动同步 Strava→SQLite
curl -s -X POST -H "$AUTH" "$BASE/api/sync"

# 导出全量数据（给 agent）
curl -s -H "$AUTH" "$BASE/api/export?fmt=json"
curl -s -H "$AUTH" "$BASE/api/export?fmt=csv" -o strava.csv

# 日志控制台
curl -s -H "$AUTH" "$BASE/api/logs/list?source=strava"
curl -s -H "$AUTH" "$BASE/api/logs?source=strava&tail=200"
curl -s -H "$AUTH" -o strava.log "$BASE/api/logs/download?source=strava"

# token 管理
curl -s -H "$AUTH" "$BASE/api/token/view"
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{}" "$BASE/api/token/recreate"

# API 使用指南（Markdown）
curl -s -H "$AUTH" "$BASE/api/doc?lang=zh"
```

> 💡 面板「设置 → API」可一键复制完整 API 指南；agent 用法示例：`curl -s -H "$AUTH" "$BASE/api/stats?start=2026-07-01&end=2026-07-31" | jq '.total_distance_km'`（无 jq 用 `python3 -m json.tool`）

## 构建 / Build

构建需要 `fnpack`（fnOS 打包工具）。构建目录与 9Router/metacubexd 一致：

```bash
# 在 NAS 上
mkdir -p "/vol1/1000/fnOS App/build/strava-fnos"
# 同步项目文件到这里
cd "/vol1/1000/fnOS App/build/strava-fnos"
fnpack build            # 生成 strava.fpk (url 版)
mv strava.fpk strava-1.0.0.fpk
sed -i 's/"type": "url"/"type": "iframe"/' app/ui/config   # 切 iframe
fnpack build
mv strava.fpk strava-1.0.0-iframe.fpk
```

### 图标 / Icons

图标用 `scripts/generate-icons.py` 生成（橙色渐变 + 白色 S + 骑行三角，小圆角对齐 fnOS 规范）：

```bash
python3 scripts/generate-icons.py
```

## 问题排查 / Troubleshooting

常见问题快速索引（详细排障见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)）：

| 现象 | 快速解决 |
|------|---------|
| 桌面图标打不开 | 确认应用在 App Center 里是启用/运行状态，端口为 20127 |
| `Unexpected token '<'` | 旧进程占端口，杀残留后重启应用 |
| `Address already in use` | `pkill -9 -f "python3 app.py"` 清理残留 |
| Strava 401 权限缺失 | 重新授权并勾选 `activity:read_all` |
| 数据不更新 | 面板「立即同步」或 `curl /api/sync` |

## 相关链接 / Links

- [9Router](https://github.com/techysy/9router-fnos) — Hermes 相关 fnOS 应用（AI 路由器 / API 代理）
- [MetaCubeXD](https://github.com/techysy/metacubexd-fnos) — Hermes 相关 fnOS 应用（Mihomo 网络代理面板）
- [Hermes WebUI](https://github.com/techysy/hermes-webui-fnos) — Hermes 相关 fnOS 应用（WebUI 浏览器访问）
- [fnOS 开发者文档](https://developer.fnnas.com/docs/guide)

## License

MIT
