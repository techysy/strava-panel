/**
 * Strava Panel 桌面托盘版 (Electron)
 *
 * 职责:
 *  - 以子进程方式拉起/停止/重启 Python(纯标准库) 服务
 *  - 轮询 /api/status 判断服务就绪
 *  - 托盘图标 + 菜单(打开界面 / 启动 / 停止 / 重启 / 开机自启 / 退出)
 *  - 内嵌 BrowserWindow 展示 Web 界面,外链一律走系统默认浏览器
 *
 * 环境约定:
 *  - 打包版: resources/python/pythonw.exe + resources/app/(Python 源码)
 *  - 开发版: 系统 python(可用 SP_PYTHON 覆盖)
 *  - 数据目录注入 SP_DATA_DIR = app.getPath('userData')
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 统一 localhost(与 Strava 注册的 Authorization Callback Domain 字符串精确匹配,
// 127.0.0.1 与 localhost 是两个域名,混用会导致授权 mismatch)
const HOST_ALIAS = 'localhost';
const PORT = parseInt(process.env.SP_PORT || '20227', 10);
const BASE_URL = `http://${HOST_ALIAS}:${PORT}`;
const IS_PACKAGED = app.isPackaged;
const ROOT = path.join(__dirname, '..');                     // 开发模式下的仓库根目录
const RESOURCES = IS_PACKAGED ? process.resourcesPath : path.join(__dirname, 'build');
const APP_DIR = IS_PACKAGED ? path.join(RESOURCES, 'app') : ROOT;
const DATA_DIR = app.getPath('userData');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024;

app.setName('strava-panel');

// ──────────────────────── 全局状态 ────────────────────────
/** @type {import('child_process').ChildProcess | null} */
let pyProc = null;
let state = 'stopped';          // stopped | starting | running | external
let quitting = false;
let tray = null;
let win = null;
let serverLogFd = null;

function log(msg) {
    const line = `[${new Date().toLocaleString('sv-SE')}] ${msg}\n`;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, 'tray.log'), line);
    } catch { /* 日志失败不影响主流程 */ }
}

function resolvePython() {
    if (process.env.SP_PYTHON) return process.env.SP_PYTHON;
    if (IS_PACKAGED) {
        const pyw = path.join(RESOURCES, 'python', 'pythonw.exe');
        if (fs.existsSync(pyw)) return pyw;
        return path.join(RESOURCES, 'python', 'python.exe');
    }
    return 'python';
}

// ──────────────────────── 健康检查 ────────────────────────
function checkHealth(timeoutMs = 2000) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        if (!pyProc && state !== 'external') return false;   // 进程已退出,停止等待
        if (await checkHealth()) return true;
        await new Promise(r => setTimeout(r, 1200));
    }
    return false;
}

// ──────────────────────── 服务管理 ────────────────────────
function openServerLogFd() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const logFile = path.join(LOG_DIR, 'server.log');
        try {
            if (fs.statSync(logFile).size > MAX_LOG_SIZE) fs.truncateSync(logFile, 0);
        } catch { /* 文件不存在 */ }
        serverLogFd = fs.openSync(logFile, 'a');
    } catch {
        serverLogFd = null;
    }
}

function setState(next) {
    state = next;
    rebuildMenu();
}

async function startServer() {
    if (pyProc || state === 'running' || state === 'starting') return;

    // 端口已被占用且健康 → 视为外部已有服务在跑(fnOS/Docker/CLI 启动的),直接打开界面
    if (await checkHealth()) {
        setState('external');
        notify('端口已被占用', `${PORT} 端口已有 Strava Panel 在运行,将直接打开界面`);
        createWindow();
        return;
    }

    const pythonExe = resolvePython();
    if (pythonExe !== 'python' && !fs.existsSync(pythonExe)) {
        dialog.showErrorBox('未找到 Python 运行环境', `未找到 ${pythonExe}\n请先运行 desktop\\build-python-runtime.ps1 或以开发模式运行。`);
        return;
    }

    openServerLogFd();
    const env = {
        ...process.env,
        SP_PORT: String(PORT),
        // 不传 SP_HOST:默认绑 127.0.0.1,纯本机访问免 Windows 防火墙弹窗
        SP_DATA_DIR: DATA_DIR,
        PYTHONUNBUFFERED: '1',
    };
    log(`start server: ${pythonExe} server/app.py (data=${DATA_DIR})`);
    const proc = spawn(pythonExe, ['-u', 'app.py'], {
        cwd: path.join(APP_DIR, 'server'),
        env,
        windowsHide: true,
        stdio: ['ignore', serverLogFd, serverLogFd],
    });
    pyProc = proc;
    setState('starting');

    proc.on('error', (err) => {
        log(`python spawn error: ${err.message}`);
        dialog.showErrorBox('启动失败', `Python 进程启动失败:\n${err.message}`);
    });
    proc.on('exit', (code) => {
        log(`python exited (code=${code})`);
        const wasRunning = state === 'running';
        if (serverLogFd !== null) { try { fs.closeSync(serverLogFd); } catch { } serverLogFd = null; }
        pyProc = null;
        if (!quitting) {
            setState('stopped');
            if (wasRunning) notify('服务已停止', 'Python 服务意外退出,可从托盘菜单重新启动');
        }
    });

    const ok = await waitForHealth(60 * 1000);
    if (!pyProc) return;                    // 启动过程中进程退出了
    if (ok) {
        setState('running');
        notify('Strava Panel 已启动', `${BASE_URL}\n如需局域网访问,启动前设 SP_HOST=0.0.0.0`);
        if (!win || win.isDestroyed()) createWindow();      // 启动成功直接打开界面
        else win.loadURL(BASE_URL).catch(() => { });
    } else {
        setState('stopped');
        if (pyProc) { try { killProcTree(pyProc.pid); } catch { } }
        notify('启动超时', `服务在 60 秒内未就绪,日志见 ${path.join(LOG_DIR, 'server.log')}`);
    }
}

