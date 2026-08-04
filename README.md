# Strava Panel for fnOS

Strava 骑行数据面板 — 凭据管理、Token 自动刷新、骑行统计可视化。

[![GitHub release](https://img.shields.io/github/v/release/techysy/strava-panel-fnos?label=Latest&color=blue)](https://github.com/techysy/strava-panel-fnos/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/techysy/strava-panel-fnos/blob/main/LICENSE)
[![fnOS 1.1.31xx](https://img.shields.io/badge/fnOS-1.1.31xx+-orange.svg)](https://developer.fnnas.com/docs/guide)
[![Strava API](https://img.shields.io/badge/API-Strava-orange.svg)](https://developers.strava.com/)

> 部署到飞牛 NAS (fnOS) 的 Strava 骑行数据面板，纯 Python 标准库零依赖后端。

- [English README](./README.en.md)

---

## ✨ 功能亮点

- 🔑 **凭据管理** — 面板内配置 Client ID / Secret / Refresh Token
- 🔄 **Token 自动刷新** — 每次访问 API 自动刷新 access_token（Strava token 6h 过期）
- 📊 **可视化面板** — 骑行次数、总距离、总时长、总爬升 + 每周图表 + 最近骑行
- 📅 **统计周期切换** — 本年度 / 本月份
- 🌗 **日夜模式** · 🌐 **中英界面**
- 🗄️ **SQLite 本地缓存** — 读取更快、离线可看历史
- 📤 **agent 透出接口** — 本地 agent 直接 HTTP 查询
- 🔒 **零依赖** — 纯 Python 标准库（http.server + sqlite3）

## 🚀 快速安装

1. 从 [Releases](https://github.com/techysy/strava-panel-fnos/releases) 下载 `strava-x.x.x.fpk`
2. 飞牛 **App Center → 手动安装** → 选择 fpk
3. 打开 Strava Panel（端口 `20127`）
4. 在面板填入 Strava 凭据 → 保存并验证

### 获取 Strava 凭据

1. 访问 [Strava My API Application](https://www.strava.com/settings/api) 查看 **Client ID** 和 **Client Secret**
2. 用下面链接授权获取 **Refresh Token**（需勾选 `activity:read_all`）：

```
https://www.strava.com/oauth/authorize?client_id={你的ClientID}&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read,activity:read_all
```

3. 跳转后复制 `code=` 后面的值，在 [Strava token 交换](https://www.strava.com/oauth/token) 换取 refresh_token

## 📖 使用说明

### 端口与数据

| 项 | 值 |
|---|---|
| 面板端口 | `20127`（高位端口，降低扫描风险）|
| 凭据 | `/vol4/@appdata/strava/strava.conf`（权限 600）|
| Token 缓存 | `/vol4/@appdata/strava/strava_tokens.json` |
| SQLite 缓存 | `/vol4/@appdata/strava/strava.db` |

### HTTP API（本地 agent 查询）

应用提供 REST API，本地 Hermes agent 或其他工具可直接查询（`http://192.168.31.101:20127`）。

> 🔐 **v1.2.0 起需要 API Token**：数据接口需携带 `Authorization: Bearer <token>`。token 通过免认证的 `/api/bootstrap` 获取：

```bash
# 1. 获取 API token（免认证）
TOKEN=$(curl -s http://192.168.31.101:20127/api/bootstrap | jq -r '.api_token')

# 2. 带 token 访问数据接口
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.31.101:20127/api/stats
curl -s -H "Authorization: Bearer $TOKEN" "http://192.168.31.101:20127/api/stats?start=2026-07-01&end=2026-07-31"   # 按月
curl -s -H "Authorization: Bearer $TOKEN" "http://192.168.31.101:20127/api/activities?type=Ride&limit=10"
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.31.101:20127/api/weekly
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.31.101:20127/api/sync
curl -s -H "Authorization: Bearer $TOKEN" "http://192.168.31.101:20127/api/export?fmt=json"
curl -s -H "Authorization: Bearer $TOKEN" "http://192.168.31.101:20127/api/export?fmt=csv" -o strava.csv
```

> 💡 agent 用法：`curl -s -H "Authorization: Bearer $TOKEN" "http://192.168.31.101:20127/api/stats?start=2026-07-01&end=2026-07-31" | jq '.total_distance_km'`

> ⚠️ 未带 token 的请求返回 **401**。前端面板自动处理 token，无需手动配置。token 存于 `strava.conf`（权限 600），如需重置删除该行后重启应用即可。

## 🐛 问题排查

常见问题与详细排障，见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

## 🛠️ 从源码构建

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

## 📚 相关项目

- [9Router](https://github.com/techysy/9router-fnos) · [MetaCubeXD](https://github.com/techysy/metacubexd-fnos) · [Hermes WebUI](https://github.com/techysy/hermes-webui-fnos) — 更多 fnOS 应用
- [fnOS 开发者文档](https://developer.fnnas.com/docs/guide)

## License

MIT
