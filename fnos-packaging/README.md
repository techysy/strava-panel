# fnOS 打包工程 / fnOS Packaging

本目录是 fnOS(飞牛)应用打包工程,与 10Router 的 `fnos-packaging/` 布局一致。

## 布局 / Layout

```
fnos-packaging/
├── manifest          # fnOS 应用清单(版本号由 scripts/build.sh / CI 从 server/VERSION 同步)
├── cmd/              # 生命周期脚本(install/uninstall/upgrade/main 启停)
├── config/           # privilege / resource(data-share)
├── app/
│   ├── ui/           # 桌面图标与入口(config + images)
│   ├── server/       # ⚠️ 构建时从仓库根 server/ 拷入,不入库
│   └── www/          # ⚠️ 构建时从仓库根 www/ 拷入,不入库
├── ICON.PNG / ICON_256.PNG
```

## 构建 / Build

```bash
# 本地(在 fnOS 或装有 fnpack 的 Linux 上,仓库根执行)
bash scripts/build.sh            # url + iframe 两个变体,产物在仓库根

# CI(GitHub Actions)
# 推 tag v* 或手动触发 .github/workflows/build-fpk.yml,fpk 自动挂到 Release
```

核心服务端(server/ + www/)是零依赖纯 Python,本目录之外的所有平台(Docker/桌面/CLI)直接使用仓库根源码,不经本目录。
