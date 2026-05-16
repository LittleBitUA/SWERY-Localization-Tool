// Electron main process — створює вікно, обробляє IPC для file system,
// запускає UABEA Next для зворотнього імпорту JSON у .assets.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");

// Прибираємо стандартне меню Electron, щоб не перехоплювало Monaco shortcuts
// (Ctrl+F, Ctrl+H, Ctrl+G тощо).
Menu.setApplicationMenu(null);
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { spawn } = require("node:child_process");

// scripts/ ідуть як extraResources у production, тому require треба резолвити
// через process.resourcesPath, а не __dirname (де лежить app.asar у packed).
const scriptsDir = app.isPackaged
  ? path.join(process.resourcesPath, "scripts")
  : path.join(__dirname, "..", "scripts");
const setupTools = require(path.join(scriptsDir, "setup-tools.cjs"));

// ── Heavy worker (worker_threads) ───────────────────────────────────────
// Один long-running worker для всіх важких JSON-операцій (scan/tm/search),
// щоб не блокувати ні main, ні renderer і не платити cost старту щоразу.
const { Worker } = require("node:worker_threads");
let heavyWorker = null;
const heavyPending = new Map();
let heavySeq = 0;

function getHeavyWorker() {
  if (heavyWorker) return heavyWorker;
  const workerPath = path.join(scriptsDir, "heavy-worker.cjs");
  heavyWorker = new Worker(workerPath);
  heavyWorker.on("message", (msg) => {
    const cb = heavyPending.get(msg.id);
    if (!cb) return;
    heavyPending.delete(msg.id);
    if (msg.ok) cb.resolve(msg.result);
    else cb.reject(new Error(msg.error));
  });
  heavyWorker.on("error", (err) => {
    // Поточні очікувані запити отримують помилку, worker буде перестворено
    // при наступному виклику.
    for (const cb of heavyPending.values()) cb.reject(err);
    heavyPending.clear();
    heavyWorker = null;
  });
  heavyWorker.on("exit", () => {
    for (const cb of heavyPending.values()) cb.reject(new Error("heavy worker exited"));
    heavyPending.clear();
    heavyWorker = null;
  });
  return heavyWorker;
}

function callHeavy(type, payload) {
  return new Promise((resolve, reject) => {
    const w = getHeavyWorker();
    const id = ++heavySeq;
    heavyPending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

app.on("before-quit", () => {
  if (heavyWorker) { try { heavyWorker.terminate(); } catch {} heavyWorker = null; }
});

const isDev = !app.isPackaged;

// Resolve a path that lives in the project root in dev, or in the
// "resources/" directory next to the .exe in production.
function resolveResource(relPath) {
  return isDev
    ? path.join(__dirname, "..", relPath)
    : path.join(process.resourcesPath, relPath);
}

// ── Settings (UABEA path, default folders) — JSON у userData ─────
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

async function readSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSettings(next) {
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
}

// Глобальне посилання на головне вікно для broadcast'у setup-progress.
let mainWindow = null;

function sendSetupProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("dp2:setup-progress", payload); } catch {}
  }
}

async function createWindow() {
  const iconPath = resolveResource("ico.png");

  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    // Колір фону до моменту, коли CSS завантажиться. Має збігатися
    // з --bg у global.css, інакше при старті блимає чужа тема.
    backgroundColor: "#0d1117",
    show: false,
    title: "Deadly Premonition Localization Tool",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Optimizations: відключаємо background-throttling (повна швидкість
      // навіть коли вікно не у фокусі), стандартний spellcheck (у нас свої
      // діагностики через Monaco), WebSQL (не використовуємо).
      backgroundThrottling: false,
      spellcheck: false,
      enableWebSQL: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    // У dev-режимі одразу відкриваємо DevTools — щоб юзер міг інспектувати UI.
    if (isDev) win.webContents.openDevTools({ mode: "right" });
  });
  mainWindow = win;

  if (isDev) {
    await win.loadURL("http://localhost:5173");
  } else {
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// ── IPC: pick folder ─────────────────────────────────────────────
ipcMain.handle("dp2:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Виберіть теку з JSON-дампами DP2",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const picked = result.filePaths[0];
  // Додаємо у recentFolders (max 8, дедуплікація, MRU-порядок).
  try {
    const cur = await readSettings();
    const prev = Array.isArray(cur.recentFolders) ? cur.recentFolders : [];
    const next = [picked, ...prev.filter((p) => p !== picked)].slice(0, 8);
    await writeSettings({ ...cur, recentFolders: next });
  } catch {}
  return picked;
});

