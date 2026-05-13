// Preload runs in a separate sandboxed context; CommonJS is OK here.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dp2", {
  pickFolder: () => ipcRenderer.invoke("dp2:pick-folder"),
  pickFile: (opts) => ipcRenderer.invoke("dp2:pick-file", opts),
  pickSaveFile: (opts) => ipcRenderer.invoke("dp2:pick-save-file", opts),
  listFiles: (folder) => ipcRenderer.invoke("dp2:list-files", folder),
  listTree: (root) => ipcRenderer.invoke("dp2:list-tree", root),
  readFile: (fullPath) => ipcRenderer.invoke("dp2:read-file", fullPath),
  writeFile: (fullPath, content) =>
    ipcRenderer.invoke("dp2:write-file", fullPath, content),
  readBackup: (fullPath) => ipcRenderer.invoke("dp2:read-backup", fullPath),
  readAll: (folder) => ipcRenderer.invoke("dp2:read-all", folder),
  scanAll: (folder) => ipcRenderer.invoke("dp2:scan-all", folder),
  buildTmWorker: (payload) => ipcRenderer.invoke("dp2:build-tm-worker", payload),
  searchAllWorker: (payload) => ipcRenderer.invoke("dp2:search-all-worker", payload),
  getSettings: () => ipcRenderer.invoke("dp2:get-settings"),
  saveSettings: (partial) => ipcRenderer.invoke("dp2:save-settings", partial),
  launchUabea: () => ipcRenderer.invoke("dp2:launch-uabea"),
  buildAssets: () => ipcRenderer.invoke("dp2:build-assets"),
  openFolder: (folder) => ipcRenderer.invoke("dp2:open-folder", folder),

  // Setup / onboarding
  setupStatus: () => ipcRenderer.invoke("dp2:setup-status"),
  setupRun: (payload) => ipcRenderer.invoke("dp2:setup-run", payload),
  setupReset: () => ipcRenderer.invoke("dp2:setup-reset"),
  dp1Pack: (payload) => ipcRenderer.invoke("dp2:dp1-pack", payload),
  onSetupProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:setup-progress", handler);
    return () => ipcRenderer.removeListener("dp2:setup-progress", handler);
  },
});
