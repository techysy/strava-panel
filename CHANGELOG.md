# CHANGELOG / 更新日志

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
