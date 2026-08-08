# CHANGELOG / 更新日志

---

## v1.2.1 (2026-08-08)

### 新增 / Added

- **侧边栏导航 + 移动端汉堡菜单** — 参考飞牛官方 / Hermes Core / 9Router 风格重构 UI：
  - 左侧边栏（品牌区 + 导航项 + 系统分组），激活项蓝色高亮 + 左侧蓝条
  - 导航视图切换（仪表盘 / 骑行记录 / 配置），`switchNav()` 切换
  - 移动端（≤768px）汉堡菜单：侧边栏滑出/收起 + 遮罩层

### 变更 / Changed

- 前端布局重构（`app/www/index.html`），保留原有 i18n / 日夜模式 / 数据统计功能

---

## v1.2.0 (2026-08-01)

### 新增 / Added

- 🔐 **API Token 认证**：所有数据接口（`/api/stats`、`/api/activities`、`/api/weekly`、`/api/export`、`/api/sync`、`/api/config`）新增访问 token 保护。前端面板通过 `/api/bootstrap`（免认证）自动获取 token，agent 需用 `Authorization: Bearer <token>` 访问。
- ⚙️ `api_token` 自动生成，存储在 `strava.conf`（权限 600）

### 使用 / Usage

```bash
# 获取 token
TOKEN=$(curl -s http://<NAS>:20127/api/bootstrap | jq -r '.api_token')
# 带 token 访问
curl -s -H "Authorization: Bearer $TOKEN" "http://<NAS>:20127/api/stats?start=2026-01-01"
```

### 兼容性 / Note

- 未带 token 的 API 请求返回 **401**
- 前端面板自动处理 token（无需手动配置），行为不变

---

## v1.1.5 (2026-08-01)

### 修复 / Fixes

- **status 退出码**：修复 `status()` 在服务未运行时返回非零退出码（1），与 metacubexd/9router 一致。fnOS 依赖 status 退出码判断应用是否运行——之前 strava 的 status 在 stopped 时错误返回 0（被 fnOS 误判为 running），导致 fnOS 从不调用 `start`，服务无法自动启动

---

## v1.1.4 (2026-08-01)

### 修复 / Fixes

- **SO_REUSEADDR**：app.py 设置 `ThreadingTCPServer.allow_reuse_address = True`，解决频繁重启后 TIME_WAIT 导致 `Address already in use` / 服务起不来的问题（fnOS 以应用用户重启时尤为明显）
- cmd/main 增强诊断日志（记录 fnOS 调用参数 `$1`、环境变量、SRC_DIR 判定、启动过程）

---

## v1.1.3 (2026-08-01)

### 修复 / Fixes

- cmd/main 增加诊断日志（`strava-diag.log`），记录 fnOS 传入的 TRIM 环境变量 + 启动错误，用于排查 fnOS 以应用用户启动失败的问题

---

## v1.1.2 (2026-08-01)

### 修复 / Fixes

- **cmd/main 启动可靠性**：改用 `setsid python3 -u`（无缓冲）+ 更强的残留进程清理（`pkill` 匹配任意路径 app.py），解决后台启动偶发 `Address already in use` / 连接拒绝问题。fnOS App Center 现可可靠自动启动服务（NAS 重启后服务自愈）

---

## v1.1.1-docs (2026-08-01)

### 文档 / Docs

- 📝 拆出独立 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)，README 只留简要排障索引
- 📛 仓库更名为 **strava-panel-fnos**
- ✍️ README 新增作者署名 + Strava 主页链接

---

## v1.1.1 (2026-08-01)

### 新增 / Added

- 📅 **统计周期切换**：面板新增「本年度 / 本月份」切换，默认本年度，明确统计边界
- ⚡ **平均速度**：最近骑行列表新增均速列（km/h）

### 修复 / Fixes

- `/api/sync` 偶发前端报错 `Unexpected token '<'`：确认是旧进程占端口所致，非代码 bug；重装后服务正常

---

## v1.1.0 (2026-08-01)

### 新增 / Added

- 🗄️ **SQLite 本地缓存**：骑行数据缓存到 `/vol4/@appdata/strava/strava.db`，读取更快，Strava API 不可用时也能查看历史
- 🔄 **手动同步**：面板新增「立即同步」按钮 + `/api/sync` 接口
- 📤 **agent 透出接口**：`/api/export?fmt=json|csv` 导出全量数据，本地 Hermes agent 可直接查询
- 🔍 **查询增强**：`/api/stats` / `/api/activities` 支持 `start`/`end`/`type`/`limit` 过滤
- 🔒 **凭据安全**：`strava.conf` / `strava_tokens.json` 权限设为 600

### 变更 / Changed

- `/api/stats` 改为读 SQLite 缓存（首次自动同步）

---

## v1.0.1 (2026-08-01)

### 新增 / Added

- 🌗 **日夜模式**：暗/亮主题切换（记忆选择，默认跟随系统）
- 🌐 **i18n 多语言**：中/英双语界面切换（记忆选择，默认中文）

### 变更 / Changed

- 移除多余的 fnOS App Center 设置页面（wizard/config），统一由面板主页初始化页配置凭据
- 前端改为纯客户端渲染 i18n + 主题，无后端改动

---

## v1.0.0 (2026-08-01)

### 初始版本 / Initial Release

- Strava 骑行数据面板 fnOS 应用
- 凭据管理（面板/应用设置双入口）
- Token 自动刷新（Strava 6h 过期自动 refresh）
- 可视化面板（统计卡片 + 每周图表 + 最近骑行）
- 纯 Python 标准库零依赖后端（http.server）
- 端口 `20127`（高位不常见端口）
- 双版本 fpk（url / iframe）

### 迭代修复 / Fixes

- `cmd/main` 的 `DATA_DIR` 固定用 `/vol4/@appdata/<App>`（不受 `TRIM_APPDEST` 布局影响）
- `app/ui/config` 的 `port` 与 manifest `service_port` 对齐（避免桌面图标指向错误端口）
- `cmd/main` 增加残留进程清理（`pkill` + 端口检测），避免 `Address already in use`
- 面板 placeholder 脱敏（不暴露 Client ID）
