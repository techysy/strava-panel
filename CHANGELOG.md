# CHANGELOG / 更新日志

---

## [Unreleased]

---

## v2.2.3 (2026-10-15)

> 增强:**功率曲线**、**教练页日历弹窗**、**消息右键导出**、**菜单精简**。

- ⚡ **功率曲线增强**: 时间范围选择器(近7天/1月/3月/6月/本年度/12月/所有)；SVG 面积填充(8%透明度)；统计卡横向一行排列；对比开关叠加全部历史曲线。
- 🗂️ **训练日历改为弹窗**: 日历从教练页内嵌改为右上角「训练日历」按钮弹窗，不再和对话抢位置；`switchSession`/`newCoachSession` 切换后重载日历。
- 💬 **消息气泡还原**: 去掉 max-height/overflow 滚动条，内容完整展开不裁切。
- 📅 **日历计划保持**: `calCellClick` 等 API 返回再更新本地状态，计划不再丢失。
- 📤 **消息右键导出**: 右键菜单支持复制内容 / 导出文本(.txt) / 导出图片(.png)。
- 📋 **菜单精简**: 去掉导出项，去掉子分组标题，工作区扁平 4 项(立即同步/全量重同步/刷新状态/检查更新)。
- 🎨 **发送按钮配色**: surface 背景 + 橙色细边框，与发送框一致，不再刺眼。

---

## v2.2.2 (2026-10-15)

> 功能:**功率曲线**、**应用内检查更新**、**菜单工作区分组**。

- ⚡ **功率曲线 tab**: 新增「功率曲线」页签，对 17 个时长档位(5s→4h)取 MAX(average_watts) 绘制最佳功率-时长曲线；SVG 双对数功率曲线 + FTP 估算虚线(20min×0.95) + 5 张统计卡(估算FTP/5s/1min/5min/20min)；「对比上期」开关叠加近6月曲线。
- 🔄 **应用内检查更新**: 菜单工作区新增「检查更新」入口；应用内模态框状态驱动(检查中→已是最新/发现新版本→下载进度→错误重试)；桌面版优先走 electron-updater 桥，Web 版直调 GitHub Releases API；平台自动匹配安装包。
- 📋 **菜单工作区分组**: 工作区从平铺 7 项拆分为 3 个子分组(同步/导出/系统)，每子组有小标题分隔，结构更清晰。

---

## v2.2.1 (2026-10-15)

> 修复:**桌面端安装/关闭失败**、**资产平台别名命名**、**CI 优化**。

- 🔧 **修复桌面端安装/关闭失败**:asar 打包导致 `ELECTRON_RUN_AS_NODE=1` 子进程路径解析异常(服务端起不来→前端显示原生兜底页);改 `asar: false`(对齐 CreditDaddy),修复窗口关闭/退出逻辑(win 存在性检查 + killProcTree 超时兜底 + 移除 Win11 已删除的 wmic 兜底)。
- 🏷️ **资产命名加平台别名**:fpk `strava-fnos-{ver}.fpk` / `strava-fnos-{ver}-iframe.fpk`;Win `StravaPanel-win-Setup-{ver}.exe` / `StravaPanel-win-Portable-{ver}.exe`;Mac `StravaPanel-mac-Setup-{ver}-{arch}.dmg`(zip 跟随)。
- ⚙️ **CI 优化**:所有 workflow 加 `concurrency` 组防重复触发;CHANGELOG 提取改用独立 Python 脚本 `scripts/extract-changelog.py`(替代 awk,避免转义/编码问题);Release Notes 表格同步新命名。

---

## v2.2.0 (2026-10-15)

> 功能增强:**自动同步**、**模型卡片库**、**踏频采集**、**表格排序**、**时间感知训练计划**、**会话管理**。

