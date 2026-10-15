const { ipcRenderer, contextBridge } = require('electron');

// 更新桥接：面板内更新弹窗直接调用主进程 electron-updater
contextBridge.exposeInMainWorld('stravaUpdater', {
  state: () => ipcRenderer.invoke('update-state'),
  check: () => ipcRenderer.invoke('update-check'),
  install: () => ipcRenderer.invoke('update-install'),
  openReleases: () => ipcRenderer.invoke('update-open-releases'),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  onOpen: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('update:open', listener);
    return () => ipcRenderer.removeListener('update:open', listener);
  },
});
