/**
 * 服务端管理:服务启停与健康检查
 *
 * Strava Panel 服务端是纯 Node.js ESM(零第三方依赖,Node >=22.13):
 * 直接用运行本 CLI 的同一 node 进程(process.execPath)执行 cli/app/server/app.js。
 *
 * 目录布局:
 *   ~/.strava-panel/                  CLI 家目录(pid/退出标记)
 *   数据目录:win → %APPDATA%\StravaPanel;mac → ~/Library/Application Support/StravaPanel;
 *            linux → ~/.strava-panel/data(与桌面版 userData 布局一致)
 *   ~/.strava-panel/runtime/node_modules  macOS/Linux 托盘依赖(systray2,惰性安装)
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 统一 localhost(与 Strava 注册的 Authorization Callback Domain 字符串精确匹配,
// 127.0.0.1 与 localhost 是两个域名,混用会导致授权 mismatch)
const HOST_ALIAS = 'localhost';
const PORT = parseInt(process.env.SP_PORT || '20227', 10);
const BASE_URL = `http://${HOST_ALIAS}:${PORT}`;
const HOME_DIR = path.join(os.homedir(), '.strava-panel');
const RUNTIME_DIR = path.join(HOME_DIR, 'runtime');

// 包内打包的服务端源码(npm files 包含 app/)
const APP_DIR = path.join(__dirname, '..', 'app');
const SERVER_DIR = path.join(APP_DIR, 'server');
const SERVER_ENTRY = path.join(SERVER_DIR, 'app.js');

// CLI / 服务端统一要求 Node >= 22.13(纯 ESM、零依赖)
const MIN_NODE_VERSION = [22, 13, 0];

function parseVersion(text) {
    const m = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function versionAtLeast(v, min) {
    for (let i = 0; i < 3; i++) {
        if ((v[i] || 0) !== (min[i] || 0)) return (v[i] || 0) > (min[i] || 0);
    }
    return true;
}

function nodeVersionOk() {
    const v = parseVersion(process.version);
    return !!v && versionAtLeast(v, MIN_NODE_VERSION);
}

function dataDir() {
    if (process.env.SP_DATA_DIR) return process.env.SP_DATA_DIR;
    if (process.platform === 'win32' && process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'StravaPanel');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'StravaPanel');
    }
    return path.join(HOME_DIR, 'data');
}

function pidFile() { return path.join(HOME_DIR, 'server.pid'); }

// ──────────────────────── 健康检查 ────────────────────────

function isHealthy(timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitHealthy(deadlineMs, isAlive) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        if (await isHealthy()) return true;
        if (isAlive && !isAlive()) return false;
        await new Promise(r => setTimeout(r, 1200));
    }
    return false;
}

// ──────────────────────── 服务生命周期 ────────────────────────

function readPid() {
    try {
        const pid = parseInt(fs.readFileSync(pidFile(), 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); return pid; } catch { /* 进程已不在 */ }
        }
    } catch { /* 无 pid 文件 */ }
    return null;
}

function killPid(pid) {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
            try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { } }
        }
    } catch { /* 尽力而为 */ }
}

function openBrowser(url = BASE_URL) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? `open "${url}"`
        : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
    try { exec(cmd); } catch { }
}

/**
 * 启动服务(若端口已有健康服务则直接返回 already)
 */
async function startServer({ log = console.log } = {}) {
    if (await isHealthy()) return { already: true, url: BASE_URL };

    // 残留 pid:先清理再启动,避免双实例
    const stale = readPid();
    if (stale) killPid(stale);

    if (!nodeVersionOk()) {
        throw new Error(
            `需要 Node.js >= ${MIN_NODE_VERSION.join('.')} (当前 ${process.version})。请升级 Node.js 后重试(https://nodejs.org)。\n` +
            `Node.js >= ${MIN_NODE_VERSION.join('.')} required (current ${process.version}). Please upgrade: https://nodejs.org`);
    }
    if (!fs.existsSync(SERVER_ENTRY)) {
        throw new Error(`服务端入口缺失: ${SERVER_ENTRY} (请先运行 npm run build)`);
    }

    const dd = dataDir();
    const logDir = path.join(dd, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'server.log');
    try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.truncateSync(logFile, 0); } catch { }
    const logFd = fs.openSync(logFile, 'a');

    log(`[sp] 启动服务: ${BASE_URL} (Node ${process.version}, 数据目录 ${dd})`);
    const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: SERVER_DIR,
        env: {
            ...process.env,
            SP_PORT: String(PORT),
            // 不传 SP_HOST:默认绑 127.0.0.1,纯本机访问免 Windows 防火墙弹窗
            SP_DATA_DIR: dd,
        },
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(pidFile(), String(child.pid));
    log(`[sp] PID ${child.pid},等待服务就绪...`);

    const ok = await waitHealthy(60 * 1000, () => {
        try { process.kill(child.pid, 0); return true; } catch { return false; }
    });
    if (!ok) throw new Error(`服务启动超时,日志见 ${logFile}`);
    return { already: false, url: BASE_URL, pid: child.pid, logFile };
}

async function stopServer({ log = console.log } = {}) {
    const pid = readPid();
    if (!pid) {
        if (await isHealthy()) {
            return { stopped: false, reason: `端口 ${PORT} 有服务在运行,但不是本工具启动的(无 pid 记录)` };
        }
        return { stopped: false, reason: '服务未在运行' };
    }
    log(`[sp] 停止服务 (PID ${pid})...`);
    killPid(pid);
    try { fs.unlinkSync(pidFile()); } catch { }
    const deadline = Date.now() + 8000;
    while (await isHealthy(800) && Date.now() < deadline) {
        killPid(pid);           // 重试
        await new Promise(r => setTimeout(r, 500));
    }
    if (await isHealthy(800)) {
        // taskkill 被拒绝(权限)时用 WMI 兜底
        try {
            spawnSync('wmic', ['process', 'where', `processid=${pid}`, 'delete'], { windowsHide: true });
        } catch { }
        await new Promise(r => setTimeout(r, 1200));
    }
    if (await isHealthy(800)) {
        return { stopped: false, reason: `进程 ${pid} 无法终止(权限不足),请手动结束该 Node 进程` };
    }
    return { stopped: true, pid };
}

async function getStatus() {
    const healthy = await isHealthy();
    return {
        healthy,
        pid: readPid(),
        port: PORT,
        url: BASE_URL,
        dataDir: dataDir(),
    };
}

module.exports = {
    PORT, BASE_URL, HOME_DIR, RUNTIME_DIR, APP_DIR, SERVER_DIR, SERVER_ENTRY,
    MIN_NODE_VERSION, nodeVersionOk,
    dataDir,
    isHealthy, waitHealthy, startServer, stopServer, getStatus,
    readPid, openBrowser,
};