function killProcTree(pid) {
    // 被拒绝(权限)时 WMI 兜底
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) {
        spawnSync('wmic', ['process', 'where', `processid=${pid}`, 'delete'], { windowsHide: true });
    }
}

function stopServer() {
    return new Promise((resolve) => {
        if (!pyProc) return resolve();
        const proc = pyProc;
        log(`stop server pid=${proc.pid}`);
        try { killProcTree(proc.pid); } catch (e) { log(`taskkill failed: ${e.message}`); try { proc.kill(); } catch { } }
        const t = setTimeout(() => resolve(), 5000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
}

async function restartServer() {
    notify('正在重启服务', '请稍候…');
    await stopServer();
    await new Promise(r => setTimeout(r, 800));
    await startServer();
}

// ──────────────────────── 窗口 ────────────────────────
function createWindow() {
    if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        return;
    }
    win = new BrowserWindow({
        width: 1280,
        height: 860,
        title: 'Strava Panel',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#1a1a1a',
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);   // Strava 授权/外链走系统浏览器
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(BASE_URL)) {
            e.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        }
    });
    win.on('close', (e) => {
        if (!quitting) {          // 点关闭 = 最小化到托盘
            e.preventDefault();
            win.hide();
        }
    });
    win.loadURL(BASE_URL).catch(() => {
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            `<body style="font-family:sans-serif;padding:40px"><h3>服务未就绪</h3><p>请从托盘图标菜单「启动服务」后重试。</p></body>`));
    });
}

// ──────────────────────── 托盘 ────────────────────────
function notify(title, content) {
    if (!tray) return;
    try {
        tray.displayBalloon({ iconType: 'info', title, content });
    } catch { /* 部分环境不支持气泡 */ }
    log(`notify: ${title}`);
}

const STATE_LABEL = {
    stopped: '服务未运行',
    starting: '服务启动中…',
    running: '服务运行中',
    external: '外部服务运行中(端口占用)',
};

function rebuildMenu() {
    if (!tray) return;
    const canOpen = state === 'running' || state === 'external';
    const menu = Menu.buildFromTemplate([
        { label: '打开 Strava Panel', enabled: canOpen, click: createWindow },
        { type: 'separator' },
        { label: STATE_LABEL[state], enabled: false },
        { label: '启动服务', enabled: state === 'stopped', click: () => startServer() },
        { label: '重启服务', enabled: state === 'running', click: () => restartServer() },
        { label: '停止服务', enabled: state === 'running' || state === 'starting', click: () => stopServer() },
        { type: 'separator' },
        {
            label: '开机自启',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            enabled: IS_PACKAGED,          // 开发模式注册的是 electron.exe,不提供
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: app.getPath('exe') }),
        },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
        { label: '打开服务日志', click: () => shell.openPath(path.join(LOG_DIR, 'server.log')) },
        { type: 'separator' },
        {
            label: '退出',
            click: () => { quitting = true; app.quit(); },
        },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`Strava Panel — ${STATE_LABEL[state]}`);
}

function createTray() {
    let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(icon);
    rebuildMenu();
    tray.on('click', () => {
        if (state === 'running' || state === 'external') createWindow();
        else if (state === 'stopped') startServer();
    });
}

// ──────────────────────── 生命周期 ────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (state === 'running' || state === 'external') createWindow();
    });

    app.whenReady().then(async () => {
        log(`app start (packaged=${IS_PACKAGED}, data=${DATA_DIR})`);
        createTray();
        await startServer();          // 启动即拉起服务
    });

    app.on('before-quit', () => { quitting = true; });

    app.on('will-quit', () => {
        if (pyProc) {
            try { killProcTree(pyProc.pid); } catch { try { pyProc.kill(); } catch { } }
        }
    });

    // 托盘应用:窗口全关也不退出
    app.on('window-all-closed', (e) => { /* no-op,阻止默认退出 */ });
}
