# Strava Panel 测试记录

> 发版规则：本地验证 OK 后再发正式包；测试记录更新点/问题点，正式发布时聚合到 CHANGELOG。
> 版本体系：统一三段语义化版本号（X.Y.Z），测试包与正式包同号；`server/VERSION` 为唯一事实来源，改完跑 `bash scripts/sync-version.sh` 同步到 manifest / desktop/package.json / cli/package.json。
> 交付：新 fpk 放 `/vol1/1000/fnOS App/fpk/strava/`，旧 fpk 移 `../oldfpk/`。

---

## 2.5.2 (2026-10-16)

> 阻塞级功能修复 + **原生 FIT 文件工具**（新 tab）+ **出行计划**（新 tab）+ **教练运动方式过滤**。

### 新功能：出行计划（移植 Hermes skill cycling/outdoor-trip-planner）
- 新增「出行计划」tab，按 skill 流程实现：确认日期（一键下周末）→ 查目的地天气 → 查高铁余票 → 装备/穿衣提醒。
- 后端 `server/trip.js`（从 skill 移植，12306 查询逻辑 + Open-Meteo 天气 + 内置 5 个常用目的地：松潘/黄龙九寨/西昌邛海/米易梯田/峨眉山零公里）：
  - `GET /api/trip/weather?lat&lon&days` — Open-Meteo 逐时天气，聚合为逐日 6~18 点运动窗口（最高/最低温、最大降雨概率、代表天气）；
  - `GET /api/trip/trains?from&to&date&type` — 12306 余票（车站数据缓存 7 天到 DATA_DIR），支持城市/站名解析、G/D/C 车型过滤；
  - `GET /api/trip/destinations` — 目的地表。
  - 浏览器直连 12306 会被 CORS 拦，故全部走服务端代理；三个端点都吃面板 api_token。
- 前端：目的地选择联动经纬度/到达站/简介；天气表高亮所选日期；车票表含商务/一等/二等/软卧席位与可购状态；中英文全量 i18n。
- 已实测：松潘天气 7 天聚合正确；成都东→松潘 D280 余票查询正确（黄龙九寨站为松潘景区实际车站，12306 按城市返回，与官网行为一致）。

### 新功能：教练按运动方式过滤（修「骑行选手被推跑步课」）
- 训练建议页新增「运动方式」选择器（骑行/跑步/步行/徒步/游泳/室内骑行/综合训练，多选），存 `strava.conf` 的 `coach_sports`。
- 三层生效：① `COACH_SYSTEM` 注入硬性规则「只允许在所选运动内推荐训练，交叉训练仅用户主动要求时提及」；② `buildTrainingDigest` 按所选运动过滤 stats/weekly/最近活动（不再写死 Ride）；③ 教练角色行动态化（骑行教练/跑步教练/骑行+跑步教练）。
- `db.stats` / `db.weekly` / `db.getRides` / `db.getActivities` 支持类型数组，默认 `['Ride']` 保持向后兼容；已用真实数据验证类型过滤（Ride 2 / Ride+Run 3 / Run 1）。

### 新功能：FIT 文件工具（原生实现）
- 新增「FIT 工具」tab，四个能力全部在浏览器本地完成，**文件不上传任何服务器**：
  - **删除功率 / 心率**：从 record 定义消息里彻底摘掉字段（不是填 0），设备与平台不再显示；
  - **拆分**：按时间断点（码表自动分段记录）或固定条数切成多份，每份独立合法；
  - **合并**：多文件按时间自动衔接去重（时间轴不重叠、严格递增），重建 lap/session；
  - **转换 GPX / TCX**：轨迹、高程、心率、踏频、功率全字段映射。
- 实现要点：`www/fit.js`（解析内核：CRC16 半字节表、定义/数据消息、大端、压缩时间戳累积器、字段级 size 精确读写）+ `www/fit-ui.js`（拖拽多文件、概览标签、四工具面板）。
- 质量保障：`scripts/fit-selftest.mjs`（51 项断言，以第三方 `fit-file-parser` 为独立裁判，覆盖 CRC 抗错、压缩时间戳重序列化往返、大端解析、四工具输出字节级验证）。运行：`npm install fit-file-parser --no-save && node scripts/fit-selftest.mjs`。
- 中途发现并修复的解析器真 bug（自验证抓出）：CRC 表算法用错（单次查表 → 半字节双查表）、uint32 被基类型掩码截断高 16 位、压缩时间戳头运算符优先级错、大端定义消息被忽略。

