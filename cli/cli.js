#!/usr/bin/env node
/**
 * Strava Panel CLI (@techysy/strava-panel)
 *
 * 用法:
 *   sp                        启动服务并进入托盘管理(默认)
 *   sp start                  后台启动服务(detached)
 *   sp stop                   停止服务
 *   sp restart                重启服务
 *   sp status                 查看服务状态
 *   sp open                   在浏览器打开面板
 *   sp autostart on|off|status  开机自启(托盘方式)
 *   sp --help / --version
 *
 * 环境变量: SP_PORT(默认20227) SP_DATA_DIR SP_PYTHON_CMD
 */
const fs = require("fs");
const path = require("path");
const {
  PORT, BASE_URL, dataDir, detectPython,
  isHealthy, startServer, stopServer, getStatus, openBrowser,
} = require("./src/server");
const { initTray, killTray, updateItem, MENU_INDEX, isTraySupported } = require("./src/tray/tray");
const autostart = require("./src/tray/autostart");

const VERSION = require("./package.json").version;
const HOME_DIR = require("./src/server").HOME_DIR;
const TRAY_PID_FILE = path.join(HOME_DIR, "tray.pid");
const QUIT_FLAG_FILE = path.join(HOME_DIR, "tray.quit");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function alivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 读取仍存活的后台托盘 pid(无则 0) */
function readTrayPid() {
  try {
    const pid = parseInt(fs.readFileSync(TRAY_PID_FILE, "utf8").trim(), 10);
    return alivePid(pid) ? pid : 0;
  } catch { return 0; }
}

async function trayMode() {
  // `sp` 默认:托盘拉起为 detached 后台进程,关闭终端/控制台不影响;--tray 为后台 worker 入口
  if (!process.argv.includes("--tray")) {
    const existing = readTrayPid();
    if (existing) {
      openBrowser();
      console.log(`[sp] 托盘已在运行 (PID ${existing}),已为你打开 ${BASE_URL}`);
      return;
    }
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [__filename, "--tray"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    // 最多等 10s 让 worker 写入它自己的 tray.pid
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const pid = readTrayPid();
      if (pid && pid !== process.pid) {
        openBrowser();
        console.log(`[sp] 托盘已在后台启动 (PID ${pid}),浏览器将自动打开`);
        console.log(`[sp] sp status 查看状态 | sp stop 停止服务 | sp quit 退出托盘并停止服务`);
        return;
      }
    }
    console.error("[sp] 托盘启动失败,可前台运行排查: sp --tray");
    process.exit(1);
  }

  // ── 后台 worker(--tray)──
  const running = readTrayPid();
  if (running) {
    console.log(`[sp] 托盘已在运行 (PID ${running}),本实例退出`);
    return;
  }
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(TRAY_PID_FILE, String(process.pid));
  console.log(`[sp] Strava Panel v${VERSION} — 启动中...`);

  const status = await getStatus();
  if (!status.healthy) {
    try {
      await startServer();
    } catch (e) {
      console.error(`[sp] ${e.message}`);
      if (!isTraySupported()) process.exit(1);
      // 托盘平台仍保持图标,便于用户打开数据目录排查
    }
  } else {
    console.log(`[sp] 服务已在运行: ${BASE_URL}`);
  }

  const tray = initTray({
    port: PORT,
    onOpen: () => openBrowser(),
    onRestart: async () => {
      await stopServer({ log: () => { } });
      await new Promise(r => setTimeout(r, 800));
      startServer()
        .then(() => console.log(`[sp] 已重启 ${BASE_URL}`))
        .catch(e => console.error(`[sp] 重启失败: ${e.message}`));
    },
    onStop: async () => {
      const r = await stopServer();
      console.log(`[sp] ${r.stopped ? "服务已停止" : r.reason}`);
    },
    onQuit: async () => {
      await stopServer({ log: () => { } });
    },
  });
  if (!tray) {
    console.log("[sp] 当前环境不支持托盘,服务将在后台持续运行(sp stop 可停止)");
    keepForeground();
    return;
  }

  // 每 5 秒刷新托盘状态行
  setInterval(async () => {
    const ok = await isHealthy();
    updateItem(MENU_INDEX.STATUS,
      ok ? `Strava Panel · 运行中 :${PORT}` : "Strava Panel · 未运行", false);
  }, 5000);

  // 优雅退出:sp quit 写入退出标记,worker 轮询到后停服务并收托盘
  const gracefulShutdown = async () => {
    try { await stopServer({ log: () => { } }); } catch { }
    killTray();
    try { fs.unlinkSync(TRAY_PID_FILE); } catch { }
    setTimeout(() => process.exit(0), 500);
  };
  const quitWatcher = setInterval(() => {
    try {
      if (fs.existsSync(QUIT_FLAG_FILE)) {
        fs.unlinkSync(QUIT_FLAG_FILE);
        gracefulShutdown();
      }
    } catch { }
  }, 1500);

  const cleanup = async () => {
    try { fs.unlinkSync(TRAY_PID_FILE); } catch { }
  };
  process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
  process.on("exit", () => { try { fs.unlinkSync(TRAY_PID_FILE); } catch { } });
  console.log(`[sp] 托盘已就绪(后台常驻,关闭终端不影响),浏览器访问 ${BASE_URL}`);
}

