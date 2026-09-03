const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

// 开机自启:Windows → 启动文件夹 VBS;macOS → launchd;Linux → XDG autostart
const APP_NAME = "strava-panel";
const APP_LABEL = "com.strava-panel.autostart";

/**
 * Resolve the absolute path to this package's cli.js.
 * 优先级:显式参数 > process.argv[1] > 由本文件位置推导(src/tray/autostart.js 上三级)。
 * 兼容各类全局安装布局(nvm/Volta/Homebrew 等),不依赖 npm bin -g(npm 9 已移除)。
 */
function getCliJsPath(cliPath) {
  if (cliPath) {
    const resolved = path.resolve(cliPath);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.argv[1]) {
    const resolved = path.resolve(process.argv[1]);
    if (path.basename(resolved) === "cli.js" && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const computed = path.resolve(__dirname, "..", "..", "..", "cli.js");
  if (fs.existsSync(computed)) return computed;
  return null;
}

function enableAutoStart(cliPath) {
  const platform = process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) return false;
  if (platform === "linux" && !process.env.DISPLAY) return false;
  try {
    if (platform === "darwin") return enableMacOS(cliPath);
    if (platform === "win32") return enableWindows(cliPath);
    if (platform === "linux") return enableLinux(cliPath);
  } catch (err) { /* 自启是可选项,失败静默 */ }
  return false;
}

function disableAutoStart() {
  const platform = process.platform;
  try {
    if (platform === "darwin") return disableMacOS();
    if (platform === "win32") return disableWindows();
    if (platform === "linux") return disableLinux();
  } catch (e) {}
  return false;
}

function isAutoStartEnabled() {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
      if (!fs.existsSync(plistPath)) return false;
      try {
        execSync(`launchctl list ${APP_LABEL}`, { stdio: ["ignore", "ignore", "ignore"], timeout: 3000 });
        return true;
      } catch (e) { return false; }
    } else if (platform === "win32") {
      const startupPath = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`);
      return fs.existsSync(startupPath);
    } else if (platform === "linux") {
      const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`);
      return fs.existsSync(desktopPath);
    }
  } catch (e) {}
  return false;
}

// ============ macOS ============

/** 当前进程是否就是 launchd 管理的实例(避免 unload 把自己杀掉,托盘图标消失) */
function isAgentSelfMacOS() {
  try {
    const output = execSync(`launchctl list ${APP_LABEL}`, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    return !!(match && parseInt(match[1], 10) === process.pid);
  } catch (e) { return false; }
}

function enableMacOS(cliPath) {
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const plistPath = path.join(launchAgentsDir, `${APP_LABEL}.plist`);
  if (!fs.existsSync(launchAgentsDir)) fs.mkdirSync(launchAgentsDir, { recursive: true });

  const nodePath = process.execPath;
  const cliJs = getCliJsPath(cliPath);
  if (!cliJs) return false;
  const launchPath = `${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin`;

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${APP_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${cliJs}</string>
        <string>--tray</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${launchPath}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/strava-panel.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/strava-panel.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plistContent);
  if (isAgentSelfMacOS()) return true;
  try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch (e) {}
  try { execSync(`launchctl load -w "${plistPath}"`, { stdio: "ignore" }); } catch (e) {}
  return true;
}

function disableMacOS() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
  if (!isAgentSelfMacOS()) {
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch (e) {}
  }
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  return true;
}

// ============ Windows ============

function enableWindows(cliPath) {
  const startupDir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const vbsPath = path.join(startupDir, `${APP_NAME}.vbs`);
  if (!fs.existsSync(startupDir)) return false;

  const nodePath = process.execPath;
  const cliJs = getCliJsPath(cliPath);
  if (!cliJs) return false;

  // 直接以绝对路径调用 node + cli.js,隐藏窗口
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${cliJs}"" --tray", 0, False
`;
  fs.writeFileSync(vbsPath, vbsContent);
  return true;
}

function disableWindows() {
  const vbsPath = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`);
  if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath);
  return true;
}

// ============ Linux ============

function enableLinux(cliPath) {
  const autostartDir = path.join(os.homedir(), ".config", "autostart");
  const desktopPath = path.join(autostartDir, `${APP_NAME}.desktop`);
  if (!fs.existsSync(autostartDir)) {
    try { fs.mkdirSync(autostartDir, { recursive: true }); } catch (e) { return false; }
  }
  const nodePath = process.execPath;
  const cliJs = getCliJsPath(cliPath);
  if (!cliJs) return false;

  const desktopContent = `[Desktop Entry]
Type=Application
Name=Strava Panel
Comment=Strava 骑行数据面板服务
Exec=${nodePath} ${cliJs} --tray
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
  fs.writeFileSync(desktopPath, desktopContent);
  return true;
}

function disableLinux() {
  const desktopPath = path.join(os.homedir(), ".config", "autostart", `${APP_NAME}.desktop`);
  if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath);
  return true;
}

module.exports = { enableAutoStart, disableAutoStart, isAutoStartEnabled };
