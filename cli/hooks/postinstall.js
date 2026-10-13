#!/usr/bin/env node

// postinstall:只做轻量检查与提示,绝不阻塞安装(见 package.json comment_postinstall)。
// Strava Panel 服务端是纯 Node.js ESM(零依赖);`sp start` 用安装时的同一个 node 运行。
const { nodeVersionOk, MIN_NODE_VERSION, HOME_DIR } = require("../src/server");
const fs = require("fs");
const path = require("path");

try {
  if (nodeVersionOk()) {
    console.log(`[strava-panel] Node.js ${process.version} 满足要求,可直接 sp start 启动`);
  } else {
    console.warn(`[strava-panel] 需要 Node.js >= ${MIN_NODE_VERSION.join(".")}(当前 ${process.version}),请先升级 Node.js(https://nodejs.org)`);
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