- 🧹 **仪表板去重**:服务状态面板移除「立即同步/全量重同步/创建 token」三个按钮(设置页已有),保留最后同步状态行。
- ⏱️ **自动同步**:设置→数据新增开关 + 周期(6/12/24/48/72h);服务端 60s 心跳,距上次同步超期自动增量同步,与手动同步互斥(syncSerial 队列)。
- 🃏 **模型卡片库**:设置→模型改为卡片管理(点选设默认/×移除/网关多选添加/手动添加);训练建议页不再全量拉取网关,只列库内模型。
- 🏷️ **模型去前缀**:显示统一剥供应商前缀(`cbai/gpt-6-x` → `gpt-6-x`),真实 id 仍用于 API 调用(前后端规则对齐)。
- 🐛 **修复历史会话蒸发**:旧版「清空记忆」整删 `coach_sessions` 表致会话从列表消失;现只删消息保留会话壳,构造器自动回填孤儿会话(幂等)。
- 💬 **教练消息卡片**:头像/角色/时间头 + 完整 markdown 渲染(标题/表格/引用/分隔线/围栏代码/斜体/链接,先转义保 XSS 安全);思考气泡三点动画(reduced-motion 降级),回复原地替换不整屏重绘。
- 🚴 **踏频采集与展示**:`activities` 表新增 `average_cadence`/`max_cadence` 列(老库自动迁移);最近骑行表新增踏频列;教练训练摘要注入逐段踏频(均踏频/CAD)。主页不显示踏频统计卡(按用户要求)。
- 🔀 **最近骑行排序**:默认日期降序(最近在前);点击 距离/时长/均速/爬升/心率/功率/踏频 列头排序,空值沉底;列极值青色高亮 + 「历史最高」悬浮提示,一眼看历史最大值。
- 📅 **时间感知训练计划**:教练系统提示注入当前日期/星期/剩余天数,规则要求周/月/赛前计划以今天为唯一起点、绝不安排已过去日期;工具栏「生成计划」弹层含本周/月度/赛前(日期选择器)三种。
- 🗂️ **会话管理入设置页**:新增「会话」子页签,每会话可重命名 + 选辅助模型(留空用默认);`coach_sessions` 新增 `model` 列(老库自动迁移);教练页移除模型弹层,发送时后端按 会话模型 > 默认配置 解析。

---

## v2.1.0 (2026-10-15)

> 大版本:**现代 UI 设计语言**(对齐 Strava 官方 + CreditDaddy/imgmark)、**AI 训练建议教练**(OpenAI 兼容网关 + 多会话 + 模型拉取)、**心率/功率采集**、**增量/全量双模式同步**。

