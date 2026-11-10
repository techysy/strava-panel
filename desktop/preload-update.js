/**
 * 独立更新窗的 preload：只暴露白名单 API，页面无 nodeIntegration。
 * 与面板（preload.js）完全隔离——更新窗是独立 BrowserWindow，
 * 主窗口卡死 / 未加载 / 被销毁都不影响这里的更新流程。
 * 对齐 CreditDaddy desktop/preload-update.js 的接口形状。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateApi', {
  bootstrap: () => ipcRenderer.invoke('update:win-bootstrap'),
  fitHeight: (height) => ipcRenderer.send('update:win-fit', height),
  action: (name) => ipcRenderer.send('update:win-action', name),
  onState: (cb) => {
    const l = (_e, view) => cb(view);
    ipcRenderer.on('update:win-state', l);
    return () => ipcRenderer.removeListener('update:win-state', l);
  },
});