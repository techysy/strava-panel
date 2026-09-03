#!/usr/bin/env node

// postinstall:只做轻量检查与提示,绝不阻塞安装(见 package.json comment_postinstall)。
// Strava Panel 是纯 Python 标准库服务,无依赖安装环节;首次 `sp start` 只需系统 Python 3.8+。
const { detectPython, HOME_DIR } = require("../src/server");
const fs = require("fs");
const path = require("path");

try {
  const py = detectPython();
  if (py) {
    console.log(`[strava-panel] 检测到 Python ${py.version},可直接 sp start 启动`);
  } else {
    console.warn("[strava-panel] 未检测到 Python 3.8+,请先安装 Python(https://www.python.org/downloads/)后 sp start");
  }

  // macOS/Linux:惰性安装托盘依赖 systray2(Windows 用 PowerShell 托盘,无需)
  if (process.platform === "darwin" || (process.platform === "linux" && process.env.DISPLAY)) {
    const nmDir = path.join(HOME_DIR, "runtime", "node_modules");
    fs.mkdirSync(nmDir, { recursive: true });
    const { spawnSync } = require("child_process");
    const r = spawnSync("npm", ["install", "--prefix", nmDir, "systray2", "--no-audit", "--no-fund", "--loglevel", "error"], {
      stdio: "ignore", timeout: 120000
    });
    console.log(r.status === 0
      ? "[strava-panel] 托盘依赖 systray2 就绪"
      : "[strava-panel] systray2 暂未安装(不影响服务,仅影响 mac/Linux 托盘图标)");
  }
} catch (e) {
  console.warn(`[strava-panel] postinstall 跳过: ${e.message}`);
}

process.exit(0);
