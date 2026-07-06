const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectImages: () => ipcRenderer.invoke('select-images'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  getDefaultOutputDir: () => ipcRenderer.invoke('get-default-output-dir'),
  mergeVideos: (params) => ipcRenderer.invoke('merge-videos', params),
  exportEditedVideo: (params) => ipcRenderer.invoke('export-edited-video', params),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  getFileUrl: (filePath) => ipcRenderer.invoke('get-file-url', filePath),
  probeDuration: (filePath) => ipcRenderer.invoke('probe-duration', filePath),
  getSystemFonts: () => ipcRenderer.invoke('get-system-fonts'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  onFfmpegLog: (callback) => ipcRenderer.on('ffmpeg-log', (_, data) => callback(data)),

  // AI API Methods
  getApiConfig: () => ipcRenderer.invoke('api-get-config'),
  saveApiConfig: (config) => ipcRenderer.invoke('api-save-config', config),
  testApiConnection: (service) => ipcRenderer.invoke('api-test-connection', service),
  generateImage: (params) => ipcRenderer.invoke('api-generate-image', params),
  generateVideo: (params) => ipcRenderer.invoke('api-generate-video', params),
  getAiHistory: () => ipcRenderer.invoke('api-get-history'),
  clearAiHistory: () => ipcRenderer.invoke('api-clear-history'),
  saveGeneratedFile: (params) => ipcRenderer.invoke('api-save-generated-file', params),
  onAiProgress: (callback) => ipcRenderer.on('ai-progress', (_, data) => callback(data)),
});
