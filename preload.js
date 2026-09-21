const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  parsePaths: (paths) => ipcRenderer.invoke('files:parsePaths', paths),
  coverForPath: (filePath) => ipcRenderer.invoke('files:coverForPath', filePath),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  isElectron: true
});
