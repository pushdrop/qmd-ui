'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qmdSetup', {
  scanFolders:      ()           => ipcRenderer.invoke('scan-folders'),
  addCollection:    (name, dir)  => ipcRenderer.invoke('add-collection', { name, dir }),
  openFolderDialog: ()           => ipcRenderer.invoke('open-folder-dialog'),
  runUpdate:        ()           => ipcRenderer.invoke('run-update'),
  runEmbed:         ()           => ipcRenderer.invoke('run-embed'),
  getStatus:        ()           => ipcRenderer.invoke('get-status'),
  finishSetup:      ()           => ipcRenderer.invoke('finish-setup'),
  onProgress:       (cb)         => ipcRenderer.on('update-progress', (_, msg) => cb(msg)),
});