- 🎨 **UI 现代化重设计**:告别复古风——基准 14px/行高 1.5、16px 大圆角卡片 + 双层阴影体系、页签选中态改白底浮起卡片(Linear/Raycast 式)、主按钮品牌橙彩色投影、输入框 focus 橙色 ring、表头小字大写 + 字距、数值列右对齐、行 hover 高亮。
- ✒️ **图标去 emoji 化**:页签/菜单/按钮/面板标题共 40 处 emoji 全部替换为内置线性 SVG sprite(20 个 symbol,stroke 取 `currentColor` 随主题自动适配,选中态图标染品牌橙);统计卡新增语义图标徽章;i18n 字典同步剥离表情(保留 ✓/✗/⚠ 语义标记),中英文文案更干净。仍为单文件零依赖。
- 📊 **图表重绘为现代柱状图**:顶部圆角柱 + 品牌渐变 + 零值底座 + hover tooltip(高亮当前列,显示日期/距离/次数);修复旧图 viewBox 拉伸导致的字体/线条膨胀,改为按容器实测宽度 1:1 渲染 + resize 防抖重绘。
- 🎯 **对齐 Strava 官方设计语言**:数据可视化改官方青 `#00b3a4`(暗色 `#2dd4bf`)实心柱,橙色只留给品牌与「今天」标记;日视图 X 轴星期单字(一二三四五六日 / Su–Sa)+ 今天加粗橙色三角指针;统计卡去图标徽章贴近官方大数字排版;新增 `--viz` 设计 token。
- 📈 **统计卡环比对比**:4 张卡片新增「±x% 较上期」涨跌角标(涨绿/跌红/持平/新增),对齐官方 vs last week 风格;对比区间为等长前移(YTD 对齐去年同期,「所有」无对比),双区间并行请求,零后端改动。
- 🧭 **头部菜单对齐 CreditDaddy**:菜单按钮改真齿轮;分区顺序调整为 外观 → 语言 → 工作区 → 关于(语言独立分区);主题三态分段控件加显示器/日/月小图标,选中态图标染品牌橙。
- 🔀 **图表对比曲线**:面板标题新增「对比上期」开关(状态持久化),开启后叠加上一周期同粒度灰色虚线,Y 轴取两序列最大值,tooltip 同时显示本期/上期/涨跌幅,标题旁图例。
- ❤️ **心率/功率采集与展示**:`activities` 表新增 4 列(平均/最大心率、平均功率、千卡),老库启动自动 `ALTER` 迁移无缝升级;统计卡新增「平均心率」「平均功率」两张(区间内无数据自动隐藏);最近骑行表新增心率/功率两列。
- 🔄 **增量/全量双模式同步**:`/api/sync?mode=incremental|full`——增量用 `after=` 最新活动水位只拉新活动(触及已知区间即停,不再每次全量翻页);全量重拉全部历史,用于回填老数据缺失的心率/功率字段。UI 默认「立即同步」为增量,菜单/仪表盘/数据面板新增「全量重同步」入口(带确认)。
- 🎛️ **统计卡即图表切换器**:点击「骑行次数/总距离/总时长/总爬升」任一张卡,图表随之切换对应指标曲线(含对比虚线/tooltip/Y 轴单位联动);选中态青色描边 + 复选标记,状态持久化。心率/功率卡补齐「较上期」环比角标。
- 🫧 **头部交互升级**:状态徽章去 ✓ 改呼吸灯圆点(红/黄/绿随状态色,reduced-motion 自动降级);新增日/夜快捷切换按钮(图标实时反映当前主题);聚合菜单按钮改四宫格图标(对齐 CreditDaddy);统计卡顺序调整——总距离第一位(默认选中)。
- 🧭 **仪表板/设置页打磨**:三组服务状态卡标题加呼吸灯摘要徽章(正常/需关注/就绪/空);日志源选择改分段控件、日志区随视口拉伸;Client Secret 默认打码 + 眼睛显隐;新增「Strava 已连接 · Athlete ID」状态行(呼吸点);`/api/config` 补返回 `athlete_id`。
- 📐 **三页签视口等高**:骑行数据/最近骑行/仪表板的面板底部对齐视口(`100vh - 212px`),图表按容器实测高度渲染(保底 300px)且随窗口缩放自适应,切换页签不再出现高度跳变与大片空白。
- 🧱 **仪表板服务状态区收紧**:三组状态卡改按内容自然收高(`align-items:start`,不再强行等高留空),组卡内边距/标题间距/行距全面压缩;DB 路径单行省略 + 悬浮完整路径;服务状态面板约 500px→358px,信息密度对齐官方。
- ✨ **AI 训练建议教练**(新页签,位于最近骑行后):聊天式 UI,系统提示自动注入本地训练摘要(近 7/28/90 天统计 + 近 8 周趋势 + 最近 15 次骑行含心率/功率);对话记忆存 SQLite `coach_memory` 表(自动建表,重启不丢);一键「生成本周训练建议」「清空记忆」;轻量 markdown 渲染(先转义,XSS 安全)。
- 🧠 **模型设置**(设置页第 3 子页):接入 OpenAI 兼容 API(base URL / Key / 模型名),适配 Ollama / LM Studio / vLLM / One-API 等本地网关与云端;密钥存 `strava.conf`(权限 600)、打码 + 眼睛显隐 + 留空保持原值;「测试连接」一键验证。
- 🧹 **清除全部残留 ✓/✗ 打勾**:状态徽章改静态圆点(与呼吸灯同视觉语言),setup/sync/token/copy 等 14 处提示语去符号,中英双语。
- 🐛 **修复教练训练摘要序列化 bug**:REAL 列(`PyFloat` 包装)在拼摘要文本时未解包,导致 LLM 看到 `[object Object]`/`NaN` 而误判"数据缺失";新增 `num()` 解包器,近况/周趋势/骑行明细全部输出真实数值(mock 网关回显系统提示实测)。
- 🗂️ **教练会话管理**(控制上下文):新增 `coach_sessions` 表 + `session_id` 列(老库自动迁移);工具栏「会话」下拉切换历史会话(标题自动取首条消息,含条数徽标)、「新会话」开新上下文;聊天记忆按会话严格隔离;清空记忆改为只清当前会话。
- 🎛️ **网关模型列表拉取**(对齐 imgmark「平台与模型」):`GET /api/coach/models` 从 OpenAI 兼容网关拉取模型列表;聊天页「选择模型」弹层按供应商分组 + 上下文窗口 k 徽标 + 当前高亮,支持会话级模型覆盖;设置页模型名旁一键刷新拉取、点选回填。
- 🧨 **原生弹窗清零**:自研应用内确认模态 `appConfirm()`(遮罩 + 动画 + 危险操作红钮,dialog 语义),替换「清空记忆」「全量重同步」两处原生 `confirm()`。
- 🧹 **db.js 编码修复**:`pyJsonStr` 正则字符类中的原始控制字节(重写时的生成事故,致文件被 git/grep 当二进制)改为转义文本。
- 📐 **首屏紧凑化**:全局留白压缩约 20%,图表高度固定 188px,默认 1280×860 桌面窗口一屏装下页签/范围条/统计卡/完整图表。
- 📏 **图表加高 + 品牌区间距**:图表高度 188→300px 填满面板;品牌区与页签导航间距 12→26px,层次更分明。

