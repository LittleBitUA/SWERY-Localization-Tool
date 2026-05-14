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
  writeAutosave: (fullPath, content) => ipcRenderer.invoke("dp2:write-autosave", fullPath, content),
  readAutosave: (fullPath) => ipcRenderer.invoke("dp2:read-autosave", fullPath),
  deleteAutosave: (fullPath) => ipcRenderer.invoke("dp2:delete-autosave", fullPath),
  readAll: (folder) => ipcRenderer.invoke("dp2:read-all", folder),
  buildTmWorker: (payload) => ipcRenderer.invoke("dp2:build-tm-worker", payload),
  searchAllWorker: (payload) => ipcRenderer.invoke("dp2:search-all-worker", payload),
  corpusStatsWorker: (payload) => ipcRenderer.invoke("dp2:corpus-stats-worker", payload),
  glossaryConsistencyWorker: (payload) => ipcRenderer.invoke("dp2:glossary-consistency-worker", payload),
  batchReplaceWorker: (payload) => ipcRenderer.invoke("dp2:batch-replace-worker", payload),
  nameConsistencyWorker: (payload) => ipcRenderer.invoke("dp2:name-consistency-worker", payload),
  fileCountsWorker: (payload) => ipcRenderer.invoke("dp2:file-counts-worker", payload),
  smartBreakAllWorker: (payload) => ipcRenderer.invoke("dp2:smart-break-all-worker", payload),
  renameCharaWorker: (payload) => ipcRenderer.invoke("dp2:rename-chara-worker", payload),
  getSettings: () => ipcRenderer.invoke("dp2:get-settings"),
  saveSettings: (partial) => ipcRenderer.invoke("dp2:save-settings", partial),
  launchUabea: () => ipcRenderer.invoke("dp2:launch-uabea"),
  buildAssets: () => ipcRenderer.invoke("dp2:build-assets"),
  fontsExport: () => ipcRenderer.invoke("dp2:fonts-export"),
  fontsReplace: (payload) => ipcRenderer.invoke("dp2:fonts-replace", payload),
  fontsList: () => ipcRenderer.invoke("dp2:fonts-list"),
  fontsReadBase64: (filePath) => ipcRenderer.invoke("dp2:fonts-read-base64", filePath),
  onFontsExportProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:fonts-export-progress", h);
    return () => ipcRenderer.removeListener("dp2:fonts-export-progress", h);
  },
  onFontsReplaceProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:fonts-replace-progress", h);
    return () => ipcRenderer.removeListener("dp2:fonts-replace-progress", h);
  },
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
