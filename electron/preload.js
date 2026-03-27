const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ptt', {
  sendAudio: (base64) => ipcRenderer.send('audio', base64),
  commit: () => ipcRenderer.send('commit'),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  setActiveProject: (data) => ipcRenderer.send('set-active-project', data),

  // Hotkeys
  startHotkeyCapture: (which) => ipcRenderer.send('start-hotkey-capture', which),
  cancelHotkeyCapture: () => ipcRenderer.send('cancel-hotkey-capture'),
  onHotkeyCaptured: (cb) => ipcRenderer.on('hotkey-captured', (_e, data) => cb(data)),
  getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),

  // Events from main
  onPtt: (cb) => ipcRenderer.on('ptt', (_e, action) => cb(action)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, status) => cb(status)),
  onTranscript: (cb) => ipcRenderer.on('transcript', (_e, msg) => cb(msg)),
  onTool: (cb) => ipcRenderer.on('tool', (_e, data) => cb(data)),
  onTextDelta: (cb) => ipcRenderer.on('text-delta', (_e, delta) => cb(delta)),
  onTextDone: (cb) => ipcRenderer.on('text-done', () => cb()),
  onError: (cb) => ipcRenderer.on('error', (_e, msg) => cb(msg)),
  onActiveProject: (cb) => ipcRenderer.on('active-project', (_e, name) => cb(name)),
});
