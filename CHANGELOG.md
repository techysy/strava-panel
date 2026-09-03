# CHANGELOG / 更新日志

---

## v1.2.3 (2026-09-03)

### 🎯 Strava OAuth 授权彻底打通（核心修复）

本版修复了多个相互叠加的问题，使 Strava 授权 → token 存储 → 数据同步**全链路真正可用**：

- 🔑 **修复 token 被误删**：`save_config` 原会无条件删除 `strava_tokens.json`，导致授权/刷新成功后 token 随即丢失、缓存永远不存在（每次轮询都重复刷新）。现改为**仅当 refresh_token 实际变更**才清缓存；`exchange_code`/`refresh_token` 改为先保存 config 再写 token。
- ⚡ **修复并发竞态**：`/api/info` 每 1 秒轮询会触发 `refresh_token()`，与 OAuth 授权写 token **并发互相覆盖**（授权换到的新 token 被旧 refresh 覆盖回 read-only）。现用 `RLock` 串行化 token/config 读改写。
- 🎯 **修复 scope 误判**：Strava 返回的 scope 是**空格分隔**（`activity:read_all read`），原按逗号 `split(",")` 误判缺 `activity:read_all`，即使授权成功 token 也被判失效。现兼容逗号/空格两种分隔。
- 🔗 **修复回调地址**：不再自动跟随访问入口 —— 仅内网/本机 Host 才推导回调；公网中转域名（`office.app.5ddd.com`）及残缺相对路径（`/oauth/callback`）一律拒绝，改为引导用户显式配置完整 `http://<NAS内网IP>:20227/oauth/callback`。

### 🖼️ 其他改进

- 📊 **骑行数据图表对齐官方 Strava**：
  - 时间筛选合并为一组：近7天 / 近1月 / 近3月 / 近6月 / 本年度 / 近12月 / 所有（去掉原双行重叠按钮与 7D/YTD 英文简写，全量 i18n）。
  - 粒度按官方：近7天/近1月→每日；近3月/近6月→每周；本年度/近12月→每月；所有→每年。
  - **空桶补全**：每日/周/月补全范围内所有时间点，无骑行返回 0，图表时间轴不再断裂。
  - **Y 轴 ×1.2 顶部留白**，最高点不贴图顶；曲线平滑（Catmull-Rom 贝塞尔）；0 值天保留在时间轴但不显示数值文字。
  - 时间筛选按钮 flex 自适应换行，移动端整洁不溢出。
- 🔐 **设置页凭据回显免重输**：进设置页自动回填已保存的 client_id / client_secret / redirect_uri（本地面板 API token 保护下回显），已保存/已连接状态有提示；`/api/config` 拒绝残缺相对路径 redirect_uri。
- 🖼️ **应用图标换成 Strava 官方橙色圆角徽标**（替换原自绘近似图）。
- 🔧 **OAuth 诊断**：`exchange_code` 失败时记录 Strava 返回的具体原因到日志，便于排查。

---

## v1.2.2 (2026-09-02)

### 修复 / Fixed

- 🔧 **修复"假绿"状态**：token 是否有效现在会校验 `scope` 含 `activity:read_all`。若 refresh 拿到的 access_token 只带 `read` scope（历史上只用只读 scope 授权），不再显示绿色"正常"，而是提示"scope 缺 activity:read_all，需重新 OAuth 授权"；同步接口也不再反复触发 401。`/athlete/activities` 需要 `activity:read_all`，缺它必然 401，旧状态判定只检查"能否拿到任意 token"导致误报正常。
- 🔗 **修复 OAuth 授权窗口/回调**：回调地址不再兜底成 `http://localhost/`（code 回不到面板）。`get_redirect_uri()` 现按请求 Host 推导（用户从哪个地址打开面板，回调就落哪），配置了 redirect_uri 仍优先。设置页会自动回填完整回调地址并提示，便于在 Strava API 注册。

---

## v1.2.1 (2026-08-10)

### 新增 / Added

- 🧭 **侧边栏 + 多 Tab 管理面板**：对齐 Hugo Blog 管理面板结构，重构为「仪表板 / 骑行数据 / 设置」三区
- 📊 **三组服务状态卡片**：仪表板分「🔗 Strava API / 🗄️ 本地数据库 / 🤖 Agent 外部调用」三组展示
  - Strava API：凭据、授权、最后同步、Athlete ID
  - 本地数据库：缓存活动数、DB 大小、DB 路径
  - Agent 外部调用：API token、调用次数、最后调用、端口、版本
- 📜 **日志控制台**：读取 `strava.log`，支持按日期归档查看、刷新、下载（`/api/logs/list`、`/api/logs`、`/api/logs/download`），启动时自动按天归档到 `logs/`
- 🔑 **token 管理**：`/api/token/view` 查看、`/api/token/recreate` 重新生成（立即生效，不再需重启）
- 🤖 **API 使用指南**：`/api/doc?lang=zh|en` 自动生成 Markdown 文档，面板「设置 → API」可一键复制给 agent
- 🗄️ **数据管理**：设置页新增同步 / 导出 CSV / 导出 JSON 入口
- 🔗 **Strava OAuth 授权**：设置 → 凭据页「连接 Strava」按钮，在独立窗口完成 Strava 授权，授权后自动回填并保存 refresh_token（`/api/oauth/start` + `/oauth/callback`，含 state 校验）
- 📄 **骑行数据页**：统计卡片 + 年度/月度切换 + 每周图表 + 最近骑行分页表格

### 变更 / Changed

- **数据接口优先读本地 SQLite**：`/api/stats`、`/api/weekly`、`/api/activities`、`/api/export` 直接读本地缓存，不再依赖 Strava token；仅本地为空时才尝试调 Strava 同步（`ensure_local_data()` 静默降级）
- **Agent 调用统计**：受保护的 `/api/*` 接口记录调用次数 + 最后调用时间（持久化到 DB meta），仪表板展示
- **顶部状态标签简化**：改为整体健康指示（运行正常 ✓ / 需关注 / 未配置 / 连接失败），不再与仪表盘三组状态重复
- **去掉顶部页标题**：侧边栏已承载导航，topbar 不再重复显示「仪表板/骑行数据」标题
- **版本号注入防御**：`__APP_VERSION__` 占位符读不到版本时也替换为空，避免残留占位符
- 前端从单页 dashboard 重构为侧边栏多 Tab 结构，保留日夜主题 + 中/英 i18n
- 骑行活动列表按 `start_date_local` 显示本地日期

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
