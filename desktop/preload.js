const { ipcRenderer, contextBridge } = require('electron');

// 更新桥接：桌面版「检查更新」开独立更新窗（主进程状态机），面板不再自绘 modal。
// 语言/主题同步给主进程，更新窗文案与配色跟随面板。
contextBridge.exposeInMainWorld('stravaUpdater', {
  state: () => ipcRenderer.invoke('update-state'),
  check: () => ipcRenderer.invoke('update-check'),
  install: () => ipcRenderer.invoke('update-install'),
  openReleases: () => ipcRenderer.invoke('update-open-releases'),
  openWindow: () => ipcRenderer.invoke('update-open-window'),
  setLang: (lang) => ipcRenderer.send('panel-lang', lang),
  setTheme: (theme) => ipcRenderer.send('panel-theme', theme),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
});
