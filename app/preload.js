const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  mergeVideos: (params) => ipcRenderer.invoke('merge-videos', params),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  onFfmpegLog: (callback) => ipcRenderer.on('ffmpeg-log', (_, data) => callback(data)),
});
