# Strava Panel 问题排查 / Troubleshooting

> 详细排障指南。简要版见 [README](./README.md) 的问题排查章节。

---

## 1. 服务不自动启动（桌面打开空白 / 连接被拒绝）

### 现象
应用已安装并在 App Center 里"启用"，但打开桌面图标空白，`ss -tln | grep 20227` 无输出，服务没跑起来。`/var/log/apps/strava.log` 里**只有 `stopped`，从没有 `started`**。

### 根因（关键）
**fnOS 周期性调用 `cmd/main status`，并依赖退出码判断应用是否运行。**
- `status` 返回**非零（1）** = 应用未运行 → fnOS **调用 `start`** 启动服务
- `status` 返回 **0** = 应用"正在运行" → fnOS **从不调用 `start`**

如果 `status()` 的 stopped 分支只 `echo stopped` 而**没有 `return 1`**（函数最后一条是 echo，隐式返回 0），fnOS 误判应用为"运行中"，**永不调 start** → 服务永远不启动 → 桌面打开空白 / 连接被拒绝。

> 参考对比：metacubexd / 9router 的 `status()` 都以 `echo stopped; return 1` 结尾，所以 fnOS 能正常启动它们；而 strava 修复前是 `echo stopped`（返回 0），导致不启动。

### 解决
确保 `cmd/main status()` 的 stopped 分支返回非零：
```bash
status() {
    if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
        echo "running (pid $(cat "${PID_FILE}"))"; return 0
    elif curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
        echo "running (port ${PORT})"; return 0
    else
        echo "stopped"; return 1   # ← 必须 return 1
    fi
}
```
**验证**：`bash /var/apps/strava/cmd/main status; echo $?` → 服务未运行时必须输出非零退出码。

---

## 2. 桌面图标打不开 / 连接拒绝

### 现象
点击 fnOS 桌面图标或手动访问 `http://192.168.31.101:20227/`，显示"拒绝连接"。

### 排查步骤

**① 确认服务是否在监听：**
```bash
ssh yangyu@192.168.31.101
ss -tln | grep 20227
# 有输出 = 服务在跑；无输出 = 服务没起
```

**② 确认应用状态：**
```bash
cat /var/log/apps/strava.log | tail -5
# "running (port 20227)" = App Center 认为已运行
# "stopped" = 应用没启用
```

**③ 若 stopped，在 App Center 里启用/启动应用。**

### 根因
| 原因 | 说明 |
|------|------|
| 应用处于 stopped | fnOS 未启动服务，桌面图标打开时无服务可连 |
| 端口写错 | `app/ui/config` 的 `port` 与 manifest `service_port` 不一致 |
| 手动输错端口 | 正确端口是 **20227**，不是 20217/8081 |

> ⚠️ **端口一致性**：`app/ui/config` 的 `"port"` 必须与 manifest 的 `service_port` 一致，否则桌面图标指向错误端口。

---

## 3. 前端报 `Unexpected token '<'`

### 现象
面板点击「立即同步」或加载时报：`✗ 同步失败 Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

### 根因
前端请求 `/api/sync` 或 `/api/stats` 返回的是 **HTML 错误页**（404），不是 JSON。通常是因为**请求打到了旧版本进程**（没有这些 API 接口）。

常见场景：**旧进程还占着 20227 端口**，新安装的服务因端口冲突没起来，请求落到旧进程。

### 解决
```bash
# 1. 找到并杀掉旧进程
ps aux | grep "app.py" | grep -v grep
kill -9 <旧进程PID>

# 2. 确认端口释放
ss -tln | grep 20227   # 应无输出