// ── IPC: pick file ───────────────────────────────────────────────
ipcMain.handle("dp2:pick-file", async (_event, options) => {
  const result = await dialog.showOpenDialog({
    title: options?.title || "Виберіть файл",
    properties: ["openFile"],
    filters: options?.filters || [{ name: "All", extensions: ["*"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── IPC: pick save target ────────────────────────────────────────
ipcMain.handle("dp2:pick-save-file", async (_event, options) => {
  const result = await dialog.showSaveDialog({
    title: options?.title || "Зберегти як",
    defaultPath: options?.defaultPath,
    filters: options?.filters || [{ name: "All", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// Файли, які НЕ є user-візибл DP2-дампами і мають бути приховані у tree/listings.
function isHiddenJson(name) {
  return name.endsWith(".bak.json")
    || name.endsWith(".autosave.json")
    || name.endsWith(".dp-status.json")
    || name.endsWith("_ua_work.json")
    || name.endsWith("_ua_done.json")
    || name.endsWith(".dp2-glossary.json");
}

// ── IPC: list JSON files ─────────────────────────────────────────
ipcMain.handle("dp2:list-files", async (_event, folder) => {
  if (!folder) return [];
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .filter((e) => !isHiddenJson(e.name))
    .map((e) => e.name)
    .sort();
});

// ── IPC: recursive tree of folder (used by sidebar tree view) ──
async function readTree(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = [];
  const files = [];
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      try {
        folders.push(await readTree(fullPath));
      } catch { /* skip unreadable */ }
    } else if (
      e.isFile() &&
      e.name.toLowerCase().endsWith(".json") &&
      !isHiddenJson(e.name)
    ) {
      files.push({ type: "file", name: e.name, path: fullPath });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    type: "folder",
    name: path.basename(dir) || dir,
    path: dir,
    children: [...folders, ...files],
  };
}
ipcMain.handle("dp2:list-tree", async (_event, root) => {
  if (!root) return null;
  return await readTree(root);
});

// ── IPC: read file ───────────────────────────────────────────────
ipcMain.handle("dp2:read-file", async (_event, fullPath) => {
  return await fs.readFile(fullPath, "utf8");
});

// ── IPC: write file (with .bak backup if not exists) ─────────────
ipcMain.handle("dp2:write-file", async (_event, fullPath, content) => {
  const bakPath = fullPath.replace(/\.json$/i, ".bak.json");
  try {
    await fs.access(bakPath);
  } catch {
    try {
      const original = await fs.readFile(fullPath, "utf8");
      await fs.writeFile(bakPath, original, "utf8");
    } catch (e) {
      console.warn("Failed to create .bak:", e);
    }
  }
  await fs.writeFile(fullPath, content, "utf8");
  return true;
});

// ── IPC: read backup if exists ───────────────────────────────────
ipcMain.handle("dp2:read-backup", async (_event, fullPath) => {
  const bakPath = fullPath.replace(/\.json$/i, ".bak.json");
  try {
    return await fs.readFile(bakPath, "utf8");
  } catch {
    return null;
  }
});

// ── IPC: read all JSON dumps under folder (for TM / pre-flight) ──
// Повертає масив { path, content, bakContent }. .bak.json фільтрується.
async function collectJsonFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      try { out.push(...await collectJsonFiles(full)); } catch {}
    } else if (
      e.isFile() &&
      e.name.toLowerCase().endsWith(".json") &&
      !isHiddenJson(e.name)
    ) {
      out.push(full);
    }
  }
  return out;
}
ipcMain.handle("dp2:read-all", async (_event, folder) => {
  if (!folder) return [];
  const files = await collectJsonFiles(folder);
  // Паралельне читання — швидше за послідовний цикл, бо IO не блокує CPU.
  const result = await Promise.all(files.map(async (fp) => {
    try {
      const content = await fs.readFile(fp, "utf8");
      let bakContent = null;
      const bakPath = fp.replace(/\.json$/i, ".bak.json");
      try { bakContent = await fs.readFile(bakPath, "utf8"); } catch {}
      return { path: fp, content, bakContent };
    } catch { return null; }
  }));
  return result.filter(Boolean);
});

// ── IPC: autosave sidecar ────────────────────────────────────────
// Пишемо `<file>.autosave.json` поруч з оригіналом — НЕ створюючи .bak і
// НЕ чіпаючи реальний файл. При успішному saveFile цей sidecar видаляється.
function autosavePathFor(fullPath) {
  return fullPath.replace(/\.json$/i, ".autosave.json");
}
ipcMain.handle("dp2:write-autosave", async (_e, fullPath, content) => {
  const dest = autosavePathFor(fullPath);
  await fs.writeFile(dest, content, "utf8");
  return dest;
});
ipcMain.handle("dp2:read-autosave", async (_e, fullPath) => {
  const ap = autosavePathFor(fullPath);
  try {
    const [content, st] = await Promise.all([
      fs.readFile(ap, "utf8"),
      fs.stat(ap),
    ]);
    let originalMtime = 0;
    try { originalMtime = (await fs.stat(fullPath)).mtimeMs; } catch {}
    return { content, autosaveMtime: st.mtimeMs, originalMtime };
  } catch {
    return null;
  }
});
ipcMain.handle("dp2:delete-autosave", async (_e, fullPath) => {
  const ap = autosavePathFor(fullPath);
  try { await fs.unlink(ap); return true; } catch { return false; }
});

// Heavy-worker задачі: всю важку роботу робить worker_threads — main залишається responsive.
ipcMain.handle("dp2:build-tm-worker", async (_event, payload) => callHeavy("build-tm", payload));
ipcMain.handle("dp2:search-all-worker", async (_event, payload) => callHeavy("search-all", payload));
ipcMain.handle("dp2:corpus-stats-worker", async (_event, payload) => callHeavy("corpus-stats", payload));
ipcMain.handle("dp2:glossary-consistency-worker", async (_event, payload) => callHeavy("glossary-consistency", payload));
ipcMain.handle("dp2:batch-replace-worker", async (_event, payload) => callHeavy("batch-replace", payload));
ipcMain.handle("dp2:name-consistency-worker", async (_event, payload) => callHeavy("name-consistency", payload));
ipcMain.handle("dp2:file-counts-worker", async (_event, payload) => callHeavy("file-counts", payload));
ipcMain.handle("dp2:smart-break-all-worker", async (_event, payload) => callHeavy("smart-break-all", payload));
ipcMain.handle("dp2:rename-chara-worker", async (_event, payload) => callHeavy("rename-chara", payload));

// ── IPC: settings ────────────────────────────────────────────────
ipcMain.handle("dp2:get-settings", async () => readSettings());
ipcMain.handle("dp2:save-settings", async (_event, partial) => {
  const cur = await readSettings();
  const next = { ...cur, ...partial };
  await writeSettings(next);
  return next;
});

// ── IPC: setup / onboarding ──────────────────────────────────────
// Дефолти для setup-екрана: пропонуємо ~/Documents/DP2-Localization-Tools
// як корінь, де лежатимуть UABEA + PowerShell.
function getSetupDefaults() {
  const root = path.join(app.getPath("documents"), "DP2-Localization-Tools");
  return {
    toolsDir: root,
    // Стандартний шлях до DP2 у Steam Library. Може не існувати — користувач задасть свій.
    suggestedAssets: [
      "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Deadly Premonition 2\\DeadlyPremonition2_Data\\sharedassets0.assets",
      "D:\\SteamLibrary\\steamapps\\common\\Deadly Premonition 2\\DeadlyPremonition2_Data\\sharedassets0.assets",
      "E:\\SteamLibrary\\steamapps\\common\\Deadly Premonition 2\\DeadlyPremonition2_Data\\sharedassets0.assets",
    ],
  };
}

ipcMain.handle("dp2:setup-status", async () => {
  const raw = await readSettings();
  const defaults = getSetupDefaults();
  let completed = raw.setupCompleted === true;
  // Backwards-compat: користувачі попередніх версій уже мали налаштовані шляхи
  // через звичайний SettingsModal — не змушуємо їх проходити setup повторно.
  if (!("setupCompleted" in raw)) {
    if (raw.uabeaPath && raw.pwshPath && raw.assetsPath) completed = true;
  }
  return {
    completed,
    settings: {
      uabeaPath: raw.uabeaPath || "",
      pwshPath: raw.pwshPath || "",
      assetsPath: raw.assetsPath || "",
      lastFolder: raw.lastFolder || "",
      toolsDir: raw.toolsDir || "",
      recentFolders: Array.isArray(raw.recentFolders) ? raw.recentFolders : [],
    },
    defaults,
    validity: {
      uabeaPath: raw.uabeaPath ? fsSync.existsSync(raw.uabeaPath) : false,
      pwshPath: raw.pwshPath ? fsSync.existsSync(raw.pwshPath) : false,
      assetsPath: raw.assetsPath ? fsSync.existsSync(raw.assetsPath) : false,
      lastFolder: raw.lastFolder ? fsSync.existsSync(raw.lastFolder) : false,
    },
  };
});

ipcMain.handle("dp2:setup-reset", async () => {
  const raw = await readSettings();
  raw.setupCompleted = false;
  await writeSettings(raw);
  return { ok: true };
});

// Запуск setup-flow. Завантажує UABEA Next + PowerShell 7 у toolsDir.
// payload: { toolsDir, assetsPath, lastFolder, downloadUabea, downloadPwsh }
ipcMain.handle("dp2:setup-run", async (_e, payload) => {
  payload = payload || {};
  const toolsDir = String(payload.toolsDir || "").trim();
  if (!toolsDir) return { error: "toolsDir не задано" };

  sendSetupProgress({ phase: "check", i18nKey: "setup.progress.check" });

  try {
    await fs.mkdir(toolsDir, { recursive: true });
  } catch (e) {
    const msg = "Не вдалося створити tools-теку: " + (e.message || e);
    sendSetupProgress({ phase: "error", i18nKey: "setup.progress.mkdirFail", i18nParams: { err: String(e.message || e) }, message: msg });
    return { error: msg };
  }

  let uabeaPath = payload.uabeaPath || null;
  let pwshPath = payload.pwshPath || null;

  // ----- UABEA Next (nightly CI build via nightly.link) -----
  if (payload.downloadUabea) {
    try {
      const UABEA_URL = "https://nightly.link/nesrak1/UABEANext/workflows/build-windows/master/uabea-windows.zip";
      const assetName = "uabea-windows.zip";
      sendSetupProgress({ phase: "fetch", tool: "uabea", i18nKey: "setup.progress.fetch.uabea" });

      const destZip = path.join(toolsDir, assetName);
      sendSetupProgress({
        phase: "download", tool: "uabea",
        i18nKey: "setup.progress.downloading", i18nParams: { name: assetName },
        total: 0, downloaded: 0, percent: 0,
      });
      const res = await setupTools.downloadFile(UABEA_URL, destZip, (p) => {
        sendSetupProgress({
          phase: "download", tool: "uabea",
          i18nKey: "setup.progress.downloading", i18nParams: { name: assetName },
          total: p.total, downloaded: p.downloaded, percent: p.percent,
        });
      });

      const extractDir = path.join(toolsDir, "uabea");
      sendSetupProgress({ phase: "extract", tool: "uabea", i18nKey: "setup.progress.extract.uabea" });
      let needExtract = true;
      try {
        const items = await fs.readdir(extractDir);
        if (items.length && res.alreadyExisted) needExtract = false;
      } catch {}
      if (needExtract) {
        await fs.mkdir(extractDir, { recursive: true });
        await setupTools.extractZip(res.destPath, extractDir);
        await setupTools.flattenIfSingleSubdir(extractDir);
      }

      const exe = await setupTools.findExeInDir(extractDir, /uabea/i);
      if (!exe) throw new Error("UABEA*.exe not found in " + extractDir);
      uabeaPath = exe;
      sendSetupProgress({ phase: "done", tool: "uabea", i18nKey: "setup.progress.ready.uabea", i18nParams: { path: exe } });
    } catch (e) {
      const msg = "UABEA: " + (e.message || e);
      sendSetupProgress({ phase: "error", tool: "uabea", i18nKey: "setup.progress.fail.uabea", i18nParams: { err: String(e.message || e) }, message: msg });
      return { error: msg };
    }
  }

  // ----- PowerShell 7 portable -----
  if (payload.downloadPwsh) {
    try {
      sendSetupProgress({ phase: "fetch", tool: "pwsh", i18nKey: "setup.progress.fetch.pwsh" });
      const rel = await setupTools.fetchLatestRelease("PowerShell", "PowerShell");
      const asset = setupTools.pickAsset(
        rel.assets,
        (a) =>
          /\.zip$/i.test(a.name) &&
          /win-x64/i.test(a.name) &&
          !/preview|lts/i.test(a.name)
      ) || setupTools.pickAsset(rel.assets, (a) => /\.zip$/i.test(a.name) && /win-x64/i.test(a.name));
      if (!asset) throw new Error("No win-x64 .zip in release " + rel.tag);

      const destZip = path.join(toolsDir, asset.name);
      sendSetupProgress({
        phase: "download", tool: "pwsh",
        i18nKey: "setup.progress.downloading", i18nParams: { name: asset.name },
        total: asset.size, downloaded: 0, percent: 0,
      });
      const res = await setupTools.downloadFile(asset.url, destZip, (p) => {
        sendSetupProgress({
          phase: "download", tool: "pwsh",
          i18nKey: "setup.progress.downloading", i18nParams: { name: asset.name },
          total: p.total, downloaded: p.downloaded, percent: p.percent,
        });
      });

      const extractDir = path.join(toolsDir, "pwsh");
      sendSetupProgress({ phase: "extract", tool: "pwsh", i18nKey: "setup.progress.extract.pwsh" });
      let needExtract = true;
      try {
        const items = await fs.readdir(extractDir);
        if (items.length && res.alreadyExisted) needExtract = false;
      } catch {}
      if (needExtract) {
        await fs.mkdir(extractDir, { recursive: true });
        await setupTools.extractZip(res.destPath, extractDir);
        await setupTools.flattenIfSingleSubdir(extractDir);
      }

      const exe = await setupTools.findExeInDir(extractDir, /^pwsh\.exe$/i);
      if (!exe) throw new Error("pwsh.exe not found in " + extractDir);
      pwshPath = exe;
      sendSetupProgress({ phase: "done", tool: "pwsh", i18nKey: "setup.progress.ready.pwsh", i18nParams: { path: exe } });
    } catch (e) {
      const msg = "PowerShell: " + (e.message || e);
      sendSetupProgress({ phase: "error", tool: "pwsh", i18nKey: "setup.progress.fail.pwsh", i18nParams: { err: String(e.message || e) }, message: msg });
      return { error: msg };
    }
  }

  // ----- Persist settings -----
  sendSetupProgress({ phase: "persist", i18nKey: "setup.progress.persist" });
  const cur = await readSettings();
  const next = {
    ...cur,
    setupCompleted: true,
    toolsDir,
    ...(uabeaPath ? { uabeaPath } : {}),
    ...(pwshPath ? { pwshPath } : {}),
    ...(payload.assetsPath ? { assetsPath: payload.assetsPath } : {}),
    ...(payload.lastFolder ? { lastFolder: payload.lastFolder } : {}),
  };
  await writeSettings(next);

  sendSetupProgress({ phase: "done", i18nKey: "setup.progress.allDone" });
  return {
    ok: true,
    settings: {
      uabeaPath: next.uabeaPath || "",
      pwshPath: next.pwshPath || "",
      assetsPath: next.assetsPath || "",
      lastFolder: next.lastFolder || "",
      toolsDir: next.toolsDir,
    },
  };
});

// Спільний helper: знаходить pwsh.exe (settings → where.exe → null).
async function findPwsh(settings) {
  let p = settings.pwshPath || null;
  if (p) { try { await fs.access(p); } catch { p = null; } }
  if (!p) {
    p = await new Promise((resolve) => {
      const w = spawn("where.exe", ["pwsh.exe"], { windowsHide: true });
      let out = "";
      w.stdout.on("data", (d) => { out += d.toString(); });
      w.on("error", () => resolve(null));
      w.on("exit", (code) => {
        if (code === 0) {
          const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
          resolve(first || null);
        } else resolve(null);
      });
    });
  }
  return p;
}

// Helper: stream child stdout/stderr to renderer as progress events.
function streamChildOutput(child, channel) {
  function emit(line) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send(channel, line); } catch {}
    }
  }
  let outBuf = "", errBuf = "";
  child.stdout.on("data", (d) => {
    outBuf += d.toString();
    let i;
    while ((i = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, i).replace(/\r$/, "");
      outBuf = outBuf.slice(i + 1);
      if (line) emit(line);
    }
  });
  child.stderr.on("data", (d) => {
    errBuf += d.toString();
    let i;
    while ((i = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, i).replace(/\r$/, "");
      errBuf = errBuf.slice(i + 1);
      if (line) emit("[err] " + line);
    }
  });
  child.on("exit", () => {
    if (outBuf) emit(outBuf);
    if (errBuf) emit("[err] " + errBuf);
  });
}

// ── IPC: export 4 fonts з sharedassets0.assets у toolsDir/dp2-fonts/ ─────
ipcMain.handle("dp2:fonts-export", async () => {
  const settings = await readSettings();
  const { uabeaPath, assetsPath } = settings;
  if (!assetsPath) return { success: false, error: "Не задано шлях до .assets файла (Налаштування)" };
  if (!uabeaPath)  return { success: false, error: "Не задано шлях до UABEA" };

  let toolsDir = settings.toolsDir;
  if (!toolsDir) {
    toolsDir = path.join(app.getPath("documents"), "DP2-Localization-Tools");
    await writeSettings({ ...settings, toolsDir });
  }

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 (pwsh.exe) не знайдено" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/fonts-export.ps1");
  const outDir = path.join(toolsDir, "dp2-fonts");
  await fs.mkdir(outDir, { recursive: true });

  // У DP2 шрифти лежать у двох файлах: resources.assets (PathID 722-725) і
  // sharedassets0.assets (PathID 22522-22524). Інші sharedassets/globalgame*
  // шрифтів не містять — пропускаємо щоб не марнувати час.
  const gameDir = path.dirname(assetsPath);
  const candidates = ["resources.assets", "sharedassets0.assets"];
  const assetsTargets = [];
  for (const c of candidates) {
    const full = path.join(gameDir, c);
    try { await fs.access(full); assetsTargets.push(full); } catch {}
  }
  if (assetsTargets.length === 0) assetsTargets.push(assetsPath);

  const runOne = (assetsFile) => new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", assetsFile,
      "-OutDir", outDir,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    child.stdout.on("data", (d) => { allStdout += d.toString(); });
    streamChildOutput(child, "dp2:fonts-export-progress");
    child.on("error", (err) => resolve({ success: false, error: err.message, log: allStdout }));
    child.on("exit", (code) => {
      let exported = [];
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { exported = JSON.parse(m[1]); } catch {} }
      resolve({ success: code === 0, code, exported, log: allStdout });
    });
  });

  const allExported = [];
  const logs = [];
  for (const f of assetsTargets) {
    const r = await runOne(f);
    logs.push(`=== ${path.basename(f)} ===\n` + (r.log || ""));
    if (r.exported && r.exported.length) {
      for (const e of r.exported) allExported.push(e);
    }
  }
  return { success: true, outDir, exported: allExported, log: logs.join("\n\n") };
});

// ── IPC: replace single font in sharedassets0.assets ────────────────────
ipcMain.handle("dp2:fonts-replace", async (_e, payload) => {
  const { pathId, newFontPath, assetsFile } = payload || {};
  if (!pathId || !newFontPath) return { success: false, error: "Не задано pathId або шлях до нового шрифту" };
  const settings = await readSettings();
  const { uabeaPath, assetsPath } = settings;
  if (!assetsPath) return { success: false, error: "Не задано шлях до .assets файла" };
  if (!uabeaPath)  return { success: false, error: "Не задано шлях до UABEA" };

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 не знайдено" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/fonts-replace.ps1");

  // Якщо assetsFile задано — шукаємо у тій самій теці. Інакше — у resources.assets.
  const gameDir = path.dirname(assetsPath);
  const targetAssets = assetsFile
    ? path.join(gameDir, assetsFile)
    : assetsPath;

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", targetAssets,
      "-PathId", String(pathId),
      "-NewFontFile", newFontPath,
      "-OutputPath", targetAssets,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    child.stdout.on("data", (d) => { allStdout += d.toString(); });
    streamChildOutput(child, "dp2:fonts-replace-progress");
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-15).join("\n").trim();
        resolve({ success: false, error: (tail || `Exit ${code}`).trim(), log: allStdout });
        return;
      }
      resolve({ success: true, outputPath: targetAssets, log: allStdout });
    });
  });
});

