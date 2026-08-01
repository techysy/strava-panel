# Strava Panel — fnOS App

[![GitHub release](https://img.shields.io/github/v/release/techysy/strava-fnos?label=Latest&color=blue)](https://github.com/techysy/strava-fnos/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/techysy/strava-fnos/blob/main/LICENSE)
[![fnOS 1.1.31xx](https://img.shields.io/badge/fnOS-1.1.31xx+-orange.svg)](https://developer.fnnas.com/docs/guide)
[![Strava API](https://img.shields.io/badge/API-Strava-orange.svg)](https://developers.strava.com/)

> Strava 骑行数据面板 — 凭据管理、Token 自动刷新、骑行统计可视化
>
> Strava cycling panel — credential management, auto token refresh, riding stats visualization

部署到飞牛 NAS (fnOS) 的 Strava 骑行数据面板，纯 Python 标准库零依赖后端。

---

## 功能 / Features

- 🔑 **凭据管理**：面板内配置 Client ID / Client Secret / Refresh Token
- 🔄 **Token 自动刷新**：每次访问 API 自动用 refresh_token 刷新 access_token（Strava token 6h 过期）
- 📊 **可视化面板**：骑行次数、总距离、总时长、总爬升 + 每周骑行图表 + 最近骑行列表
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

- 凭据：`/vol4/@appdata/strava/strava.conf`（权限 600，仅应用用户可读）
- Token 缓存：`/vol4/@appdata/strava/strava_tokens.json`
- **SQLite 缓存**：`/vol4/@appdata/strava/strava.db`（activities 表）

## HTTP API（本地 agent 查询）

应用提供 REST API，本地 Hermes agent 或其他工具可直接查询（`http://192.168.31.101:20127`）：

```bash
# 骑行统计（读缓存，快）
curl http://192.168.31.101:20127/api/stats
curl "http://192.168.31.101:20127/api/stats?start=2026-07-01&end=2026-07-31"   # 按月

# 活动列表（支持过滤）
curl "http://192.168.31.101:20127/api/activities?type=Ride&limit=10"
curl "http://192.168.31.101:20127/api/activities?start=2026-07-01"

# 每周聚合
curl "http://192.168.31.101:20127/api/weekly"

# 手动同步 Strava→SQLite
curl http://192.168.31.101:20127/api/sync

# 导出全量数据（给 agent）
curl "http://192.168.31.101:20127/api/export?fmt=json"
curl "http://192.168.31.101:20127/api/export?fmt=csv" -o strava.csv

# 状态（含 db 缓存数、最后同步时间）
curl http://192.168.31.101:20127/api/status
```

> 💡 agent 用法示例：`curl -s "http://192.168.31.101:20127/api/stats?start=2026-07-01&end=2026-07-31" | jq '.total_distance_km'`

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

| 现象 | 原因 | 解决 |
|------|------|------|
| 桌面图标打不开（连接拒绝） | `app/ui/config` 的 `port` 与 manifest `service_port` 不一致 | 两者都设为 `20127`，重新打包 |
| 服务起不来，日志 `Address already in use` | 旧进程残留占端口 | `cmd/main stop` 后清理残留（`pkill -f app.py`）再启动 |
| 服务起不来，日志无输出 | 旧版 cmd/main 的 `DATA_DIR` 指向不可写目录 | cmd/main 里 `DATA_DIR` 固定用 `/vol4/@appdata/<App>` |
| iframe 版白屏/跨域 | fnOS 桌面容器 iframe 跨端口受限 | 改用 url 版（新标签页） |
| Strava 401 `activity:read_permission missing` | 授权时未勾选活动数据权限 | 重新授权，勾选 `activity:read_all` |

> 💡 端口选择：fnOS 应用建议用**高位不常见端口**（如 20xxx），避开 8080/8081 等易被扫描端口，配合 fnOS 访问控制更安全。

## 相关链接 / Links

- [9Router](https://github.com/techysy/9router-fnos) — Hermes 相关 fnOS 应用（AI 路由器 / API 代理）
- [MetaCubeXD](https://github.com/techysy/metacubexd-fnos) — Hermes 相关 fnOS 应用（Mihomo 网络代理面板）
- [Hermes WebUI](https://github.com/techysy/hermes-webui-fnos) — Hermes 相关 fnOS 应用（WebUI 浏览器访问）
- [fnOS 开发者文档](https://developer.fnnas.com/docs/guide)

## License

MIT