/** 无托盘环境下保持进程存活(仅轮询) */
function keepForeground() {
  setInterval(async () => {
    const ok = await isHealthy();
    console.log(`[sp] ${new Date().toLocaleTimeString()} ${ok ? "运行中" : "未响应"}`);
  }, 30000);
  process.on("SIGINT", () => process.exit(0));
}

function printHelp() {
  console.log(`
Strava Panel CLI v${VERSION}

用法:
  sp                        后台启动服务与托盘(关闭终端不影响)
  sp start                  后台启动服务,不进托盘
  sp stop                   停止服务(托盘保留,可从托盘重新启动)
  sp restart                重启服务
  sp quit                   退出托盘并停止服务
  sp status                 查看服务状态
  sp open                   浏览器打开 Strava Panel
  sp autostart on|off|status  开机自启管理
  sp --help                 本帮助

环境变量:
  SP_PORT=20227             服务端口
  SP_DATA_DIR=...           数据目录(默认 %APPDATA%\\StravaPanel)
  SP_PYTHON_CMD="py -3.11"  指定 Python 命令

文档: https://github.com/techysy/strava-panel`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.find(a => !a.startsWith("--"));

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h") || cmd === "help") {
    printHelp();
    return;
  }

  switch (cmd) {
    case undefined:
    case "tray":
      await trayMode();
      return;
    case "start": {
      try {
        const r = await startServer();
        console.log(r.already
          ? `[sp] 服务已在运行: ${r.url}`
          : `[sp] 服务已启动: ${r.url} (PID ${r.pid})\n     日志: ${r.logFile}`);
      } catch (e) {
        console.error(`[sp] ${e.message}`);
        process.exit(1);
      }
      return;
    }
    case "stop": {
      const r = await stopServer();
      console.log(r.stopped ? `[sp] 服务已停止 (PID ${r.pid})` : `[sp] ${r.reason}`);
      return;
    }
    case "restart": {
      await stopServer();
      await new Promise(r => setTimeout(r, 800));
      try {
        const r = await startServer();
        console.log(`[sp] 已重启: ${r.url}`);
      } catch (e) {
        console.error(`[sp] ${e.message}`);
        process.exit(1);
      }
      return;
    }
    case "status": {
      const s = await getStatus();
      console.log(`[sp] 服务: ${s.healthy ? "运行中" : "未运行"}   地址: ${s.url}`);
      if (s.pid) console.log(`     PID: ${s.pid}`);
      console.log(`     数据目录: ${s.dataDir}`);
      const py = detectPython();
      if (!py) console.log("     ⚠ 未检测到系统 Python 3.8+");
      return;
    }
    case "open": {
      if (!(await isHealthy())) {
        console.log(`[sp] 服务未运行,先执行: sp start`);
        process.exit(1);
      }
      openBrowser();
      console.log(`[sp] 已在浏览器打开 ${BASE_URL}`);
      return;
    }
    case "quit": {
      // 退出后台托盘(写退出标记,worker 优雅收尾)并停止服务
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(TRAY_PID_FILE, "utf8").trim(), 10); } catch { }
      if (alivePid(pid)) {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(QUIT_FLAG_FILE, String(Date.now()));
        for (let i = 0; i < 20 && alivePid(pid); i++) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (alivePid(pid)) { try { process.kill(pid); } catch { } }
        console.log(`[sp] 托盘已退出 (PID ${pid})`);
      } else {
        console.log("[sp] 托盘未在运行");
      }
      try { fs.unlinkSync(QUIT_FLAG_FILE); } catch { }
      const r = await stopServer();
      console.log(r.stopped ? "[sp] 服务已停止" : `[sp] ${r.reason}`);
      return;
    }
    case "autostart": {
      const sub = args[args.indexOf("autostart") + 1];
      if (sub === "on") {
        const ok = autostart.enableAutoStart();
        console.log(`[sp] 开机自启${ok ? "已开启" : "开启失败(当前平台可能不支持)"}`);
      } else if (sub === "off") {
        autostart.disableAutoStart();
        console.log("[sp] 开机自启已关闭");
      } else {
        console.log(`[sp] 开机自启: ${autostart.isAutoStartEnabled() ? "已开启" : "已关闭"}`);
      }
      return;
    }
    default:
      console.error(`[sp] 未知命令: ${cmd}(sp --help 查看用法)`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[sp] ${e.message}`);
  process.exit(1);
});