// ── IPC: list уже-експортованих TTF у toolsDir/dp2-fonts/ + читати байти ─
ipcMain.handle("dp2:fonts-list", async () => {
  const settings = await readSettings();
  if (!settings.toolsDir) return { dir: null, files: [] };
  const dir = path.join(settings.toolsDir, "dp2-fonts");
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const files = items
      .filter((d) => d.isFile() && /\.(ttf|otf)$/i.test(d.name))
      .map((d) => ({ name: d.name, path: path.join(dir, d.name) }));
    return { dir, files };
  } catch {
    return { dir, files: [] };
  }
});

ipcMain.handle("dp2:fonts-read-base64", async (_e, filePath) => {
  try {
    const buf = await fs.readFile(filePath);
    return buf.toString("base64");
  } catch (e) {
    return null;
  }
});

// Зчитує zовнішній locale-файл з %APPDATA%/.../locales/{lang}.json. Якщо файлу
// немає або він невалідний — повертає null, app тоді використовує вбудований
// словник. Дозволяє користувачам додавати/правити переклади без перебудови.
ipcMain.handle("dp2:read-locale-file", async (_e, lang) => {
  try {
    if (typeof lang !== "string" || !/^[a-z]{2}$/.test(lang)) return null;
    const dir = path.join(app.getPath("userData"), "locales");
    const file = path.join(dir, `${lang}.json`);
    const raw = await fs.readFile(file, "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch { return null; }
});

// ── IPC: build .assets via PowerShell + AssetsTools.NET ─────────
// Один клік — отримуємо локалізований .assets файл поруч з оригіналом.
// Викликає import-to-assets.ps1, який імпортує всі JSON-дампи з теки
// у MonoBehaviour'и за PathID-збігом і записує новий .assets.
ipcMain.handle("dp2:build-assets", async () => {
  const settings = await readSettings();
  const { uabeaPath, assetsPath, lastFolder } = settings;
  if (!assetsPath) return { success: false, error: "Не задано шлях до .assets файла (Налаштування)" };
  if (!lastFolder) return { success: false, error: "Спочатку відкрий теку з JSON-дампами" };
  if (!uabeaPath)  return { success: false, error: "Не задано шлях до UABEA (для DLL та classdata.tpk)" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/import-to-assets.ps1");
  // Переписуємо оригінал на місці. Скрипт сам зробить бекап .bak (якщо ще немає).
  const outputPath = assetsPath;

  // PowerShell 7+ потрібен, бо AssetsTools.NET.Cpp2IL.dll зібраний під .NET 8.
  // Windows PowerShell 5.1 (.NET Framework 4.8) не може його завантажити.
  // 1) шлях з settings.pwshPath (Налаштування), 2) пошук через `where pwsh`.
  let pwshLookup = settings.pwshPath || null;
  if (pwshLookup) {
    try {
      await fs.access(pwshLookup);
    } catch {
      pwshLookup = null;
    }
  }
  if (!pwshLookup) {
    pwshLookup = await new Promise((resolve) => {
      const w = spawn("where.exe", ["pwsh.exe"], { windowsHide: true });
      let out = "";
      w.stdout.on("data", (d) => { out += d.toString(); });
      w.on("error", () => resolve(null));
      w.on("exit", (code) => {
        if (code === 0) {
          const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
          resolve(first || null);
        } else {
          resolve(null);
        }
      });
    });
  }

  if (!pwshLookup) {
    return {
      success: false,
      error:
        "PowerShell 7 (pwsh.exe) не знайдено.\n" +
        "Установи Store-версію: winget install --id 9MZ1SNWT0N5D\n" +
        "Або візьми portable ZIP з github.com/PowerShell/PowerShell/releases\n" +
        "і вкажи шлях до pwsh.exe у Налаштуваннях.",
    };
  }

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", assetsPath,
      "-JsonDir", lastFolder,
      "-OutputPath", outputPath,
      "-UabeaDir", uabeaDir,
    ];

    const child = spawn(pwshLookup, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", async (code) => {
      // Завжди пишемо повний лог поруч з .assets, щоб юзер міг його глянути.
      const logPath = path.join(path.dirname(assetsPath), "dp2-import.log");
      const ts = new Date().toISOString();
      const fullLog =
        `=== DP2 import @ ${ts} (exit=${code}) ===\n` +
        `assets: ${assetsPath}\n` +
        `jsonDir: ${lastFolder}\n` +
        `output: ${outputPath}\n\n` +
        `--- STDOUT ---\n${stdout}\n` +
        `--- STDERR ---\n${stderr}\n`;
      try { await fs.writeFile(logPath, fullLog, "utf8"); } catch {}

      if (code === 0) {
        resolve({ success: true, outputPath, logPath, log: fullLog });
      } else {
        // Показуємо stderr + останні 30 рядків stdout (DIAG/STEP включно).
        const tail = stdout.split("\n").slice(-30).join("\n").trim();
        const errMsg =
          (stderr.trim()
            ? stderr.trim() + (tail ? "\n\n--- last log lines ---\n" + tail : "")
            : tail) || `Exit code ${code}`;
        resolve({ success: false, error: errMsg, logPath, log: fullLog });
      }
    });
  });
});

