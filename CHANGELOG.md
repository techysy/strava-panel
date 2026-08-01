# CHANGELOG / 更新日志

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
