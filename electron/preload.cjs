// Preload runs in a separate sandboxed context; CommonJS is OK here.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dp2", {
  pickFolder: (opts) => ipcRenderer.invoke("dp2:pick-folder", opts),
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
  fontsRestoreBak: () => ipcRenderer.invoke("dp2:fonts-restore-bak"),
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
  openExternal: (url) => ipcRenderer.invoke("dp2:open-external", url),
  checkUpdate: (payload) => ipcRenderer.invoke("dp2:check-update", payload),
  fetchReleases: (payload) => ipcRenderer.invoke("dp2:fetch-releases", payload),
  dismissUpdateVersion: (version) => ipcRenderer.invoke("dp2:dismiss-update-version", version),
  appVersion: () => ipcRenderer.invoke("dp2:app-version"),
  steamFindGame: (folderName) => ipcRenderer.invoke("dp2:steam-find-game", folderName),
  applyUpdate: () => ipcRenderer.invoke("dp2:apply-update"),
  onUpdateProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("dp2:update-progress", h);
    return () => ipcRenderer.removeListener("dp2:update-progress", h);
  },

  // Setup / onboarding
  setupStatus: () => ipcRenderer.invoke("dp2:setup-status"),
  setupRun: (payload) => ipcRenderer.invoke("dp2:setup-run", payload),
  setupReset: () => ipcRenderer.invoke("dp2:setup-reset"),
  dp1SetupStatus: () => ipcRenderer.invoke("dp2:dp1-setup-status"),
  dp1DownloadTool: () => ipcRenderer.invoke("dp2:dp1-download-tool"),
  dp1PrepMes: (payload) => ipcRenderer.invoke("dp2:dp1-prep-mes", payload),
  onDp1ToolProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("dp2:dp1-tool-progress", h);
    return () => ipcRenderer.removeListener("dp2:dp1-tool-progress", h);
  },
  // DP1 text editor
  dp1TextLoad: () => ipcRenderer.invoke("dp2:dp1-text-load"),
  dp1TextSave: (payload) => ipcRenderer.invoke("dp2:dp1-text-save", payload),
  dp1TextCorpusStats: () => ipcRenderer.invoke("dp2:dp1-text-corpus-stats"),
  dp1TextLintMarkers: () => ipcRenderer.invoke("dp2:dp1-text-lint-markers"),
  dp1TextExportCombined: (payload) => ipcRenderer.invoke("dp2:dp1-text-export-combined", payload),
  dp1TextImportCombined: (payload) => ipcRenderer.invoke("dp2:dp1-text-import-combined", payload),
  dp1Pack: () => ipcRenderer.invoke("dp2:dp1-pack"),
  dp1GlyphMapRead: () => ipcRenderer.invoke("dp2:dp1-glyphmap-read"),
  dp1GlyphMapWrite: (payload) => ipcRenderer.invoke("dp2:dp1-glyphmap-write", payload),
  dp1TexturesList: () => ipcRenderer.invoke("dp2:dp1-textures-list"),
  dp1TexturesExtractAll: () => ipcRenderer.invoke("dp2:dp1-textures-extract-all"),
  dp1TexturesPackAll: () => ipcRenderer.invoke("dp2:dp1-textures-pack-all"),
  dp1TextureReadPayload: (relPath) => ipcRenderer.invoke("dp2:dp1-texture-read-payload", relPath),
  dp1TextureReplaceOne: (payload) => ipcRenderer.invoke("dp2:dp1-texture-replace-one", payload),
  onDp1TexturesProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:dp1-textures-progress", h);
    return () => ipcRenderer.removeListener("dp2:dp1-textures-progress", h);
  },
  dp1FontsPrep: () => ipcRenderer.invoke("dp2:dp1-fonts-prep"),
  dp1FontsReadRgba: () => ipcRenderer.invoke("dp2:dp1-fonts-read-rgba"),
  dp1FontsSaveRgba: (payload) => ipcRenderer.invoke("dp2:dp1-fonts-save-rgba", payload),
  readFontFile: (fontPath) => ipcRenderer.invoke("dp2:read-font-file", fontPath),
  dp1FontsEnsureTypeface: () => ipcRenderer.invoke("dp2:dp1-fonts-ensure-typeface"),
  onDp1FontsTypefaceProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:dp1-fonts-typeface-progress", h);
    return () => ipcRenderer.removeListener("dp2:dp1-fonts-typeface-progress", h);
  },
  tglLoad: (binPath) => ipcRenderer.invoke("dp2:tgl-load", binPath),
  tglSaveWorkfile: (payload) => ipcRenderer.invoke("dp2:tgl-save-workfile", payload),
  tglPack: (payload) => ipcRenderer.invoke("dp2:tgl-pack", payload),
  tglTextPrep: (payload) => ipcRenderer.invoke("dp2:tgl-text-prep", payload),
  tglTextWrite: (payload) => ipcRenderer.invoke("dp2:tgl-text-write", payload),
  tglFontsList: () => ipcRenderer.invoke("dp2:tgl-fonts-list"),
  tglFontsExtract: (payload) => ipcRenderer.invoke("dp2:tgl-fonts-extract", payload),
  tglFontsImportToCab: (payload) => ipcRenderer.invoke("dp2:tgl-fonts-import-to-cab", payload),
  tglFontsReadJson: (p) => ipcRenderer.invoke("dp2:tgl-fonts-read-json", p),
  tglFontsWriteJson: (payload) => ipcRenderer.invoke("dp2:tgl-fonts-write-json", payload),
  tglFontsReadAtlasBase64: (p) => ipcRenderer.invoke("dp2:tgl-fonts-read-atlas-base64", p),
  tglFontsWriteAtlasBase64: (payload) => ipcRenderer.invoke("dp2:tgl-fonts-write-atlas-base64", payload),
  texturesExport: (payload) => ipcRenderer.invoke("dp2:textures-export", payload),
  texturesReplace: (payload) => ipcRenderer.invoke("dp2:textures-replace", payload),
  texturesList: () => ipcRenderer.invoke("dp2:textures-list"),
  texturesReadBase64: (filePath) => ipcRenderer.invoke("dp2:textures-read-base64", filePath),
  onSetupProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:setup-progress", handler);
    return () => ipcRenderer.removeListener("dp2:setup-progress", handler);
  },
  onTexturesReplaceProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:textures-replace-progress", h);
    return () => ipcRenderer.removeListener("dp2:textures-replace-progress", h);
  },
  onTexturesExportProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:textures-export-progress", h);
    return () => ipcRenderer.removeListener("dp2:textures-export-progress", h);
  },
  onTglFontsImportProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:tgl-fonts-import-progress", h);
    return () => ipcRenderer.removeListener("dp2:tgl-fonts-import-progress", h);
  },
  readLocaleFile: (lang) => ipcRenderer.invoke("dp2:read-locale-file", lang),

  // DP2 text prep — extract MonoBehaviour text dumps from sharedassets0.assets
  // into TEXT/ORIGINAL, then mirror to TEXT/DONE for editing.
  hbrTextPrepStatus: () => ipcRenderer.invoke("dp2:hbr-text-prep-status"),
  hbrTextPrepExtract: () => ipcRenderer.invoke("dp2:hbr-text-prep-extract"),
  hbrPatchMigrateCheck: () => ipcRenderer.invoke("dp2:hbr-patch-migrate-check"),
  hbrPatchMigrate: () => ipcRenderer.invoke("dp2:hbr-patch-migrate"),

  // THE MISSING — text extract + edit + pack pipeline.
  missingPrepStatus: () => ipcRenderer.invoke("dp2:missing-prep-status"),
  missingPrepExtract: () => ipcRenderer.invoke("dp2:missing-prep-extract"),
  missingTextList: () => ipcRenderer.invoke("dp2:missing-text-list"),
  missingTextRead: (fullPath) => ipcRenderer.invoke("dp2:missing-text-read", fullPath),
  missingTextWrite: (payload) => ipcRenderer.invoke("dp2:missing-text-write", payload),
  missingPack: () => ipcRenderer.invoke("dp2:missing-pack"),
  missingTextMetaRead: () => ipcRenderer.invoke("dp2:missing-text-meta-read"),
  missingTextMetaWrite: (payload) => ipcRenderer.invoke("dp2:missing-text-meta-write", payload),
  missingCorpusStatsQuick: () => ipcRenderer.invoke("dp2:missing-corpus-stats-quick"),
  missingBoxsizeExtract: () => ipcRenderer.invoke("dp2:missing-boxsize-extract"),
  missingBoxsizeRead: () => ipcRenderer.invoke("dp2:missing-boxsize-read"),
  missingBoxsizeReadOriginal: () => ipcRenderer.invoke("dp2:missing-boxsize-read-original"),
  missingBoxsizeSave: (payload) => ipcRenderer.invoke("dp2:missing-boxsize-save", payload),
  missingBoxsizePack: () => ipcRenderer.invoke("dp2:missing-boxsize-pack"),
  missingDllStringsExtract: () => ipcRenderer.invoke("dp2:missing-dll-strings-extract"),
  missingDllStringsApply: (payload) => ipcRenderer.invoke("dp2:missing-dll-strings-apply", payload),
  missingDllDialogFix: () => ipcRenderer.invoke("dp2:missing-dll-dialog-fix"),
  missingDllDialogFixRevert: () => ipcRenderer.invoke("dp2:missing-dll-dialog-fix-revert"),
  missingDllDialogFixStatus: () => ipcRenderer.invoke("dp2:missing-dll-dialog-fix-status"),
  missingUiTextExport: (payload) => ipcRenderer.invoke("dp2:missing-ui-text-export", payload),
  missingUiTextImport: (payload) => ipcRenderer.invoke("dp2:missing-ui-text-import", payload),
  missingUiTextImportInline: (payload) => ipcRenderer.invoke("dp2:missing-ui-text-import-inline", payload),
  missingBuildRelease: () => ipcRenderer.invoke("dp2:missing-build-release"),
  onMissingPrepProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:missing-prep-progress", h);
    return () => ipcRenderer.removeListener("dp2:missing-prep-progress", h);
  },
  onMissingPackProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:missing-pack-progress", h);
    return () => ipcRenderer.removeListener("dp2:missing-pack-progress", h);
  },
  // THE MISSING — fonts.
  missingFontsStatus: () => ipcRenderer.invoke("dp2:missing-fonts-status"),
  missingFontsExport: () => ipcRenderer.invoke("dp2:missing-fonts-export"),
  missingFontsList: () => ipcRenderer.invoke("dp2:missing-fonts-list"),
  missingFontsPickReplace: (payload) => ipcRenderer.invoke("dp2:missing-fonts-pick-replace", payload),
  missingFontsClearReplace: (payload) => ipcRenderer.invoke("dp2:missing-fonts-clear-replace", payload),
  missingFontsPack: () => ipcRenderer.invoke("dp2:missing-fonts-pack"),
  onMissingFontsProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:missing-fonts-progress", h);
    return () => ipcRenderer.removeListener("dp2:missing-fonts-progress", h);
  },
  onMissingFontsPackProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:missing-fonts-pack-progress", h);
    return () => ipcRenderer.removeListener("dp2:missing-fonts-pack-progress", h);
  },
  // THE MISSING — textures.
  missingTexturesStatus: () => ipcRenderer.invoke("dp2:missing-textures-status"),
  missingTexturesExport: () => ipcRenderer.invoke("dp2:missing-textures-export"),
  missingTexturesPickReplace: (payload) => ipcRenderer.invoke("dp2:missing-textures-pick-replace", payload),
  missingTexturesClearReplace: (payload) => ipcRenderer.invoke("dp2:missing-textures-clear-replace", payload),
  missingTexturesPack: () => ipcRenderer.invoke("dp2:missing-textures-pack"),
  onMissingTexturesProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:missing-textures-progress", h);
    return () => ipcRenderer.removeListener("dp2:missing-textures-progress", h);
  },
  onMissingTexturesPackProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:missing-textures-pack-progress", h);
    return () => ipcRenderer.removeListener("dp2:missing-textures-pack-progress", h);
  },
  hbrTextPrepMirror: (payload) => ipcRenderer.invoke("dp2:hbr-text-prep-mirror", payload),
  hbrTextList: () => ipcRenderer.invoke("dp2:hbr-text-list"),
  hbrTextRead: (fullPath) => ipcRenderer.invoke("dp2:hbr-text-read", fullPath),
  hbrTextWrite: (payload) => ipcRenderer.invoke("dp2:hbr-text-write", payload),
  hbrTextRestoreBak: (fullPath) => ipcRenderer.invoke("dp2:hbr-text-restore-bak", fullPath),
  hbrToolsStatus: () => ipcRenderer.invoke("dp2:hbr-tools-status"),
  hbrToolsDownload: () => ipcRenderer.invoke("dp2:hbr-tools-download"),
  hbrCatalogStatus: () => ipcRenderer.invoke("dp2:hbr-catalog-status"),
  hbrCatalogPatch: () => ipcRenderer.invoke("dp2:hbr-catalog-patch"),
  hbrCorpusStats: () => ipcRenderer.invoke("dp2:hbr-corpus-stats"),
  hbrFontgenStatus: () => ipcRenderer.invoke("dp2:hbr-fontgen-status"),
  hbrFontgenDownload: () => ipcRenderer.invoke("dp2:hbr-fontgen-download"),
  onHbrFontgenProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:hbr-fontgen-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-fontgen-progress", h);
  },
  onHbrPackProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-pack-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-pack-progress", h);
  },
  onHbrToolsProgress: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("dp2:hbr-tools-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-tools-progress", h);
  },
  hbrPackIntoGame: () => ipcRenderer.invoke("dp2:hbr-pack-into-game"),
  hbrTextPurgeDlc: () => ipcRenderer.invoke("dp2:hbr-text-purge-dlc"),
  hbrTextLintPlaceholders: () => ipcRenderer.invoke("dp2:hbr-text-lint-placeholders"),
  hbrFontsStatus: () => ipcRenderer.invoke("dp2:hbr-fonts-status"),
  hbrFontsAtlasExport: () => ipcRenderer.invoke("dp2:hbr-fonts-atlas-export"),
  hbrFontsMonoExport: () => ipcRenderer.invoke("dp2:hbr-fonts-mono-export"),
  hbrFontgenLaunch: () => ipcRenderer.invoke("dp2:hbr-fontgen-launch"),
  hbrFontsImport: () => ipcRenderer.invoke("dp2:hbr-fonts-import"),
  onHbrFontsImportProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-fonts-import-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-fonts-import-progress", h);
  },
  onHbrFontsAtlasProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-fonts-atlas-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-fonts-atlas-progress", h);
  },
  onHbrFontsMonoProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-fonts-mono-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-fonts-mono-progress", h);
  },
  hbrTexturesStatus: () => ipcRenderer.invoke("dp2:hbr-textures-status"),
  hbrTexturesExport: (payload) => ipcRenderer.invoke("dp2:hbr-textures-export", payload),
  hbrTexturesReplace: (payload) => ipcRenderer.invoke("dp2:hbr-textures-replace", payload),
  hbrTexturesList: () => ipcRenderer.invoke("dp2:hbr-textures-list"),
  hbrTexturesReadBase64: (filePath) => ipcRenderer.invoke("dp2:hbr-textures-read-base64", filePath),
  onHbrTexturesExportProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-textures-export-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-textures-export-progress", h);
  },
  onHbrTexturesReplaceProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-textures-replace-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-textures-replace-progress", h);
  },
  hbrBuildRelease: () => ipcRenderer.invoke("dp2:hbr-build-release"),
  launchSteamGame: (appId) => ipcRenderer.invoke("dp2:launch-steam-game", appId),
  tglMonoExport: (payload) => ipcRenderer.invoke("dp2:tgl-mono-export", payload),
  tglMonoImport: (payload) => ipcRenderer.invoke("dp2:tgl-mono-import", payload),
  hbrBackupDone: () => ipcRenderer.invoke("dp2:hbr-backup-done"),
  hbrOpenFolder: (which) => ipcRenderer.invoke("dp2:hbr-open-folder", which),
  onHbrTextPrepProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:hbr-text-prep-progress", h);
    return () => ipcRenderer.removeListener("dp2:hbr-text-prep-progress", h);
  },
  textPrepStatus: (payload) => ipcRenderer.invoke("dp2:text-prep-status", payload),
  textPrepExtract: (payload) => ipcRenderer.invoke("dp2:text-prep-extract", payload),
  textPrepCopyToDone: (payload) => ipcRenderer.invoke("dp2:text-prep-copy-to-done", payload),
  onTextPrepProgress: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on("dp2:text-prep-progress", h);
    return () => ipcRenderer.removeListener("dp2:text-prep-progress", h);
  },
});
