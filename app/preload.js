const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('botApp', {
  state: () => ipcRenderer.invoke('state'),
  runTrigger: (id) => ipcRenderer.invoke('trigger:run', id),
  setTrigger: (id, patch) => ipcRenderer.invoke('trigger:set', id, patch),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
})
