# Strava Panel 测试记录

> 发版规则：本地验证 OK 后再发正式包；测试包用 `当前版本.第四位累加`（如 1.2.1.1）；测试记录更新点/问题点，正式发布时聚合到 CHANGELOG。
> 版本体系：正式版 1.2.x 体系，基于 v1.2.0 连续递增：测试版四位累加 `1.2.1.1`，验收后正式版 `1.2.2`。
> 交付：新 fpk 放 `/vol1/1000/fnOS App/fpk/strava/`，旧 fpk 移 `../oldfpk/`。

---

## 1.2.1.1 (2026-08-10)

> 侧边栏多 Tab 管理面板重构（对齐 Hugo Blog 管理面板），基于 v1.2.0 大改。

### 更新点
- **🧭 侧边栏多 Tab 管理面板** — 重构为「仪表板 / 骑行数据 / 设置」三区，对齐 Hugo Blog 管理面板结构；顶部不再重复显示页标题（侧边栏承载导航）
- **📊 三组服务状态卡片** — 仪表板分「🔗 Strava API / 🗄️ 本地数据库 / 🤖 Agent 外部调用」三组展示：
  - Strava API：凭据、授权、最后同步、Athlete ID
  - 本地数据库：缓存活动数、DB 大小、DB 路径
  - Agent 外部调用：API token、调用次数、最后调用、端口、版本（`record_agent_call()` 记录每次受保护 API 调用）
- **📜 日志控制台** — 读取 `strava.log`，按日期归档查看、刷新、下载（`/api/logs/list`、`/api/logs`、`/api/logs/download`）；启动时自动按天归档到 `logs/`
- **🔗 Strava OAuth 授权** — 设置 → 凭据页「连接 Strava」按钮，独立窗口完成 Strava 授权，授权后自动回填并保存 refresh_token（`/api/oauth/start` + `/oauth/callback`，含 state 校验）
- **🔑 API token 管理** — `/api/token/view` 查看、`/api/token/recreate` 重新生成（立即生效，无需重启）
- **🤖 API 使用指南** — `/api/doc?lang=zh|en` 自动生成 Markdown 文档，设置页可一键复制给 agent
- **🗄️ 数据管理** — 设置页新增同步 / 导出 CSV / 导出 JSON 入口
- **📄 骑行数据页** — 统计卡片 + 年度/月度切换 + 每周图表 + 最近骑行分页表格
- **⚡ 数据接口优先读本地 SQLite** — `/api/stats`、`/api/weekly`、`/api/activities`、`/api/export` 直接读本地缓存，不再依赖 Strava token；仅本地为空时才尝试调 Strava 同步（`ensure_local_data()` 静默降级）
- **🏷 顶部状态标签简化** — 改为整体健康指示（运行正常 ✓ / 需关注 / 未配置 / 连接失败），不再与仪表盘三组状态重复
- **🛡 版本号注入防御** — `__APP_VERSION__` 占位符读不到版本时也替换为空，避免残留占位符
- **🔧 版本号体系改为 1.2.1** — manifest 版本号统一为 `1.2.1`（基于 v1.2.0 连续递增，废弃 v2.0.0）
- **🔢 版本号单一来源机制** — 新增 `app/server/VERSION` 声明变量文件（唯一手动改处）；`scripts/build.sh` 自动累加测试版第4位并打包；后端 APP_VERSION 从 VERSION 读
- **🏷 版本号显示改 hugo 方式** — `/api/bootstrap` 返回 `version`，前端动态填充 brandVer（不再依赖 `__APP_VERSION__` 占位符注入，兼容旧后端）
- **📜 日志多源落库** — 日志控制台分三个源切换：`system.log`（系统/初始化/SQLite/同步）、`strava-api.log`（请求 Strava API）、`agent.log`（agent 调用拿数据），各源独立归档
- **📅 骑行数据周期切换** — 默认「本月份」，新增「所有数据」选项（查看全部数据），原有「本年度」「上年度」保留
- **🏷 服务状态徽章** — 三组服务状态里的布尔项（凭据/授权/API token）用彩色徽章显示（绿✓正常 / 橙✗异常），数值/路径用文本
- **🗂 服务状态聚合卡片** — 每个业务一张聚合卡片（Strava API / 本地数据库 / Agent 外部调用），内部多行 label-value 展示，不再每个字段一张小卡片
- **🔍 周期筛选边界** — `/api/stats` 同时传 `start` + `end` 明确周期边界；「上年度」限定为完整去年（去年 1/1–12/31），不再跨到今年
- **📈 月度面积折线图** — 骑行数据图表改为「每月骑行距离」面积折线图（参考官方 Strava app，纯 SVG 零依赖）：橙色渐变面积 + 折线 + 数据点 + 月/距轴，`/api/stats` 新增 `monthly` 字段
- **⏳ 同步进度提醒** — 「立即同步」时前端轮询 `/api/sync/progress` 实时显示进度（已拉取第 N 页 · M 条 → 写入本地 → 完成），不再静默等待；同步期间 `strava-api.log` 记录每页进度

### 问题点（已解决 / 待解决）
- **`Unexpected token '<'` 报错** — 根因：运行中的后端进程仍是旧代码（未重启），但它从磁盘实时 serve 了新的 index.html，前端请求新接口（/api/info 等）时旧后端返回 404 HTML，`res.json()` 解析失败。**待解决**：需在 App Center 重启应用加载新后端。
- **`v_APP_VERSION_` 版本占位符未替换** — 根因同上（旧进程无版本注入逻辑）。已做防御：新代码读不到版本时也替换占位符为空，重启后自动显示 v1.2.1。
- **顶部页标题与侧边栏重复** — 已去重：topbar 移除「仪表板/骑行数据」标题，仅保留汉堡、状态、语言、主题。

### 验证状态
- [x] 后端语法（py_compile）+ 前端 JS 语法（node --check）
- [x] 数据接口读本地 DB（本地造数据，Strava token 失效仍返回缓存数据）
- [x] 三组服务状态卡片渲染 + Agent 调用计数递增
- [x] 日志控制台（list / 读取 / 归档 / 下载）
- [x] Strava OAuth（/api/oauth/start 生成 URL + state 校验 + code 交换）
- [x] API token 查看/重新生成
- [x] /api/doc 生成 + 顶部标题去重
- [x] fpk 打包成功（url + iframe 双版，manifest 版本 1.2.1）
- [ ] 交付目录整理：新 1.2.1.1 fpk 入 `fpk/strava/`，旧 fpk 移 `fpk/oldfpk/`
- [ ] App Center 重启后回归（含 OAuth 授权、三组状态、日志控制台） — **待办**

---

## ⚠️ 已知坑 / Pitfall

- **应用重启必须走 App Center** — 运行中的进程由 fnOS 以应用用户启动，SSH 的 `yangyu` 无权限杀掉 `strava` 用户进程（sudo 需密码）。改代码后必须到 App Center 对 Strava Panel 做「停止→启动」加载新后端，不能只刷新页面/重开桌面图标。
- **前端新界面 ≠ 后端新代码** — index.html 每次从磁盘实时读取，改前端立即生效；但 app.py 是进程启动时载入内存的，改后端必须重启进程才生效。若看到新界面 + 旧接口 404，是后端进程没重启。
- **OAuth 回调地址需在 Strava 注册** — 面板「连接 Strava」用的 redirect_uri 需在 Strava API 设置里添加（如 `http://<NAS-IP>:20227/oauth/callback`），否则授权后回调失败。
