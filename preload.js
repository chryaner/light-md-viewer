'use strict';

// The only bridge between the sandboxed page and the main process. Everything here is a thin
// forwarder: no logic, no state, and no validation worth trusting — main re-checks every value.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mdviewer', {
  onFileLoaded: (cb) => ipcRenderer.on('file:loaded', (_event, payload) => cb(payload)),
  openFileDialog: () => ipcRenderer.invoke('file:open-dialog'),
  openPath: (filePath) => ipcRenderer.invoke('file:open-path', filePath),
  openExternal: (url) => ipcRenderer.invoke('link:open-external', url),
  // File.path was removed from modern Electron; webUtils is the supported way to get a dropped path.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Zoom: a delta, or the string 'reset'. Resolves with the new zoom level.
  zoom: (deltaOrReset) => ipcRenderer.invoke('view:zoom', deltaOrReset),
  onZoomChanged: (cb) => ipcRenderer.on('zoom:changed', (_event, payload) => cb(payload)),

  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),

  // Menu items the renderer owns the UI for.
  onToggleOutline: (cb) => ipcRenderer.on('ui:toggle-outline', () => cb()),
  onOpenFind: (cb) => ipcRenderer.on('ui:open-find', () => cb())
});