# 3. 重启应用（App Center 里停止→启动，或用 cmd/main）
bash /var/apps/strava/cmd/main restart
```

> 💡 **教训**：安装新版本前，先确认没有旧进程占用端口。卸载时 fnOS 会清进程，但手动 SSH 启动的进程不会自动清。

---

## 4. 服务起不来，日志 `Address already in use`

### 现象
`/vol4/@appdata/strava/strava.log` 报 `OSError: [Errno 98] Address already in use`

### 根因
1. **残留进程占用端口**：多次启停后旧进程未清理干净。
2. **TIME_WAIT socket**：频繁重启后端口处于 TIME_WAIT，`ThreadingTCPServer` 默认 `allow_reuse_address=False` 导致绑定失败（端口明明空闲却报占用）。

### 解决
```bash
# 1. 强制杀掉所有 app.py 残留
pkill -9 -f "strava/server/app.py"
pkill -9 -f "python3 app.py"
sleep 1
ss -tln | grep 20227   # 应无输出
# 再启动
bash /var/apps/strava/cmd/main start
```

**若端口空闲却仍报 `Address already in use`**（TIME_WAIT 问题），在 app.py 里启用 SO_REUSEADDR（必须在实例化前设置类属性）：
```python
socketserver.ThreadingTCPServer.allow_reuse_address = True
httpd = socketserver.ThreadingTCPServer(("0.0.0.0", port), Handler)
```

---

## 5. 服务起不来，日志无输出

### 现象
`cmd/main start` 报 `started, but health check timed out`，日志为空。

### 根因
旧版 cmd/main 的 `DATA_DIR` 指向不可写目录（`${APP_DIR}/var` 在 fnOS 1.1.31xx 下可能指向安装目录，不可写），导致 python 启动失败。

### 解决
确保 cmd/main 里 `DATA_DIR` 固定为 `/vol4/@appdata/<App>`（v1.1.0+ 已修复）：
```bash
# cmd/main 里应看到
DATA_DIR="${TRIM_PKGVAR:-/vol4/@appdata/strava}"
```

---

## 6. Strava 401 `activity:read_permission missing`

### 现象
面板能连，但拉取活动报错：`{"resource":"AccessToken","field":"activity:read_permission","code":"missing"}`

### 根因
授权时未勾选「查看活动数据」权限。token 只有 `read` scope，没有 `activity:read_all`。

### 解决
**重新授权**，确保勾选 `activity:read_all`：
```
https://www.strava.com/oauth/authorize?client_id={ClientID}&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read,activity:read_all
```
授权后把 `code=` 值换成新的 refresh_token（见 README 获取凭据章节）。

---

## 7. iframe 版白屏 / 跨域

### 现象
iframe 版（桌面窗口）打开白屏或无法加载 API。

### 根因
fnOS 桌面容器 iframe 跨端口（5666 → 20227）可能受浏览器跨域限制。

### 解决
优先使用 **url 版**（`strava-x.x.x.fpk`，新标签页打开）。若需 iframe，确认后端返回的 `Access-Control-Allow-Origin: *` 生效（app.py 已内置）。

---

## 8. 数据不更新 / 显示旧数据

### 现象
面板显示的数据停留在上次同步时间。

### 根因
SQLite 缓存数据未刷新。`/api/stats` 读缓存（快），不会实时拉 Strava。

### 解决
- 面板点「立即同步」，或
- 手动触发：
```bash
curl http://127.0.0.1:20227/api/sync
```

> 数据保存位置：`/vol4/@appdata/strava/strava.db`

---

## 9. 凭据安全

`strava.conf` / `strava_tokens.json` 权限应设为 **600**（仅属主可读），避免 Client Secret / Refresh Token 泄露：

```bash
chmod 600 /vol4/@appdata/strava/strava.conf /vol4/@appdata/strava/strava_tokens.json
```

---

## 10. OAuth 授权报 redirect_uri_uri_mismatch（回调域名不一致）

### 现象
点「连接 Strava」后，Strava 授权页报错：
```
API::Unauthorized: OAuthException, code: redirect_uri_uri_mismatch
```

### 根因
Strava 校验回调时把 redirect_uri 的**域名字符串**与 API 应用设置里的 **Authorization Callback Domain** 做**精确匹配**，以下三者互不相同：

- `http://localhost:20227/oauth/callback`
- `http://127.0.0.1:20227/oauth/callback`
- `http://192.168.31.101:20227/oauth/callback`（NAS 内网 IP）

面板会按你**实际访问地址**自动推导回调（Host 头），所以「注册了 localhost 却用 127.0.0.1 打开面板」或「桌面版用 localhost、NAS 版用 IP」都会 mismatch。

### 解决
1. **统一用 `http://localhost:20227` 访问面板**（桌面版/CLI 默认即是），并在 Strava API 设置里把 Callback Domain 填 `localhost`。
2. fnOS 局域网访问与桌面版都要用的话：Strava 一个应用只能注册一个域名 —— 要么切换用途时改注册域名，要么建两个 API 应用（两个 client_id）。
3. 若坚持用 IP 访问，把设置页「回调地址」显式填成与注册域名完全一致的 URL 并保存（显式值优先于自动推导）。

> 校验方法：授权前看面板设置页回填的回调地址，或 `curl -s -H "$AUTH" http://localhost:20227/api/oauth/start` 返回的 `redirect_uri` 字段，与 Strava 注册域名逐字符比对。

---

## 日志位置

| 形态 | 路径 |
|------|------|
| fnOS 应用运行日志 | `/vol4/@appdata/strava/strava.log` |
| fnOS App Center 生命周期 | `/var/log/apps/strava.log` |
| Docker | `docker logs strava-panel`（数据卷 `/data/logs/`） |
| 桌面版 / CLI | Windows `%APPDATA%\StravaPanel\logs\`；macOS `~/Library/Application Support/StravaPanel/logs/`；Linux `~/.strava-panel/data/logs/` |
