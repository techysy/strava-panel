const { exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let trayInstance = null;
let isWinTray = false;

// 菜单项索引(与 buildMenuItems 对应)
const MENU_INDEX = { STATUS: 0, OPEN: 1, RESTART: 2, STOP: 3, AUTOSTART: 4, QUIT: 5 };

function getIconBase64() {
  const isWin = process.platform === "win32";
  const iconFile = isWin ? "icon.ico" : "icon.png";
  try {
    const iconPath = path.join(__dirname, iconFile);
    if (fs.existsSync(iconPath)) {
      return fs.readFileSync(iconPath).toString("base64");
    }
  } catch (e) {}
  // 兜底:极简橙色圆点 PNG
  return "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAJJJREFUOE9jYBgFzAExMf7/H0j+D8T/GcgCiUgFyP4PxP8ZGBj+w8DA8J+BgYH/IPk/GH79+oUjIyPDgYGB4T8MDAz/GRgY/oPpAJn9GBj+MzD8Z2D4z8Dwn4HhPwPDfwYG/4IyEItJgBmIa2RkZCSqnZERb3QCAAo3KxzxbKe1AAAAAElFTkSuQmCC";
}

function isTraySupported() {
  const platform = process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;
  return true;
}

function buildMenuItems(port, autostartEnabled) {
  return [
    { title: `Strava Panel · 端口 ${port}`, tooltip: "服务状态", enabled: false },
    { title: "打开 Strava Panel", tooltip: "在浏览器打开", enabled: true },
    { title: "重启服务", tooltip: "重启 Python 服务", enabled: true },
    { title: "停止服务", tooltip: "停止后台服务", enabled: true },
    {
      title: autostartEnabled ? "开机自启: 已开启" : "开机自启: 已关闭",
      tooltip: "登录时自动启动托盘",
      enabled: true
    },
    { title: "退出", tooltip: "停止服务并退出", enabled: true }
  ];
}

function getAutostartEnabled() {
  try {
    const { isAutoStartEnabled } = require("./autostart");
    return isAutoStartEnabled();
  } catch (e) { return false; }
}

function handleClick(index, options) {
  const { onOpen, onRestart, onStop, onQuit } = options;
  if (index === MENU_INDEX.OPEN) {
    if (onOpen) onOpen();
  } else if (index === MENU_INDEX.RESTART) {
    if (onRestart) onRestart();
  } else if (index === MENU_INDEX.STOP) {
    if (onStop) onStop();
  } else if (index === MENU_INDEX.AUTOSTART) {
    const enabled = getAutostartEnabled();
    try {
      const { enableAutoStart, disableAutoStart } = require("./autostart");
      if (enabled) disableAutoStart();
      else enableAutoStart();
      updateItem(MENU_INDEX.AUTOSTART,
        !enabled ? "开机自启: 已开启" : "开机自启: 已关闭", true);
    } catch (e) {}
  } else if (index === MENU_INDEX.QUIT) {
    console.log("\n[sp] 正在退出...");
    if (onQuit) onQuit();
    killTray();
    setTimeout(() => process.exit(0), 500);
  }
}

/** 更新状态行(两平台统一入口) */
function updateItem(index, title, enabled) {
  if (!trayInstance) return;
  try {
    if (isWinTray) {
      trayInstance.updateItem(index, title, enabled);
    } else {
      trayInstance.sendAction({
        type: "update-item",
        item: { title, enabled },
        seq_id: index
      });
    }
  } catch (e) {}
}

function initWindowsTray(options) {
  const { port } = options;
  try {
    const { initWinTray } = require("./trayWin");
    const iconPath = path.join(__dirname, "icon.ico");
    const items = buildMenuItems(port, getAutostartEnabled());

    trayInstance = initWinTray({
      iconPath,
      tooltip: `Strava Panel - 端口 ${port}`,
      items,
      onClick: (index) => handleClick(index, options)
    });
    isWinTray = true;
    return trayInstance;
  } catch (err) {
    return null;
  }
}

/** macOS/Linux:systray2 惰性安装到 ~/.strava-panel/runtime/node_modules */
function resolveSystray() {
  const runtimeNM = path.join(os.homedir(), ".strava-panel", "runtime", "node_modules");
  try { return require(path.join(runtimeNM, "systray2")).default; } catch (e) {}
  try { return require("systray2").default; } catch (e) {}
  try { return require(path.join(runtimeNM, "systray")).default; } catch (e) {}
  try { return require("systray").default; } catch (e) {}
  return null;
}

function chmodTrayBin(pkgName) {
  // systray2 的 Go 二进制偶尔丢失可执行位,导致托盘静默失败
  try {
    const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
    const candidates = [
      path.join(os.homedir(), ".strava-panel", "runtime", "node_modules", pkgName, "traybin", binName),
      path.join(__dirname, "..", "..", "..", "node_modules", pkgName, "traybin", binName)
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
  } catch (e) {}
}

function initUnixTray(options) {
  const { port } = options;
  try {
    const SysTray = resolveSystray();
    if (!SysTray) {
      process.stderr.write("[sp] macOS/Linux 托盘需要 systray2: npm i -g systray2 或重新运行安装\n");
      return null;
    }
    chmodTrayBin("systray2");

    const menu = {
      icon: getIconBase64(),
      isTemplateIcon: false,
      title: "",
      tooltip: `Strava Panel - 端口 ${port}`,
      items: buildMenuItems(port, getAutostartEnabled())
    };

    trayInstance = new SysTray({ menu, debug: false, copyDir: true });
    isWinTray = false;

    trayInstance.onClick((action) => handleClick(action.seq_id, options));
    if (trayInstance.ready) {
      trayInstance.ready().catch((err) => {
        process.stderr.write(`[sp] 托盘启动失败: ${err && err.message ? err.message : err}\n`);
      });
    }
    return trayInstance;
  } catch (err) {
    process.stderr.write(`[sp] 托盘初始化失败: ${err.message}\n`);
    return null;
  }
}

function initTray(options) {
  if (!isTraySupported()) return null;
  if (process.platform === "win32") return initWindowsTray(options);
  return initUnixTray(options);
}

function killTray() {
  const instance = trayInstance;
  const wasWin = isWinTray;
  trayInstance = null;
  if (!instance) return Promise.resolve();

  if (wasWin) {
    try { instance.kill(); } catch (e) {}
    return Promise.resolve();
  }

  let proc = null;
  try {
    proc = instance._process || (typeof instance.process === "function" ? instance.process() : null);
  } catch (e) {}

  const gracefulQuit = () => { try { instance.kill(true); } catch (e) {} };
  const closeIpc = () => { try { instance.kill(false); } catch (e) {} };

  if (!proc || !proc.pid) {
    gracefulQuit();
    closeIpc();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; closeIpc(); resolve(); };
    proc.once("exit", finish);
    gracefulQuit();
    setTimeout(() => { try { process.kill(proc.pid, 0); proc.kill("SIGTERM"); } catch (e) {} }, 800);
    setTimeout(() => { try { process.kill(proc.pid, 0); proc.kill("SIGKILL"); } catch (e) {} }, 1600);
    const deadline = Date.now() + 3000;
    const poll = setInterval(() => {
      try { process.kill(proc.pid, 0); } catch { clearInterval(poll); finish(); return; }
      if (Date.now() > deadline) { clearInterval(poll); finish(); }
    }, 50);
  });
}

module.exports = { initTray, killTray, updateItem, MENU_INDEX, isTraySupported };