// ── IPC: DP2 Textures (resources.assets + .resS in-place patch) ─────────
// Експорт усіх або вибраних PathID у PNG; заміна окремого PathID одним
// PNG-файлом. Скрипти кодекують DXT5/BC через UABEA native libs.

ipcMain.handle("dp2:textures-export", async (_e, payload) => {
  const settings = await readSettings();
  const { uabeaPath } = settings;
  const assetsFile = (payload && payload.assetsFile) || "resources.assets";
  const pathIds = (payload && Array.isArray(payload.pathIds)) ? payload.pathIds : null;
  if (!settings.assetsPath) return { success: false, error: "Не задано шлях до .assets файла (Налаштування)" };
  if (!uabeaPath) return { success: false, error: "Не задано шлях до UABEA" };

  // resources.assets лежить у тій самій теці, що sharedassets0.assets
  // (settings.assetsPath). Тож беремо parent dir + assetsFile.
  const gameDir = path.dirname(settings.assetsPath);
  const fullAssets = path.join(gameDir, assetsFile);
  try { await fs.access(fullAssets); }
  catch { return { success: false, error: ".assets не знайдено: " + fullAssets }; }

  let toolsDir = settings.toolsDir;
  if (!toolsDir) {
    toolsDir = path.join(app.getPath("documents"), "DP2-Localization-Tools");
    await writeSettings({ ...settings, toolsDir });
  }
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 не знайдено" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/textures-export.ps1");
  const outDir = path.join(toolsDir, "dp2-textures");
  await fs.mkdir(outDir, { recursive: true });

  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-AssetsPath", fullAssets,
    "-OutDir", outDir,
    "-UabeaDir", uabeaDir,
  ];
  if (pathIds && pathIds.length) {
    args.push("-PathIds", pathIds.join(","));
  }

  return await new Promise((resolve) => {
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    child.stdout.on("data", (d) => { allStdout += d.toString(); });
    child.stderr.on("data", (d) => { allStdout += d.toString(); });
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        resolve({ success: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let exported = [];
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { exported = JSON.parse(m[1]); } catch {} }
      resolve({ success: true, outDir, exported, log: allStdout });
    });
  });
});

