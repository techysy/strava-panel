/**
 * Strava Panel 桌面托盘版 (Electron)
 *
 * 职责:
 *  - 以子进程方式拉起/停止/重启 Node.js(零依赖 ESM) 服务
 *  - 轮询 /api/status 判断服务就绪
 *  - 托盘图标 + 菜单(打开界面 / 启动 / 停止 / 重启 / 开机自启 / 退出)
 *  - 内嵌 BrowserWindow 展示 Web 界面,外链一律走系统默认浏览器
 *
 * 环境约定:
 *  - 打包版: 以 ELECTRON_RUN_AS_NODE=1 直接用 Electron 自带的 Node 运行
 *            resources/app/server/app.js(服务端纯 ESM,需 Node >=22.13,Electron 37 已满足)
 *  - 开发版: 系统 node(需 >=22.13,缺失时在托盘对话框提示安装)
 *  - 数据目录注入 SP_DATA_DIR = app.getPath('userData')
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, ipcMain, Notification, nativeTheme } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 自动更新(electron-updater + GitHub Releases)。开发环境没装依赖也能跑,缺失时静默跳过
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* 未安装依赖时不影响主流程 */ }

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
let nodeProc = null;
let state = 'stopped';          // stopped | starting | running | external
let quitting = false;
let tray = null;
let win = null;
let updateWin = null;           // 独立更新窗（主窗卡死/隐藏时仍可用）
let panelLang = 'zh';           // 面板语言（setLang 同步），更新窗文案跟随
let panelTheme = null;          // 面板主题（light/dark/null=跟随系统），更新窗跟随
let serverLogFd = null;

function log(msg) {
    const line = `[${new Date().toLocaleString('sv-SE')}] ${msg}\n`;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, 'tray.log'), line);
    } catch { /* 日志失败不影响主流程 */ }
}

// 服务端为纯 Node.js ESM(零依赖),要求 Node >= 22.13
const MIN_NODE_VERSION = [22, 13, 0];
const SERVER_ENTRY = 'app.js';        // 相对 server 目录

function parseNodeVersion(text) {
    const m = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function nodeVersionAtLeast(v) {
    for (let i = 0; i < 3; i++) {
        if ((v[i] || 0) !== (MIN_NODE_VERSION[i] || 0)) return (v[i] || 0) > (MIN_NODE_VERSION[i] || 0);
    }
    return true;
}

// 打包版:Electron 二进制以 ELECTRON_RUN_AS_NODE=1 充当 node;开发版:系统 node(校验 >=22.13)
function resolveNode() {
    if (IS_PACKAGED) {
        return { cmd: process.execPath, envExtra: { ELECTRON_RUN_AS_NODE: '1' } };
    }
    try {
        const probe = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 8000 });
        const v = parseNodeVersion(probe.stdout || probe.stderr);
        if (probe.status === 0 && v && nodeVersionAtLeast(v)) {
            return { cmd: 'node', envExtra: {} };
        }
    } catch { /* 未安装 node */ }
    return null;
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
        if (!nodeProc && state !== 'external') return false;   // 进程已退出,停止等待
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
    if (nodeProc || state === 'running' || state === 'starting') return;

    // 端口已被占用且健康 → 视为外部已有服务在跑(fnOS/Docker/CLI 启动的),直接打开界面
    if (await checkHealth()) {
        setState('external');
        notify('端口已被占用', `${PORT} 端口已有 Strava Panel 在运行,将直接打开界面`);
        createWindow();
        return;
    }

    const node = resolveNode();
    if (!node) {
        dialog.showErrorBox('未找到 Node.js 22.13+',
            `未找到可用的 Node.js ≥ ${MIN_NODE_VERSION.join('.')}。请安装 Node.js 后重试(https://nodejs.org)。`);
        return;
    }

    openServerLogFd();
    const env = {
        ...process.env,
        ...node.envExtra,
        SP_PORT: String(PORT),
        // 不传 SP_HOST:默认绑 127.0.0.1,纯本机访问免 Windows 防火墙弹窗
        SP_DATA_DIR: DATA_DIR,
    };
    log(`start server: ${node.cmd} server/${SERVER_ENTRY} (run-as-node=${!!node.envExtra.ELECTRON_RUN_AS_NODE}, data=${DATA_DIR})`);
    const proc = spawn(node.cmd, [path.join(APP_DIR, 'server', SERVER_ENTRY)], {
        cwd: path.join(APP_DIR, 'server'),
        env,
        windowsHide: true,
        stdio: ['ignore', serverLogFd, serverLogFd],
    });
    nodeProc = proc;
    setState('starting');

    proc.on('error', (err) => {
        log(`node spawn error: ${err.message}`);
        dialog.showErrorBox('启动失败', `Node 服务进程启动失败:\n${err.message}`);
    });
    proc.on('exit', (code) => {
        log(`node server exited (code=${code})`);
        const wasRunning = state === 'running';
        if (serverLogFd !== null) { try { fs.closeSync(serverLogFd); } catch { } serverLogFd = null; }
        nodeProc = null;
        if (!quitting) {
            setState('stopped');
            if (wasRunning) notify('服务已停止', '服务进程意外退出,可从托盘菜单重新启动');
        }
    });

    const ok = await waitForHealth(60 * 1000);
    if (!nodeProc) return;                  // 启动过程中进程退出了
    if (ok) {
        setState('running');
        notify('Strava Panel 已启动', `${BASE_URL}\n如需局域网访问,启动前设 SP_HOST=0.0.0.0`);
        if (!win || win.isDestroyed()) createWindow();      // 启动成功直接打开界面
        else win.loadURL(BASE_URL).catch(() => { });
    } else {
        setState('stopped');
        if (nodeProc) { try { killProcTree(nodeProc.pid); } catch { } }
        notify('启动超时', `服务在 60 秒内未就绪,日志见 ${path.join(LOG_DIR, 'server.log')}`);
    }
}

