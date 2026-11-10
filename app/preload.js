const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('botApp', {
  state: () => ipcRenderer.invoke('state'),
  runTrigger: (id) => ipcRenderer.invoke('trigger:run', id),
  setTrigger: (id, patch) => ipcRenderer.invoke('trigger:set', id, patch),
  reviewerState: () => ipcRenderer.invoke('reviewer:state'),
  reviewerRun: () => ipcRenderer.invoke('reviewer:run'),
  reviewerInstall: (minutes) => ipcRenderer.invoke('reviewer:install', minutes),
  reviewerUninstall: () => ipcRenderer.invoke('reviewer:uninstall'),
  onReviewer: (cb) => ipcRenderer.on('reviewer', (_e, s) => cb(s)),
  appInfo: () => ipcRenderer.invoke('app:info'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
})