ipcMain.handle("dp2:textures-replace", async (_e, payload) => {
  const settings = await readSettings();
  const { uabeaPath } = settings;
  const pathId = payload && payload.pathId;
  const assetsFile = (payload && payload.assetsFile) || "resources.assets";
  const newPngPath = payload && payload.newPngPath;
  if (!settings.assetsPath) return { success: false, error: "Не задано шлях до .assets файла" };
  if (!uabeaPath) return { success: false, error: "Не задано шлях до UABEA" };
  if (!pathId || !newPngPath) return { success: false, error: "Не задано pathId або PNG-шлях" };

  const gameDir = path.dirname(settings.assetsPath);
  const fullAssets = path.join(gameDir, assetsFile);
  try { await fs.access(fullAssets); }
  catch { return { success: false, error: ".assets не знайдено: " + fullAssets }; }
  try { await fs.access(newPngPath); }
  catch { return { success: false, error: "PNG не знайдено: " + newPngPath }; }

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 не знайдено" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/textures-replace.ps1");

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", fullAssets,
      "-PathId", String(pathId),
      "-NewPngFile", newPngPath,
      "-OutputPath", fullAssets,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    let leftover = "";
    const win = BrowserWindow.getAllWindows()[0];
    const emit = (chunk) => {
      allStdout += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { win?.webContents.send("dp2:textures-replace-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:textures-replace-progress", leftover); } catch {}
      }
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        resolve({ success: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let result = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { result = JSON.parse(m[1]); } catch {} }
      resolve({ success: true, log: allStdout, ...result });
    });
  });
});