### 致命修复（功能此前完全不可用）
- **「写入训练日历」批量接口 100% 崩溃**：`db.addPlansBatch` 用了 `this.db.transaction()`，但项目是 `node:sqlite` 的 `DatabaseSync`，**无此方法**（那是 better-sqlite3 的 API）。任何批量写入都返回 `this.db.transaction is not a function`。改用显式 `BEGIN`/`COMMIT`/`ROLLBACK`，并验证中途抛错时已写入行一并回滚、事务状态干净可继续写。
- **训练建议页加载即抛错**：`loadCoach()` 调用了从未定义的 `setCoachView()`，异常被 `catch(e){}` 静默吞掉，导致后续 `loadCal()` 根本不执行（日历数据不加载）。已删除该调用与残留的 `coachCurView`，并把静默 catch 改为 `console.error`。
- **功率曲线 `curIdx20 is not defined`**：`renderPowerCurve` 引用了未定义的 `curIdx20`，估算 FTP 卡片直接抛 ReferenceError。已按同文件 `allIdx20` 的写法补齐定义。

### 正确性修复
- **ICS 转义与折行对称**：解析侧未还原 iCalendar 转义（`,` `;` `\n` 会以字面反斜杠显示）；导出侧未转义，生成的 ICS 对 Apple/Google 日历非法。已补 `icsEscape`/`icsUnescape` 与 RFC 5545 的 75 字节折行 + 解析侧反向展开，往返 5 组用例无损。
- **检查更新会把降级误判为新版本**：旧比较逻辑用「任一段更大」判定，当前 2.6.0、远端 2.5.9 时会提示可更新。改为逐段数值比较（12 组用例通过，含 2.10.0 > 2.9.0 这类数值而非字符串的比较）。
- **日历增删改失败无任何提示**：`calCellClick`/`calAddPlan` 的 catch 完全静默，失败时点了没反应也不知道原因；`calDeletePlan` 更是没有 catch（unhandled rejection）。现统一补 console 日志 + Toast 提示。

### 工具链修复
- **测试包打的是陈旧代码**：`npm run dist` 不会同步源码，`extraResources` 取自 `desktop/build/app` 暂存副本，必须走 `desktop/build.ps1`（第 1 步 robocopy 汇集 `server/` + `www/`）。此前跳过了这步。
- **版本号统一为三段语义化**：此前 `server/VERSION` 用四位累加测试号（2.5.1.x）而 `package.json` 固定 2.5.1，导致界面显示与安装包文件名对不上。现统一为 `X.Y.Z`（当前 2.5.2），`server/VERSION` 为唯一事实来源，跑 `bash scripts/sync-version.sh` 一并同步 manifest / desktop/package.json / cli/package.json / desktop/package-lock.json。

### 验证
- [ ] 功率曲线页正常渲染，估算 FTP 卡片有值，控制台无 `curIdx20` 报错
- [ ] 训练建议页进入不报错，「训练日历」弹窗数据正常加载
- [ ] AI 回复含 ICS 时，点「写入训练日历」成功落库多条，无报错
- [ ] 日历增删改失败时有 Toast 提示
- [ ] 界面版本号显示 v2.5.2，安装包文件名为 2.5.2
- [ ] FIT 工具：拖入真实码表 .fit 文件，概览（点数/时长/功率/心率标签）正确
- [ ] FIT 工具：删除功率/心率后的文件能上传 Strava 且不显示对应曲线
- [ ] FIT 工具：合并/拆分产物能被 Garmin Connect / Wahoo 等第三方正常导入（真机验证）
- [ ] FIT 工具：GPX/TCX 转换结果导入其他平台无异常
- [ ] `node scripts/fit-selftest.mjs` 51/51 通过
- [ ] 出行计划：选目的地后经纬度/简介联动正确，查天气返回 7 天且高亮所选日期
- [ ] 出行计划：查高铁返回车次表（首次查询约 5~10 秒拉车站表，之后走缓存）
- [ ] 教练：运动方式只勾「骑行」时，让 AI 排周计划，课表里不出现跑步等其它运动
- [ ] 教练：勾「骑行+跑步」后，digest 统计包含两类活动，回复可同时覆盖两项
- [ ] 教练：切换语言后运动方式按钮文案同步（骑行 ↔ Cycling）

---

## 2.5.1.3 (2026-10-16)

> 基于 v2.5.0。训练建议页改为默认空白新会话,历史需手动选择。

### 更新点
- **训练建议默认空白新会话**：进入训练建议页不再自动加载全部历史对话,默认空白;需要回顾历史时通过「会话」下拉选择对应会话加载。
- **新会话重置模型覆盖**：点「新会话」同时清空会话级模型覆盖,回退默认配置,避免残留上一会话的选择。

### 验证
- [ ] 训练建议页首次进入为空白(顶部会话标记显示「新会话」)
- [ ] 「会话」下拉选择历史会话后正确加载消息
- [ ] 新会话发消息后正常落库,再次选择可回看