---

## v2.0.0 (2026-10-13)

- 🔄 **后端重构为 Node.js**:零依赖 ESM(Node ≥22.13,node:sqlite),全渠道(Python 运行时依赖彻底移除:Docker node:24-alpine、桌面复用 Electron 内嵌 Node、CLI 复用宿主 Node、fnOS 依赖 nodejs_v24 应用);既有 strava.db / strava.conf 数据全兼容。
- 🎨 **全新 UI 重构**(对齐 CreditDaddy):顶部页签导航(骑行数据首页 / 最近骑行 / 仪表盘 / 设置)、三态主题切换(跟随系统/亮/暗)、聚合「更多」菜单、全站统一 design tokens(CSS 变量),品牌徽标统一为官方 Strava logomark(header / favicon / 桌面 / 托盘 / fnOS 图标同源)。
- 📦 **fnOS fpk 构建流程加固**:保持网页版(`strava-<ver>.fpk`)/ 窗口版(`strava-<ver>-iframe.fpk`)双版本不变,CI 改为在构建副本上注入 manifest / ui config(不再污染 tracked 文件),构建产物随附 `build.json` 与 SHA256SUMS-fpk.txt 一起发布;本地 `scripts/build.sh` 同样改为副本构建,并新增 `--arch` / `--variant` 参数(x86/url 为默认,产物命名向后兼容)。
- 🍎 **桌面端 macOS 支持**:新增 dmg / zip(x64 + arm64)打包,接入 electron-updater(publish → github),Windows(NSIS / Portable)与 macOS 均支持应用内自动更新;Electron 升级 ^37,服务端直接复用 Electron 内嵌 Node 运行。
- 🏷️ **build.json 构建身份**:打包时由 `scripts/gen-build-info.py --channel <fpk|desktop|...>` 生成并随包分发,`/api/status.build` 透出构建元数据(渠道/版本/commit/时间),「同版本新构建」可判定。
- 🚦 **release-check 发版门禁**:新增 `scripts/release-check.sh` + `release-check.yml` workflow(手动触发 / PR 打 `release` 标签),发版前一键体检。
- ✅ **版本四处一致性断言**:`test.yml` 新增 `version-consistency` job,断言 `server/VERSION` == `fnos-packaging/manifest(version=)` == `desktop/package.json` == `cli/package.json`,每次 push/PR 运行。
- 📋 **Release 自动建档**:tag 发布前先 `gh release create`(若不存在),Release Notes 自动从 CHANGELOG.md 提取对应版本段落并附安装渠道表;各矩阵构建 `gh release upload --clobber` 汇入同一 Release。

---

## v1.3.1 (2026-09-03)

### 🗂️ 目录重构 — fnOS 打包独立成包(对齐 10Router 布局)

仓库更名 `strava-panel`(去掉 fnos 后缀),核心与平台打包彻底解耦:

- 📁 **新布局**:核心源码 `server/` + `www/` 提到仓库根;fnOS 专属(manifest/cmd/config/app/ui/ICON)收进 `fnos-packaging/`,`desktop/`、`cli/`、Docker 平级。与 10Router 的 `fnos-packaging/` 布局一致。
- 🤖 **自动打包**:新增 `.github/workflows/build-fpk.yml` —— 推 `v*` tag 即自动构建 url + iframe 两个 fpk 变体并挂到 GitHub Release(拷 server+www → 下载 fnpack → fnpack build),本地 `scripts/build.sh` 同步适配新布局。
- 🔗 **统一 localhost**:桌面壳/CLI 面板地址统一 `http://localhost:20227`(Strava 的 Callback Domain 校验是**域名字符串精确匹配**,`127.0.0.1`/`localhost`/NAS IP 互不相同,混用必 mismatch)。服务端默认绑定改为 `127.0.0.1`(桌面/CLI 纯本机访问,免 Windows 防火墙弹窗);fnOS `cmd/main` 与 Dockerfile 显式传 `SP_HOST=0.0.0.0` 保留局域网访问。`/api/doc` 的 BASE 示例按实际请求 Host 动态生成;TROUBLESHOOTING 新增「redirect_uri_uri_mismatch」排障条目。
- ✅ **实测通过**:服务端 Windows 冒烟(旧/新环境变量)、CLI 全流程 start→status→stop、Docker 构建 + 容器内健康检查 + 宿主机端口映射、默认回环绑定/显式 0.0.0.0 绑定、localhost 链路、新布局下 cli build + Docker build + 服务端冒烟。

---

## v1.3.0 (2026-09-03)

### 🌍 全平台化 — 不再局限于 fnOS

核心服务端本就是纯 Python 标准库零依赖,本次把打包层解耦,一套代码多端部署:

- 🧩 **服务端平台解耦**:新增 `SP_PORT` / `SP_HOST` / `SP_DATA_DIR` 环境变量(优先级高于 fnOS 的 `PORT`/`DATA_DIR`,兼容老部署)。fnOS fpk / Docker / 桌面 / CLI 四形态共用同一服务端。
- 🐳 **Docker 形态**:新增 `Dockerfile` + `docker-compose.yml` + `.dockerignore`。基于 `python:3.12-alpine`(~60MB),零 pip 依赖,非 root 运行,HEALTHCHECK 内建,数据持久化 `/data` 卷。
- 🖥️ **桌面托盘版(Electron)**:新增 `desktop/` — 托盘启停/重启/开机自启、点关闭缩托盘、单实例锁、端口占用自动识别外部服务、外链走系统浏览器(Strava 授权页)。`build.ps1` 一条龙打包 NSIS 安装包 + 便携版;Embeddable Python 免装环境(零依赖免 pip,`._pth` 已追加 `..\app\server` 修脚本目录 sys.path)。
- ⌨️ **npm CLI 形态**:新增 `cli/` — 发布为 `@techysy/strava-panel`(`sp` 命令):`start/stop/restart/status/open/autostart`。Windows 托盘用 PowerShell NotifyIcon(零二进制依赖,杀软友好),macOS/Linux 用 systray2(惰性安装);系统 Python 3.8+ 直接跑,无 venv/pip 环节。
- 🎨 **图标升级为矢量绘制**:`scripts/generate-icons.py` 重写 — 按 Strava 官方 SVG 徽标路径(主峰 + 50% 透明次峰)矢量绘制橙色圆角徽标,任意分辨率无损;一次产出 fnOS(64/128/256)、desktop(png 512 + 多尺寸 ico)、cli 托盘图标。
- 🔗 **OAuth 回调统一 localhost**:桌面壳/CLI 面板地址统一 `http://localhost:20227`(Strava 的 Callback Domain 校验是**域名字符串精确匹配**,`127.0.0.1`/`localhost`/NAS IP 互不相同,混用必 mismatch)。服务端默认绑定改为 `127.0.0.1`(桌面/CLI 纯本机访问,免 Windows 防火墙弹窗);fnOS `cmd/main` 与 Dockerfile 显式传 `SP_HOST=0.0.0.0` 保留局域网访问。`/api/doc` 的 BASE 示例改为按实际请求 Host 动态生成;TROUBLESHOOTING 新增「redirect_uri_uri_mismatch」排障条目。
- ✅ **实测通过**:服务端 Windows 冒烟(旧/新环境变量)、CLI 全流程 start→status→stop、Docker 构建 + 容器内健康检查 + 宿主机端口映射、默认回环绑定/显式 0.0.0.0 绑定、localhost 链路。

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