// Список наявних PNG-екстрактів у toolsDir/dp2-textures/ + read base64 для прев'ю.
ipcMain.handle("dp2:textures-list", async () => {
  const settings = await readSettings();
  if (!settings.toolsDir) return { dir: null, files: [] };
  const dir = path.join(settings.toolsDir, "dp2-textures");
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    const files = items
      .filter((e) => e.isFile() && /\.png$/i.test(e.name))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
    return { dir, files };
  } catch {
    return { dir, files: [] };
  }
});

ipcMain.handle("dp2:textures-read-base64", async (_e, filePath) => {
  try {
    const buf = await fs.readFile(filePath);
    return buf.toString("base64");
  } catch { return null; }
});

// ── IPC: TGL Fonts (atlas + character rects JSON) ───────────────────────
// Шрифт у грі — два файла поряд у StreamingAssets/<dir>/:
//   ChiaroStd-B-CAB-XXXX--<negPathId>.json — поля m_CharacterRects, m_Texture, …
//   Font Texture-CAB-XXXX--<negPathId>.png — atlas PNG (зазвичай 2048×2048).

// Витягнути m_Texture.m_PathID з RAW тексту JSON (без JSON.parse), щоб
// зберегти 64-бітну точність — JavaScript number втрачає її для значень >2^53.
function extractTextureRawPathId(raw) {
  // Шукаємо блок "m_Texture": { ... "m_PathID": <num> ... }
  const idx = raw.indexOf('"m_Texture"');
  if (idx < 0) return null;
  // У наступних ~200 байтах має лежати m_PathID цього об'єкту.
  const slice = raw.slice(idx, idx + 400);
  const m = slice.match(/"m_PathID"\s*:\s*(-?\d+)/);
  return m ? m[1] : null;
}

async function findTglFonts(baseFolder, dbgReject) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 3) return;
    let items;
    try { items = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    const jsonsHere = [];
    const pngsHere = [];
    for (const e of items) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (/\.json$/i.test(e.name)) jsonsHere.push(full);
      else if (/\.png$/i.test(e.name)) pngsHere.push(full);
    }
    for (const jsonPath of jsonsHere) {
      let raw = "";
      try { raw = await fs.readFile(jsonPath, "utf8"); }
      catch (e) { if (dbgReject) dbgReject.push({ file: path.basename(jsonPath), why: "read-fail", err: String(e.message || e) }); continue; }
      // UTF-8 BOM (﻿) ламає JSON.parse — обрізаємо.
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      if (!/"m_CharacterRects"\s*:/.test(raw)) {
        if (dbgReject) dbgReject.push({ file: path.basename(jsonPath), why: "no-m_CharacterRects-regex", size: raw.length, head: raw.slice(0, 80) });
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { if (dbgReject) dbgReject.push({ file: path.basename(jsonPath), why: "JSON.parse-fail", err: String(e.message || e), size: raw.length, head: raw.slice(0, 60) }); continue; }
      if (!parsed?.m_CharacterRects?.Array) {
        if (dbgReject) dbgReject.push({ file: path.basename(jsonPath), why: "no-Array-field", hasMCR: !!parsed?.m_CharacterRects, mcrKeys: parsed?.m_CharacterRects ? Object.keys(parsed.m_CharacterRects).join(",") : "(none)" });
        continue;
      }
      const name = String(parsed.m_Name || path.basename(jsonPath, ".json"));
      const fontSize = Number(parsed.m_FontSize) || 0;
      const lineSpacing = Number(parsed.m_LineSpacing) || 0;
      const charCount = parsed.m_CharacterRects.Array.length;
      // PNG-mapping: беремо PathID з raw і шукаємо PNG, в імені якого є
      // abs(pathId) як decimal suffix. PathID 64-bit → завжди порівнюємо як string.
      let texPathId = extractTextureRawPathId(raw);
      let atlasPath = null;
      if (texPathId) {
        const absStr = texPathId.replace(/^-/, "");
        for (const png of pngsHere) {
          const m = path.basename(png).match(/(-?\d{10,})\.png$/i);
          if (m && m[1].replace(/^-/, "") === absStr) { atlasPath = png; break; }
        }
      }
      if (!atlasPath && pngsHere.length === 1) atlasPath = pngsHere[0];
      out.push({
        jsonPath, atlasPath,
        name, fontSize, lineSpacing, charCount,
        texPathId,
        baseDir: path.dirname(jsonPath),
      });
    }
  }
  await walk(baseFolder, 0);
  return out;
}

ipcMain.handle("dp2:tgl-fonts-list", async () => {
  const settings = await readSettings();
  const binPath = settings.tglBinPath;
  const items = [];
  let baseFolder = null;
  const dbg = { toolsDir: settings.toolsDir || null, binPath: binPath || null, scans: [] };
  if (binPath) {
    const streamingAssets = path.dirname(path.dirname(binPath));
    baseFolder = streamingAssets;
    try {
      await fs.access(streamingAssets);
      const sa = await findTglFonts(streamingAssets);
      dbg.scans.push({ dir: streamingAssets, found: sa.length });
      for (const e of sa) items.push(e);
    } catch (e) {
      dbg.scans.push({ dir: streamingAssets, error: String(e.message || e) });
    }
  }
  if (settings.toolsDir) {
    const extractDir = path.join(settings.toolsDir, "tgl-fonts");
    try {
      await fs.access(extractDir);
      const dirEntries = await fs.readdir(extractDir, { withFileTypes: true });
      const files = dirEntries.filter((e) => e.isFile()).map((e) => e.name);
      const rejects = [];
      const extra = await findTglFonts(extractDir, rejects);
      dbg.scans.push({ dir: extractDir, files, found: extra.length, rejects });
      for (const e of extra) items.push(e);
    } catch (e) {
      dbg.scans.push({ dir: extractDir, error: String(e.message || e) });
    }
  }
  return { items, baseFolder, debug: dbg };
});