function killProcTree(pid) {
    if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        if (r.error) throw r.error;
        return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* 进程已退出 */ }
}

function stopServer() {
    return new Promise((resolve) => {
        if (!nodeProc) return resolve();
        const proc = nodeProc;
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

// ──────────────────────── 自动更新 ────────────────────────
// electron-updater + GitHub Releases(latest*.yml 由 electron-builder publish 配置生成)。
// 打包版且非 portable 才启用;开发模式/依赖缺失静默跳过。
const updateState = { checking: false, available: null, downloaded: null };

function updateSupported() {
    return IS_PACKAGED && !process.env.PORTABLE_EXECUTABLE_DIR && !!autoUpdater;
}

// 版本号比较:x.y.z 逐段数值比较,next 严格大于 cur 才算新版本
function isNewerVersion(next, cur) {
    const p = (s) => String(s).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    const a = p(next);
    const b = p(cur);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return false;
}

function setupAutoUpdate() {
    if (!updateSupported()) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;    // 「稍后」= 退出时自动安装
    autoUpdater.on('update-available', (info) => {
        if (!isNewerVersion(info.version, app.getVersion())) return;
        updateState.available = info.version;
        log(`update available: v${info.version},开始后台下载`);
        pushUpdateUi({ phase: 'available', version: info.version });
    });
    autoUpdater.on('update-not-available', () => { updateState.available = null; });
    autoUpdater.on('update-downloaded', (info) => {
        updateState.downloaded = info.version;
        pushUpdateUi({ phase: 'downloaded', version: info.version });
        // 系统通知（silent）：点击直接开独立更新窗——不依赖主窗口，
        // 主窗卡死/最小化到托盘时这条通道仍可用（对齐 CreditDaddy）
        try {
            const n = new Notification({
                title: updT('更新已就绪'),
                body: updT('v{v} 已在后台下载完成，退出应用时自动安装（也可点击立即重启更新）。', { v: info.version }),
                silent: true,
            });
            n.on('click', () => openUpdateUi());
            n.show();
        } catch { /* 部分环境不支持 Notification */ }
    });
    autoUpdater.on('error', (err) => {
        updateState.checking = false;
        log(`update error: ${(err && err.message) || err}`);
    });
    // 启动 15 秒后查一次(此刻服务已就绪、窗口已展示),之后每 6 小时复查
    const t = setTimeout(() => checkForUpdatesSilent(), 15000);
    if (t.unref) t.unref();
    const iv = setInterval(() => checkForUpdatesSilent(), 6 * 60 * 60 * 1000);
    if (iv.unref) iv.unref();
}

function checkForUpdatesSilent() {
    if (!updateSupported()) return;
    updateState.checking = true;
    autoUpdater.checkForUpdates()
        .catch(() => { })                        // 失败细节已由 error 事件记录
        .finally(() => { updateState.checking = false; });
}

// 托盘「检查更新」:开独立更新窗并立即跑一次检查（无原生对话框，对齐 CreditDaddy）
async function checkForUpdatesInteractive() {
    openUpdateUi();
    if (!updateSupported()) { pushUpdateUi({ phase: 'unsupported' }); return; }
    if (updateState.downloaded) { pushUpdateUi({ phase: 'downloaded', version: updateState.downloaded }); return; }
    if (updateState.checking) return;
    updateState.checking = true;
    pushUpdateUi({ phase: 'checking' });
    try {
        const r = await autoUpdater.checkForUpdates();
        const v = r && r.updateInfo && r.updateInfo.version;
        if (updateState.downloaded) pushUpdateUi({ phase: 'downloaded', version: updateState.downloaded });
        else if (v && isNewerVersion(v, app.getVersion())) pushUpdateUi({ phase: 'available', version: v });
        else pushUpdateUi({ phase: 'latest', version: app.getVersion() });
    } catch (err) {
        pushUpdateUi({ phase: 'error', error: String((err && err.message) || err) });
    } finally {
        updateState.checking = false;
    }
}

// ── 更新状态机 + 独立更新窗（对齐 CreditDaddy，无原生对话框）──
// 面板 preload.js 暴露 window.stravaUpdater；独立更新窗 preload-update.js 暴露 updateApi。
// 状态双通道推送：update:win-state（更新窗）+ update:state（面板，若开着）。
let updateUi = { phase: 'idle' };   // idle | checking | latest | available | downloading | downloaded | unsupported | error
function pushUpdateUi(patch) {
    updateUi = { ...updateUi, ...patch };
    const view = updateUiState();
    try { if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:win-state', view); } catch {}
    try { if (win && !win.isDestroyed()) win.webContents.send('update:state', view); } catch {}
    return updateUi;
}
function updateUiState() {
    return {
        ...updateUi,
        current: app.getVersion(),
        supported: updateSupported(),
        theme: panelTheme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    };
}

// 更新窗文案（zh/en 双语，跟随面板语言；带参数的正文在页面上做占位符替换）
function updT(zh, params) {
    let s = zh;
    if (panelLang === 'en') {
        const EN = {
            '更新已就绪': 'Update ready',
            'v{v} 已在后台下载完成，退出应用时自动安装（也可点击立即重启更新）。': 'v{v} downloaded in background. It installs on quit (or click to restart now).',
        };
        s = EN[zh] || zh;
    }
    if (params) for (const [k, v] of Object.entries(params)) s = s.split('{' + k + '}').join(String(v));
    return s;
}
function updateWindowStrings() {
    const en = panelLang === 'en';
    return en ? {
        windowTitle: 'Strava Panel Update',
        checkingTitle: 'Checking for updates',
        checkingBody: 'Querying GitHub Releases for the latest version…',
        latestTitle: 'You are up to date',
        latestBody: 'v{current} is the latest version.',
        availableTitle: 'New version available',
        availableBody: 'v{version} (current v{current}) is downloading in the background.',
        downloadingTitle: 'Downloading update',
        downloadingBody: 'The app will restart to install once the download completes.',
        downloadedTitle: 'Update ready',
        downloadedBody: 'The installer is downloaded. Click "Install now" to restart and update.',
        unsupportedTitle: 'In-app update unavailable',
        unsupportedBody: 'Dev mode / portable / this platform does not support in-app updates. Download manually from Releases.',
        errorTitle: 'Update check failed',
        openReleases: 'Open Releases',
        installNow: 'Install now',
        later: 'Later',
        ok: 'OK',
        close: 'Close',
    } : {
        windowTitle: 'Strava Panel 更新',
        checkingTitle: '正在检查更新',
        checkingBody: '正在向 GitHub Releases 查询最新版本…',
        latestTitle: '已是最新版本',
        latestBody: '当前 v{current} 已是最新版本。',
        availableTitle: '发现新版本',
        availableBody: '新版本 v{version}（当前 v{current}）正在后台下载。',
        downloadingTitle: '正在下载更新',
        downloadingBody: '下载完成后重启应用即可安装，安装时服务会先停止。',
        downloadedTitle: '更新已就绪',
        downloadedBody: '安装包已下载完成，点「立即安装」重启并完成更新。',
        unsupportedTitle: '当前版本不支持应用内更新',
        unsupportedBody: '开发模式 / 便携版不支持应用内更新，请到 Releases 页面手动下载。',
        errorTitle: '检查更新失败',
        openReleases: '打开 Releases',
        installNow: '立即安装',
        later: '稍后',
        ok: '好的',
        close: '关闭',
    };
}

const UPDATE_HTML = path.join(__dirname, 'update-window.html');
const UPDATE_PRELOAD = path.join(__dirname, 'preload-update.js');

/** 打开（或聚焦）独立更新窗。刻意不唤醒主窗口——主窗卡死时正是要避开它。 */
function openUpdateWindow() {
    if (updateWin && !updateWin.isDestroyed()) {
        try { updateWin.show(); updateWin.focus(); } catch {}
        return;
    }
    updateWin = new BrowserWindow({
        width: 420,
        height: 320,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,                      // 页面内自定义标题栏（拖拽区 + 关闭按钮）
        title: 'Strava Panel',
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: (panelTheme === 'dark' || (!panelTheme && nativeTheme.shouldUseDarkColors)) ? '#0a0a0d' : '#f6f7f9',
        // 不设 parent：主窗卡死/最小化到托盘时它仍可独立显示并操作
        webPreferences: {
            preload: UPDATE_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    updateWin.once('ready-to-show', () => { try { if (updateWin && !updateWin.isDestroyed()) updateWin.show(); } catch {} });
    // 本地 file 页面：外链/导航一律拦死（「打开 Releases」走主进程 shell.openExternal）
    updateWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    updateWin.webContents.on('will-navigate', (e, url) => {
        if (!String(url).startsWith('file://')) e.preventDefault();
    });
    updateWin.on('closed', () => { updateWin = null; });
    updateWin.loadFile(UPDATE_HTML).catch((e) => {
        log(`update window load failed: ${e && e.message}`);
        try { if (updateWin && !updateWin.isDestroyed()) updateWin.close(); } catch {}
    });
}

/** 托盘 / 通知 / 面板入口：只开独立更新窗，不唤醒主窗口。 */
function openUpdateUi() {
    openUpdateWindow();
    pushUpdateUi({});   // 同步一次当前状态（页面 bootstrap 也会补发，双保险）
}

// 更新窗 IPC（sender 校验：只接受更新窗自己的消息）
ipcMain.handle('update:win-bootstrap', (e) => {
    if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return null;
    return { strings: updateWindowStrings(), view: updateUiState() };
});
ipcMain.on('update:win-fit', (e, height) => {
    if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return;
    const h = Math.max(220, Math.min(640, Math.ceil(Number(height) || 0)));
    try { updateWin.setContentSize(420, h); } catch {}
});
ipcMain.on('update:win-action', (e, action) => {
    if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return;
    if (action === 'close') { try { updateWin.close(); } catch {} return; }
    if (action === 'open-releases') {
        try { shell.openExternal('https://github.com/techysy/strava-panel/releases'); } catch {}
        return;
    }
    if (action === 'primary') {
        if (updateUi.phase === 'downloaded' && autoUpdater) {
            quitting = true;
            autoUpdater.quitAndInstall(false, true);
        }
        return;
    }
});

// 面板 IPC（preload.js 的 stravaUpdater 桥）
ipcMain.handle('update-state', () => updateUiState());
ipcMain.handle('update-check', async () => { await checkForUpdatesInteractive(); return updateUiState(); });
ipcMain.handle('update-install', async () => {
    if (updateUi.phase === 'downloaded' && autoUpdater) {
        quitting = true;
        autoUpdater.quitAndInstall(false, true);
    }
    return updateUiState();
});
ipcMain.handle('update-open-releases', () => {
    try { shell.openExternal('https://github.com/techysy/strava-panel/releases'); } catch {}
});
// 面板「检查更新」入口：桌面版直接开独立更新窗（不再用面板内 modal）
ipcMain.handle('update-open-window', () => { openUpdateUi(); checkForUpdatesInteractive().catch(() => {}); });
// 面板语言/主题同步（更新窗跟随）
ipcMain.on('panel-lang', (_e, lang) => { if (lang === 'zh' || lang === 'en') panelLang = lang; });
ipcMain.on('panel-theme', (_e, theme) => {
    panelTheme = (theme === 'light' || theme === 'dark') ? theme : null;
    pushUpdateUi({});   // 主题变化即时推给开着的更新窗
});

// 下载进度推送
function setupUpdateProgressPush() {
    if (!autoUpdater) return;
    autoUpdater.on('download-progress', (p) => {
        pushUpdateUi({ phase: 'downloading', pct: p.percent || 0, bytesPerSecond: p.bytesPerSecond, total: p.total, transferred: p.transferred });
    });
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
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.removeMenu();
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
        if (!quitting && win && !win.isDestroyed()) {          // 点关闭 = 最小化到托盘
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
        { label: '检查更新', click: () => checkForUpdatesInteractive() },
        { type: 'separator' },
        {
            label: '退出',
            click: async () => {
                quitting = true;
                try { await stopServer(); } catch { }
                app.quit();
            },
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
        setupAutoUpdate();            // 服务就绪后延迟检查更新
        setupUpdateProgressPush();    // 面板内更新弹窗进度推送
    });

    app.on('before-quit', () => { quitting = true; });

    app.on('will-quit', (e) => {
        if (nodeProc) {
            e.preventDefault();
            const forceExit = setTimeout(() => { try { process.exit(0); } catch { } }, 3000);
            if (forceExit.unref) forceExit.unref();
            (async () => {
                try { killProcTree(nodeProc.pid); } catch { try { nodeProc.kill(); } catch { } }
                const t = setTimeout(() => { try { process.exit(0); } catch { } }, 2000);
                if (t.unref) t.unref();
                nodeProc.once('exit', () => { clearTimeout(forceExit); app.quit(); });
                setTimeout(() => { clearTimeout(forceExit); app.quit(); }, 2500).unref?.();
            })();
        }
    });

    // 托盘应用:窗口全关也不退出
    app.on('window-all-closed', (e) => { /* no-op,阻止默认退出 */ });
}
