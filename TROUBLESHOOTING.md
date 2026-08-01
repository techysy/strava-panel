# Strava Panel 问题排查 / Troubleshooting

> 详细排障指南。简要版见 [README](./README.md) 的问题排查章节。

---

## 1. 桌面图标打不开 / 连接拒绝

### 现象
点击 fnOS 桌面图标或手动访问 `http://192.168.31.101:20127/`，显示"拒绝连接"。

### 排查步骤

**① 确认服务是否在监听：**
```bash
ssh yangyu@192.168.31.101
ss -tln | grep 20127
# 有输出 = 服务在跑；无输出 = 服务没起
```

**② 确认应用状态：**
```bash
cat /var/log/apps/strava.log | tail -5
# "running (port 20127)" = App Center 认为已运行
# "stopped" = 应用没启用
```

**③ 若 stopped，在 App Center 里启用/启动应用。**

### 根因
| 原因 | 说明 |
|------|------|
| 应用处于 stopped | fnOS 未启动服务，桌面图标打开时无服务可连 |
| 端口写错 | `app/ui/config` 的 `port` 与 manifest `service_port` 不一致 |
| 手动输错端口 | 正确端口是 **20127**，不是 20217/8081 |

> ⚠️ **端口一致性**：`app/ui/config` 的 `"port"` 必须与 manifest 的 `service_port` 一致，否则桌面图标指向错误端口。

---

## 2. 前端报 `Unexpected token '<'`

### 现象
面板点击「立即同步」或加载时报：`✗ 同步失败 Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

### 根因
前端请求 `/api/sync` 或 `/api/stats` 返回的是 **HTML 错误页**（404），不是 JSON。通常是因为**请求打到了旧版本进程**（没有这些 API 接口）。

常见场景：**旧进程还占着 20127 端口**，新安装的服务因端口冲突没起来，请求落到旧进程。

### 解决
```bash
# 1. 找到并杀掉旧进程
ps aux | grep "app.py" | grep -v grep
kill -9 <旧进程PID>

# 2. 确认端口释放
ss -tln | grep 20127   # 应无输出

# 3. 重启应用（App Center 里停止→启动，或用 cmd/main）
bash /var/apps/strava/cmd/main restart
```

> 💡 **教训**：安装新版本前，先确认没有旧进程占用端口。卸载时 fnOS 会清进程，但手动 SSH 启动的进程不会自动清。

---

## 3. 服务起不来，日志 `Address already in use`

### 现象
`/vol4/@appdata/strava/strava.log` 报 `OSError: [Errno 98] Address already in use`

### 根因
端口被残留进程占用（多次启停后旧进程未清理干净）。

### 解决
```bash
# 强制杀掉所有 app.py 残留
pkill -9 -f "strava/server/app.py"
pkill -9 -f "python3 app.py"
sleep 1
ss -tln | grep 20127   # 应无输出
# 再启动
bash /var/apps/strava/cmd/main start
```

---

## 4. 服务起不来，日志无输出

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

## 5. Strava 401 `activity:read_permission missing`

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

## 6. iframe 版白屏 / 跨域

### 现象
iframe 版（桌面窗口）打开白屏或无法加载 API。

### 根因
fnOS 桌面容器 iframe 跨端口（5666 → 20127）可能受浏览器跨域限制。

### 解决
优先使用 **url 版**（`strava-x.x.x.fpk`，新标签页打开）。若需 iframe，确认后端返回的 `Access-Control-Allow-Origin: *` 生效（app.py 已内置）。

---

## 7. 数据不更新 / 显示旧数据

### 现象
面板显示的数据停留在上次同步时间。

### 根因
SQLite 缓存数据未刷新。`/api/stats` 读缓存（快），不会实时拉 Strava。

### 解决
- 面板点「立即同步」，或
- 手动触发：
```bash
curl http://127.0.0.1:20127/api/sync
```

> 数据保存位置：`/vol4/@appdata/strava/strava.db`

---

## 8. 凭据安全

`strava.conf` / `strava_tokens.json` 权限应设为 **600**（仅属主可读），避免 Client Secret / Refresh Token 泄露：

```bash
chmod 600 /vol4/@appdata/strava/strava.conf /vol4/@appdata/strava/strava_tokens.json
```

---

## 日志位置

| 日志 | 路径 |
|------|------|
| 应用运行日志 | `/vol4/@appdata/strava/strava.log` |
| App Center 生命周期 | `/var/log/apps/strava.log` |