ipcMain.handle("dp2:tgl-fonts-read-json", async (_e, jsonPath) => {
  // Heavy parse (11 MB JSON для NotoSansSC) виносимо у worker thread, щоб
  // не блокувати main process на 500-800ms. Renderer отримує вже parsed.
  try {
    const r = await callHeavy("tgl-font-parse", { jsonPath });
    return { ok: true, raw: r.raw, data: r.data, charsSection: r.charsSection };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("dp2:tgl-fonts-write-json", async (_e, payload) => {
  const { jsonPath, content } = payload || {};
  if (!jsonPath || typeof content !== "string") return { ok: false, error: "bad args" };
  try {
    const bak = jsonPath + ".bak";
    try { await fs.access(bak); }
    catch { await fs.copyFile(jsonPath, bak); }
    await fs.writeFile(jsonPath, content, "utf8");
    return { ok: true, bakPath: bak };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle("dp2:tgl-fonts-read-atlas-base64", async (_e, pngPath) => {
  try {
    const buf = await fs.readFile(pngPath);
    return { ok: true, base64: buf.toString("base64") };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Extract Font + Texture from a CAB-file inside TGL StreamingAssets.
ipcMain.handle("dp2:tgl-fonts-extract", async (_e, payload) => {
  const cabPath = String((payload && payload.cabPath) || "").trim();
  if (!cabPath) return { ok: false, error: "cabPath не задано" };
  try { await fs.access(cabPath); }
  catch { return { ok: false, error: "CAB не знайдено: " + cabPath }; }

  const settings = await readSettings();
  const uabeaPath = settings.uabeaPath;
  if (!uabeaPath) return { ok: false, error: "UABEA шлях не задано (Налаштування)" };
  const uabeaDir = path.dirname(uabeaPath);

  let toolsDir = settings.toolsDir;
  if (!toolsDir) {
    toolsDir = path.join(app.getPath("documents"), "DP2-Localization-Tools");
  }
  // Запам'ятовуємо cabPath, щоб наступного разу не запитувати — toolsDir теж.
  try { await writeSettings({ ...settings, toolsDir, tglCabPath: cabPath }); } catch {}
  const outDir = path.join(toolsDir, "tgl-fonts");
  await fs.mkdir(outDir, { recursive: true });

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const scriptPath = resolveResource("scripts/tgl-fonts-extract.ps1");

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-CabPath", cabPath,
      "-OutDir", outDir,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    child.stdout.on("data", (d) => { allStdout += d.toString(); });
    child.stderr.on("data", (d) => { allStdout += d.toString(); });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let exported = [];
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { exported = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, outDir, exported, log: allStdout });
    });
  });
});

// Import Font JSON + atlas PNG back into the game CAB file.
ipcMain.handle("dp2:tgl-fonts-import-to-cab", async (_e, payload) => {
  const cabPath = String((payload && payload.cabPath) || "").trim();
  const jsonPath = String((payload && payload.jsonPath) || "").trim();
  const pngPath = String((payload && payload.pngPath) || "").trim();
  if (!cabPath || !jsonPath || !pngPath) return { ok: false, error: "cabPath/jsonPath/pngPath обов'язкові" };
  try { await fs.access(cabPath); await fs.access(jsonPath); await fs.access(pngPath); }
  catch (e) { return { ok: false, error: "Файл не знайдено: " + (e.message || e) }; }

  const settings = await readSettings();
  // Запам'ятовуємо cabPath на майбутнє.
  if (settings.tglCabPath !== cabPath) {
    try { await writeSettings({ ...settings, tglCabPath: cabPath }); } catch {}
  }
  const uabeaPath = settings.uabeaPath;
  if (!uabeaPath) return { ok: false, error: "UABEA шлях не задано" };
  const uabeaDir = path.dirname(uabeaPath);
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const scriptPath = resolveResource("scripts/tgl-fonts-import.ps1");

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-CabPath", cabPath,
      "-FontJsonPath", jsonPath,
      "-AtlasPngPath", pngPath,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    let leftover = "";
    const win = BrowserWindow.getAllWindows()[0];
    const emit = (chunk) => {
      allStdout += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { win?.webContents.send("dp2:tgl-fonts-import-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:tgl-fonts-import-progress", leftover); } catch {}
      }
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-25).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let result = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { result = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, log: allStdout, ...result });
    });
  });
});