---

## 正式版 v1.2.3 (2026-09-03)

> 在 v1.2.2 基础上，本会话彻底打通 Strava OAuth 全链路 + 图表对齐官方 + 多项体验修复。真机验证通过后升正式版。

### 核心修复（OAuth 授权彻底打通）
- **save_config 误删 token**：无条件删 `strava_tokens.json` → 授权/刷新成功即丢 token。改仅 refresh_token 变更才清；exchange/refresh 先 save 再写 token。
- **并发竞态**：`/api/info` 每秒轮询 refresh 与授权写 token 互相覆盖。用 `RLock` 串行化。
- **scope 空格分隔误判**：Strava 返回 `activity:read_all read`(空格)，原按逗号 split 误判缺权限。改兼容逗号/空格。
- **回调地址**：不再自动跟随公网中转域名；拒绝残缺相对路径；引导显式配置完整内网 URL。
- **凭据回显免重输**：设置页自动回填已存凭据；/api/config 拒绝非绝对 URL 的 redirect_uri。

### 图表对齐官方 Strava
- 时间筛选合并一组 7 选项；粒度 7D/1M日、3M/6M周、YTD/12M月、All年。
- 每日/周/月空桶补全(0值)；Y轴×1.2顶部留白；平滑曲线；0值天不标数值；移动端按钮自适应。

### 验证（真机 NAS 实测）
- [x] OAuth 授权(Apple ID)成功 → conf 存新 refresh_token + athlete_id=121173304
- [x] /api/status `has_token:true`
- [x] 数据同步拉到 1139 条活动，last_sync 更新
- [x] /api/stats 近7天返回 8 个含 0 的每日桶
- [x] 后端 py_compile + 前端 JS 语法
- [x] 图标换官方 Strava 徽标

---

## 正式版 v1.2.2 (2026-09-02)

> 基于 1.2.1.x 测试系列验收后聚合的正式版（升第 3 位）。

### 修复（正式版聚合）
- **假绿状态修复**：token 有效性增加 scope 校验（须含 `activity:read_all`）。read-only token（历史上只读 scope 授权）不再显示"正常"，改为提示"scope 缺 activity:read_all，需重新 OAuth 授权"；同步不再反复 401。
- **OAuth 回调修复**：回调地址兜底不再 `http://localhost/`，改按请求 Host 推导；设置页自动回填完整回调地址便于在 Strava 注册。
- ⚠️ fnpack 升 1.2.4 后拒绝旧四位点号版本（`1.2.1.14` 非法，仅接受 `x.y.z`/`x.y.z-r`）。本正式版用三位 `1.2.2`。

### 验证
- [x] 后端 py_compile + 前端 JS 语法
- [x] scope 校验单测：缓存 read-only / 刷新 read-only / 刷新正确 scope / 缓存有效 4 场景
- [x] fnpack 1.2.4 打包 url + iframe

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
- **📐 响应式卡片布局** — 服务状态三张业务卡片放入响应式网格（宽屏三卡并排、窄屏自动堆叠），对齐 Hugo 管理面板的耐用布局；「立即同步」改为主按钮
- **🔍 周期筛选边界** — `/api/stats` 同时传 `start` + `end` 明确周期边界；「上年度」限定为完整去年（去年 1/1–12/31），不再跨到今年
- **📈 月度面积折线图** — 骑行数据图表改为「每月骑行距离」面积折线图（参考官方 Strava app，纯 SVG 零依赖）：橙色渐变面积 + 折线 + 数据点 + 月/距轴，`/api/stats` 新增 `monthly` 字段
- **⏳ 同步进度提醒** — 「立即同步」时前端轮询 `/api/sync/progress` 实时显示进度（已拉取第 N 页 · M 条 → 写入本地 → 完成），不再静默等待；同步期间 `strava-api.log` 记录每页进度
- **🔐 OAuth 授权窗口体验修复** — ①移动端检测：移动端同窗口跳转授权页，授权完成后自动跳回面板；②桌面端保留独立弹窗并优化关闭；③`/oauth/callback` 成功/失败页加「返回面板」按钮 + `window.opener` 自动跳回，解决移动端回不到原窗口

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
- **前端新界面 ≠ 后端新代码** — index.html 每次从磁盘实时读取，改前端立即生效；但 server/app.js 是进程启动时载入内存的，改后端必须重启进程才生效。若看到新界面 + 旧接口 404，是后端进程没重启。
- **OAuth 回调地址需在 Strava 注册** — 面板「连接 Strava」用的 redirect_uri 需在 Strava API 设置里添加（如 `http://<NAS-IP>:20227/oauth/callback`），否则授权后回调失败。