ipcMain.handle("dp2:tgl-fonts-write-atlas-base64", async (_e, payload) => {
  const { pngPath, base64 } = payload || {};
  if (!pngPath || typeof base64 !== "string") return { ok: false, error: "bad args" };
  try {
    const bak = pngPath + ".bak";
    try { await fs.access(bak); }
    catch { await fs.copyFile(pngPath, bak); }
    await fs.writeFile(pngPath, Buffer.from(base64, "base64"));
    return { ok: true, bakPath: bak };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ── IPC: TGL (The Good Life) — всі важкі операції у heavy-worker ────────
// Binary parsing + workfile read/write + pack делегуються worker_threads
// (scripts/heavy-worker.cjs), щоб не блокувати main process. Тут лишається
// лише валідація шляхів і апдейт settings.

ipcMain.handle("dp2:tgl-load", async (_event, binPath) => {
  if (!binPath) return { error: "binPath не задано" };
  try { await fs.access(binPath); }
  catch { return { error: "Файл не знайдено: " + binPath }; }
  try {
    const r = await callHeavy("tgl-load", { binPath });
    try { await writeSettings({ ...(await readSettings()), tglBinPath: binPath }); } catch {}
    return { ok: true, ...r };
  } catch (e) {
    return { error: "Не вдалося завантажити: " + (e.message || e) };
  }
});

ipcMain.handle("dp2:tgl-save-workfile", async (_event, payload) => {
  const binPath = String((payload && payload.binPath) || "").trim();
  const ua = (payload && payload.ua) || [];
  if (!binPath) return { error: "binPath не задано" };
  try {
    const r = await callHeavy("tgl-save-workfile", { binPath, ua });
    return { ok: true, ...r };
  } catch (e) {
    return { error: "Не вдалося зберегти workfile: " + (e.message || e) };
  }
});

ipcMain.handle("dp2:tgl-pack", async (_event, payload) => {
  const binPath = String((payload && payload.binPath) || "").trim();
  const ua = (payload && payload.ua) || [];
  if (!binPath) return { error: "binPath не задано" };
  try {
    const r = await callHeavy("tgl-pack", { binPath, ua });
    return { ok: true, ...r };
  } catch (e) {
    return { error: "Не вдалося запакувати: " + (e.message || e) };
  }
});

// ── IPC: DP1 pack pipeline ───────────────────────────────────────
// Кроки:
//   1. Прочитати _ua_done.json (вже згенерований store'ом DP1).
//   2. Застосувати rename-мапу (кирилиця → латинські гліфи DP-шрифту).
//      Результат запишемо у _ua_done.replaced.json поруч.
//   3. Викликати DPMsgTool.exe from-json <replaced.json> <outDir>.
//   4. Знайти результуючий *_new.mes → перейменувати/перенести у game dir
//      як mes_all.mes (поведінка bat-скрипта з оригінального DPMsgTool).
const CYR_MAP = {
  "О":"O","о":"o","А":"A","а":"a","Р":"P","р":"p","С":"C","с":"c","М":"M",
  "В":"B","Е":"E","е":"e","Н":"H","Т":"T","І":"I","і":"i","Ї":"Í","ї":"ï",
  "Х":"X","х":"x","у":"y","Б":"Ô","Г":"¿","Ґ":"Ù","Д":"Á","Є":"Â","Ж":"Ã",
  "З":"Ä","И":"Å","Й":"Æ","К":"Ç","Л":"È","П":"É","У":"Ê","Ф":"Ë","Ц":"Ì",
  "Ч":"Î","Ш":"Ï","Щ":"Ð","Ь":"Ñ","Ю":"Ò","Я":"Ó","б":"à","в":"á","г":"â",
  "ґ":"ã","д":"ä","є":"å","ж":"æ","з":"ç","и":"è","й":"é","к":"ê","л":"ë",
  "м":"ì","н":"í","п":"î","т":"ú","ф":"ñ","ц":"ò","ч":"ó","ш":"ô","щ":"õ",
  "я":"ù","ю":"ø","ь":"û","—":"Ú","’":"'",
};
function applyCyrMap(s) {
  if (typeof s !== "string" || !s) return s;
  let out = "";
  for (const ch of s) out += (CYR_MAP[ch] != null ? CYR_MAP[ch] : ch);
  return out;
}

ipcMain.handle("dp2:dp1-pack", async (_event, payload) => {
  const donePath = String((payload && payload.donePath) || "").trim();
  if (!donePath) return { error: "donePath не задано" };

  const settings = await readSettings();
  const toolPath = settings.dp1ToolPath;
  const gameDir = settings.dp1GameDir;
  if (!toolPath) return { error: "Не задано шлях до DPMsgTool.exe (Налаштування DP1)" };
  try { await fs.access(toolPath); } catch { return { error: "DPMsgTool.exe не знайдено: " + toolPath }; }

  // 1) Завантажити _ua_done.json
  let records;
  try {
    const raw = await fs.readFile(donePath, "utf8");
    records = JSON.parse(raw);
    if (!Array.isArray(records)) throw new Error("Очікується масив записів");
  } catch (e) {
    return { error: "Не вдалося прочитати " + donePath + ": " + (e.message || e) };
  }

  // 2) Застосувати rename-мапу і зберегти у _ua_done.replaced.json
  const replaced = records.map((r) => ({ ...r, Text: applyCyrMap(r.Text) }));
  const replacedPath = donePath.replace(/\.json$/i, ".replaced.json");
  try {
    await fs.writeFile(replacedPath, JSON.stringify(replaced, null, 2), "utf8");
  } catch (e) {
    return { error: "Не вдалося записати " + replacedPath + ": " + (e.message || e) };
  }

  // 3) Викликати DPMsgTool.exe from-json
  const toolDir = path.dirname(toolPath);
  const outDir = toolDir; // DPMsgTool пише поруч з замінений json
  const result = await new Promise((resolve) => {
    const args = ["from-json", replacedPath, outDir];
    const child = spawn(toolPath, args, { windowsHide: true, cwd: toolDir });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    return {
      error: "DPMsgTool exit=" + result.code + ":\n" + (result.stderr || result.stdout || "").trim(),
    };
  }

  // 4) Знайти результуючий .mes (за угодою з batch скрипту: <base>_new.mes)
  const baseName = path.basename(replacedPath, ".json");
  const candidate1 = path.join(outDir, baseName + "_new.mes");
  const candidate2 = path.join(outDir, baseName + ".mes");
  let mesPath = null;
  for (const p of [candidate1, candidate2]) {
    try { await fs.access(p); mesPath = p; break; } catch {}
  }
  if (!mesPath) {
    // Шукаємо будь-який *_new.mes у outDir
    try {
      const items = await fs.readdir(outDir);
      const found = items.find((n) => /_new\.mes$/i.test(n));
      if (found) mesPath = path.join(outDir, found);
    } catch {}
  }
  if (!mesPath) {
    return { error: "Не знайшов результуючий .mes після DPMsgTool у " + outDir };
  }

  // 5) Перенести у gameDir як mes_all.mes (якщо gameDir заданий)
  let outputPath = mesPath;
  if (gameDir) {
    try {
      await fs.mkdir(gameDir, { recursive: true });
      const target = path.join(gameDir, "mes_all.mes");
      await fs.rename(mesPath, target);
      outputPath = target;
    } catch (e) {
      return {
        error: "DPMsgTool ОК, але перенесення в " + gameDir + " не вдалось: " + (e.message || e),
        intermediatePath: mesPath,
      };
    }
  }

  return { ok: true, outputPath, intermediatePath: mesPath };
});

// ── IPC: launch UABEA Next ───────────────────────────────────────
ipcMain.handle("dp2:launch-uabea", async () => {
  const settings = await readSettings();
  const uabeaPath = settings.uabeaPath;
  if (!uabeaPath) return { success: false, error: "UABEA path not set" };
  try {
    await fs.access(uabeaPath);
  } catch {
    return { success: false, error: `UABEA не знайдено: ${uabeaPath}` };
  }
  try {
    const child = spawn(uabeaPath, [], {
      detached: true,
      stdio: "ignore",
      cwd: path.dirname(uabeaPath),
    });
    child.unref();
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
});

// ── IPC: open folder in explorer ─────────────────────────────────
ipcMain.handle("dp2:open-folder", async (_event, folder) => {
  if (folder) await shell.openPath(folder);
});

app.whenReady().then(async () => {
  // Pre-warm heavy worker одразу при старті — щоб перший таск не платив
  // ~200ms cold-start lag.
  try { getHeavyWorker(); } catch {}
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
