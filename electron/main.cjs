// Electron main process — створює вікно, обробляє IPC для file system,
// запускає UABEA Next для зворотнього імпорту JSON у .assets.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");

// Фіксуємо назву додатку ДО першого виклику app.getPath() — інакше папка
// у %APPDATA% буде з імені у package.json ("deadly-premonition-..."), а ми
// хочемо "SWERY Localization Tool".
app.setName("SWERY Localization Tool");

// Прибираємо стандартне меню Electron, щоб не перехоплювало Monaco shortcuts
// (Ctrl+F, Ctrl+H, Ctrl+G тощо).
Menu.setApplicationMenu(null);
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
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
    const obj = JSON.parse(raw);
    // Авто-резолв конкретних шляхів з кореневих тек ігор. Користувач у
    // onboarding step 3 вказує корінь Steam-теки гри — звідти обчислюємо
    // assetsPath / tglBinPath, якщо вони ще не задані явно.
    if (!obj.assetsPath && obj.dp2Root) {
      const cand1 = path.join(obj.dp2Root, "DeadlyPremonition2_Data", "sharedassets0.assets");
      const cand2 = path.join(obj.dp2Root, "sharedassets0.assets");
      try { await fs.access(cand1); obj.assetsPath = cand1; }
      catch {
        try { await fs.access(cand2); obj.assetsPath = cand2; } catch {}
      }
    }
    // TGL: загальний резолвер StreamingAssets — пробуємо кілька варіантів,
    // бо користувач міг вказати або корінь Steam-теки, або одразу _Data, або
    // прямо StreamingAssets.
    async function resolveTglStreamingAssets(root) {
      const cands = [
        path.join(root, "StandaloneWindows64_Data", "StreamingAssets"),
        path.join(root, "StreamingAssets"),
        root,
      ];
      for (const c of cands) {
        try { await fs.access(c); return c; } catch {}
      }
      return null;
    }
    // Hotel Barcelona: AAA-bundle із MonoBehaviour-текстами. Хеш у назві
    // змінюється при кожному патчі гри, тому: спочатку перевіряємо валідність
    // збереженого шляху (файл міг зникнути після оновлення), потім швидкий
    // candidate з відомого хешу, далі — wildcard-сканування теки.
    if (obj.hbrBundlePath) {
      try { await fs.access(obj.hbrBundlePath); } catch { obj.hbrBundlePath = undefined; }
    }
    if (!obj.hbrBundlePath && obj.hbrRoot) {
      const subDir = path.join(obj.hbrRoot, "HOTEL BARCELONA_Data", "StreamingAssets", "aa", "StandaloneWindows64");
      const fixedCand = path.join(subDir, "_resources_assets_all_0d63e41486d027f2e31ca9d62cbfb661.bundle");
      try { await fs.access(fixedCand); obj.hbrBundlePath = fixedCand; }
      catch {
        try {
          const entries = await fs.readdir(subDir);
          const match = entries.find((n) => /^_resources_assets_all_.+\.bundle$/i.test(n));
          if (match) obj.hbrBundlePath = path.join(subDir, match);
        } catch {}
      }
    }
    // THE MISSING: resources.assets живе у TheMISSING_Data/ (повна гра)
    // або TheMISSING_Demo_Data/ (демо). Користувач у onboarding вказує корінь
    // Steam-теки, далі ми резолвимо самі.
    if (!obj.missingAssetsPath && obj.missingRoot) {
      const cands = [
        path.join(obj.missingRoot, "TheMISSING_Data", "resources.assets"),
        path.join(obj.missingRoot, "TheMISSING_Demo_Data", "resources.assets"),
        path.join(obj.missingRoot, "resources.assets"),
      ];
      for (const c of cands) { try { await fs.access(c); obj.missingAssetsPath = c; break; } catch {} }
    }
    if (obj.tglRoot && (!obj.tglBinPath || !obj.tglCabPath)) {
      const saDir = await resolveTglStreamingAssets(obj.tglRoot);
      if (saDir) {
        // Текст: loc/English (без розширення).
        if (!obj.tglBinPath) {
          const eng = path.join(saDir, "loc", "English");
          try { await fs.access(eng); obj.tglBinPath = eng; } catch {}
        }
        // Шрифт: bundle з ChiaroStd-B — це КОНКРЕТНО `c0718fc478f6943d`
        // у StreamingAssets. У теці є кілька hex-named bundle'ів (шрифти
        // інших активів типу `font_flamingo_pound_digits`), нам потрібен
        // саме цей файл, тому НЕ вгадуємо за розміром.
        if (!obj.tglCabPath) {
          const fontBundle = path.join(saDir, "c0718fc478f6943d");
          try { await fs.access(fontBundle); obj.tglCabPath = fontBundle; } catch {}
        }
      }
    }
    return obj;
  } catch {
    return {};
  }
}

async function writeSettings(next) {
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
}

// ── File guards: write queue + system-path deny ────────────────────────
// Окремий чейн Promise на кожен path — гарантує що одночасні writes
// (manual save + autosave + bulk patch) серіалізуються і .bak/atomic-rename
// не race-аться. Map авточиститься, коли остання задача завершується.
const _fileLocks = new Map();
function withFileLock(filePath, fn) {
  const key = path.resolve(filePath).toLowerCase();
  const prev = _fileLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  _fileLocks.set(key, next);
  next.finally(() => { if (_fileLocks.get(key) === next) _fileLocks.delete(key); }).catch(() => {});
  return next;
}

// Системні директорії, у які renderer ніколи не повинен писати.
// Дозволено все інше — щоб не зламати ігрові теки на нестандартних дисках.
const _denyRoots = (() => {
  const list = [
    process.env.SystemRoot || "C:\\Windows",
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramData || "C:\\ProgramData",
  ];
  return list.filter(Boolean).map((p) => path.resolve(p).toLowerCase());
})();
function assertSafeWritePath(p) {
  if (!p || typeof p !== "string") throw new Error("invalid path");
  const resolved = path.resolve(p);
  const lower = resolved.toLowerCase();
  for (const deny of _denyRoots) {
    if (lower === deny || lower.startsWith(deny + path.sep)) {
      throw new Error(`refused: system path "${resolved}"`);
    }
  }
  return resolved;
}

// Allow-list ключів settings, які renderer має право писати через
// dp2:save-settings. Усе інше — main-driven (setupCompleted, recentFolders,
// update cache, auto-resolved game paths) — і renderer не повинен мати
// можливість їх отруїти.
const RENDERER_ALLOWED_KEYS = new Set([
  "lastFolder", "assetsPath", "uabeaPath", "pwshPath", "toolsDir",
  "dp1EngPath", "tglBinPath", "tglTxtPath",
  "tglMonoBundlePath", "tglMonoOutDir", "tglMonoFilter",
  "dp2LastFile",
  "dp1Root", "dp2Root", "tglRoot", "hbrRoot", "missingRoot", "d4Root",
  "autosaveDir", "autosaveIntervalMin",
  "recentItemsDismissed", "hbrFontsGuideSeen",
  "dismissedUpdateVersion",
  "locale", "theme",
]);
function filterRendererSettings(partial) {
  if (!partial || typeof partial !== "object") return {};
  const out = {};
  for (const k of Object.keys(partial)) {
    if (RENDERER_ALLOWED_KEYS.has(k)) out[k] = partial[k];
    else console.warn(`[settings] renderer attempted to write disallowed key: ${k}`);
  }
  return out;
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
    title: "SWERY Localization Tool",
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
// Глобальний хелпер: викликається з усіх місць (DP2 fonts/textures, TGL,
// onboarding paths). За замовч. — нейтральний title; callers, яким треба
// специфічний підпис, передають `{ title: "..." }`.
ipcMain.handle("dp2:pick-folder", async (_e, opts) => {
  const title = (opts && typeof opts.title === "string" && opts.title.trim()) || "Виберіть теку";
  const result = await dialog.showOpenDialog({
    title,
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
// Серіалізовано через withFileLock: гарантує що паралельні save + autosave
// для одного файла не race-аться на створенні .bak (старіший reader міг
// прочитати вже модифікований currentTree → .bak застиг не-original).
ipcMain.handle("dp2:write-file", async (_event, fullPath, content) => {
  const safe = assertSafeWritePath(fullPath);
  const bakPath = safe.replace(/\.json$/i, ".bak.json");
  return withFileLock(safe, async () => {
    try {
      await fs.access(bakPath);
    } catch {
      try {
        const original = await fs.readFile(safe, "utf8");
        await fs.writeFile(bakPath, original, "utf8");
      } catch (e) {
        console.warn("Failed to create .bak:", e);
      }
    }
    await fs.writeFile(safe, content, "utf8");
    return true;
  });
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
// Шлях до autosave-файла. За замовчуванням — sidecar поряд з оригіналом
// (`<file>.autosave.json`). Якщо у settings задана окрема директорія
// `autosaveDir` — пишемо туди з flat-іменем, де колізії неможливі завдяки
// hash повного шляху джерела.
async function autosavePathFor(fullPath) {
  try {
    const settings = await readSettings();
    const dir = settings?.autosaveDir;
    if (dir && typeof dir === "string" && dir.trim()) {
      try { await fs.mkdir(dir, { recursive: true }); } catch {}
      const crypto = require("node:crypto");
      const hash = crypto.createHash("sha1").update(fullPath).digest("hex").slice(0, 10);
      const base = path.basename(fullPath).replace(/\.json$/i, "");
      return path.join(dir, `${base}.${hash}.autosave.json`);
    }
  } catch {}
  return fullPath.replace(/\.json$/i, ".autosave.json");
}
ipcMain.handle("dp2:write-autosave", async (_e, fullPath, content) => {
  assertSafeWritePath(fullPath);
  const dest = await autosavePathFor(fullPath);
  assertSafeWritePath(dest);
  return withFileLock(dest, async () => {
    await fs.writeFile(dest, content, "utf8");
    return dest;
  });
});
ipcMain.handle("dp2:read-autosave", async (_e, fullPath) => {
  const ap = await autosavePathFor(fullPath);
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
  assertSafeWritePath(fullPath);
  const ap = await autosavePathFor(fullPath);
  assertSafeWritePath(ap);
  return withFileLock(ap, async () => {
    try { await fs.unlink(ap); return true; } catch { return false; }
  });
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
  // 1) renderer пише тільки allow-listed ключі — uabeaPath/pwshPath/toolsDir
  //    тощо є чутливими (керують spawn-командами), тому не приймаємо довільні.
  // 2) read-merge-write серіалізуємо через withFileLock — інакше дві паралельні
  //    saveSettings (з різних modal-ів або autosave-pathchange + manual)
  //    можуть прочитати один стан і записати конкуруючі мерджи.
  const filtered = filterRendererSettings(partial);
  return withFileLock(settingsPath(), async () => {
    const cur = await readSettings();
    const next = { ...cur, ...filtered };
    await writeSettings(next);
    return next;
  });
});

// ── IPC: setup / onboarding ──────────────────────────────────────
// Дефолти для setup-екрана: пропонуємо ~/Documents/SWERY-Localization-Tool
// як корінь, де лежатимуть UABEA + PowerShell.
function getSetupDefaults() {
  const root = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
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

ipcMain.handle("dp2:setup-reset", async (_e, payload) => {
  const opts = payload || {};
  const wipedPaths = [];
  // Soft reset (default): просто знімаємо прапор завершеного setup'у —
  // зберігає шляхи до гри, UABEA, всі recents.
  if (!opts.full && !opts.wipeTools) {
    const raw = await readSettings();
    raw.setupCompleted = false;
    await writeSettings(raw);
    return { ok: true, mode: "soft", wipedPaths };
  }
  // Full reset: видаляємо settings.json повністю, опціонально toolsDir.
  if (opts.full) {
    try {
      await fs.unlink(settingsPath());
      wipedPaths.push(settingsPath());
    } catch {}
  }
  if (opts.wipeTools) {
    try {
      const cur = (await readSettings().catch(() => ({}))) || {};
      const defaultDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
      const dir = cur.toolsDir || defaultDir;
      // Захист: видаляємо ТІЛЬКИ якщо це SWERY-Localization-Tool тека або
      // вкладена. Інакше отруєний toolsDir (через старий settings.json без
      // allow-list) міг би видалити C:\, %USERPROFILE% тощо.
      const resolved = path.resolve(dir);
      const allowed = path.resolve(defaultDir);
      const inSweryRoot =
        resolved === allowed ||
        resolved.toLowerCase().startsWith(allowed.toLowerCase() + path.sep);
      if (!inSweryRoot) {
        return { ok: false, error: `refused wipe: ${resolved} outside SWERY-Localization-Tool root` };
      }
      assertSafeWritePath(resolved);
      await fs.rm(resolved, { recursive: true, force: true });
      wipedPaths.push(resolved);
    } catch (e) {
      console.warn("wipeTools failed:", e);
    }
  }
  return { ok: true, mode: "full", wipedPaths };
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

// ── DP2 Others (переклад інших рядків) ────────────────────────────────
// `<toolsDir>/DP2/Others/Original/` — еталонні UILabel-JSON, витягнуті зі
// `sharedassets1.assets` поточної інсталяції DP2.
// `<toolsDir>/DP2/Others/Done/` — робочі копії, у яких користувач править
// поле `mText`.
// Список PathID, що треба витягти, передається з рендера (фіксований TS-
// масив `DP2_OTHERS_PATH_IDS`).
async function dp2OthersBaseDir() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  return path.join(toolsDir, "DP2", "Others");
}
async function dp2OthersOriginalDir() { return path.join(await dp2OthersBaseDir(), "Original"); }
async function dp2OthersDoneDir()     { return path.join(await dp2OthersBaseDir(), "Done"); }

// Похідний шлях до sharedassets1.assets — у тій самій теці, що sharedassets0.
async function dp2Sharedassets1Path() {
  const settings = await readSettings();
  if (!settings.assetsPath) return null;
  return path.join(path.dirname(settings.assetsPath), "sharedassets1.assets");
}

function dp2OthersFileNameFor(pathId) {
  return `UILabel-sharedassets1.assets-${pathId}.json`;
}

ipcMain.handle("dp2:others-status", async (_e, payload) => {
  try {
    const wantedIds = Array.isArray(payload?.pathIds) ? payload.pathIds.map(Number).filter(Number.isFinite) : [];
    const baseDir = await dp2OthersBaseDir();
    const originalDir = await dp2OthersOriginalDir();
    const doneDir = await dp2OthersDoneDir();
    const sharedAssets1 = await dp2Sharedassets1Path();
    let sharedAssets1Exists = false;
    if (sharedAssets1) {
      try { await fs.access(sharedAssets1); sharedAssets1Exists = true; } catch {}
    }

    async function safeStat(p) { try { return await fs.stat(p); } catch { return null; } }

    const files = [];
    for (const pid of wantedIds) {
      const name = dp2OthersFileNameFor(pid);
      const origPath = path.join(originalDir, name);
      const donePath = path.join(doneDir, name);
      const [origSt, doneSt] = await Promise.all([safeStat(origPath), safeStat(donePath)]);
      files.push({
        pathId: pid,
        name,
        donePath,
        originalSize: origSt ? origSt.size : null,
        doneSize: doneSt ? doneSt.size : null,
        doneMtime: doneSt ? doneSt.mtimeMs : null,
      });
    }
    return {
      ok: true,
      baseDir,
      originalDir,
      doneDir,
      sharedAssets1,
      sharedAssets1Exists,
      files,
    };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle("dp2:others-extract", async (_e, payload) => {
  try {
    const wantedIds = Array.isArray(payload?.pathIds) ? payload.pathIds.map(Number).filter(Number.isFinite) : [];
    if (wantedIds.length === 0) return { ok: false, error: "Не передано жодного PathID" };

    const settings = await readSettings();
    const { uabeaPath } = settings;
    if (!uabeaPath) return { ok: false, error: "UABEA не задано (Налаштування)" };
    const uabeaDir = path.dirname(uabeaPath);

    const assetsPath = await dp2Sharedassets1Path();
    if (!assetsPath) return { ok: false, error: "Шлях до DP2 не задано (Налаштування)" };
    try { await fs.access(assetsPath); }
    catch { return { ok: false, error: "sharedassets1.assets не знайдено: " + assetsPath }; }

    const pwshLookup = await findPwsh(settings);
    if (!pwshLookup) return { ok: false, error: "PowerShell 7 (pwsh.exe) не знайдено" };

    const originalDir = await dp2OthersOriginalDir();
    const doneDir = await dp2OthersDoneDir();
    await fs.mkdir(originalDir, { recursive: true });
    await fs.mkdir(doneDir, { recursive: true });

    const scriptPath = resolveResource("scripts/dp2-others-extract.ps1");

    return await new Promise((resolve) => {
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-AssetsPath", assetsPath,
        "-OutDir", originalDir,
        "-UabeaDir", uabeaDir,
        "-PathIds", wantedIds.join(","),
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
          try { win?.webContents.send("dp2:others-progress", ln); } catch {}
        }
      };
      child.stdout.on("data", (d) => emit(d.toString()));
      child.stderr.on("data", (d) => emit(d.toString()));
      child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout }));
      child.on("exit", async (code) => {
        if (leftover.trim()) {
          try { win?.webContents.send("dp2:others-progress", leftover); } catch {}
        }
        if (code !== 0) {
          const tail = allStdout.split("\n").slice(-20).join("\n").trim();
          resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
          return;
        }
        // Скопіювати свіжовитягнуті оригінали у Done/, якщо там ще не існує
        // (щоб не затирати уже зроблений переклад). Також залити кожен файл
        // як `<basename>.bak.json` (схема, яку очікує штатний `dp2:read-backup`
        // — `*.json` -> `*.bak.json`), щоб редактор бачив originalEn для
        // diff/мітки «перекладено».
        let copied = 0;
        try {
          const ents = await fs.readdir(originalDir, { withFileTypes: true });
          for (const e of ents) {
            if (!e.isFile() || !e.name.endsWith(".json")) continue;
            const src = path.join(originalDir, e.name);
            const dst = path.join(doneDir, e.name);
            const bak = path.join(doneDir, e.name.replace(/\.json$/i, ".bak.json"));
            try { await fs.access(dst); }
            catch {
              try { await fs.copyFile(src, dst); copied++; } catch {}
            }
            // .bak завжди оновлюємо до свіжого оригіналу — він має дзеркалити
            // те, що зараз у sharedassets1.assets, без огляду на стан Done/.
            try { await fs.copyFile(src, bak); } catch {}
          }
        } catch {}

        let summary = null;
        const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
        if (m) { try { summary = JSON.parse(m[1]); } catch {} }
        resolve({ ok: true, summary, copiedToDone: copied, log: allStdout });
      });
    });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle("dp2:others-clear", async () => {
  try {
    const baseDir = await dp2OthersBaseDir();
    try { await fs.rm(baseDir, { recursive: true, force: true }); } catch {}
    await fs.mkdir(path.join(baseDir, "Original"), { recursive: true });
    await fs.mkdir(path.join(baseDir, "Done"), { recursive: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});


// ── IPC: export 4 fonts з sharedassets0.assets у toolsDir/dp2-fonts/ ─────
ipcMain.handle("dp2:fonts-export", async () => {
  const settings = await readSettings();
  const { uabeaPath, assetsPath } = settings;
  if (!assetsPath) return { success: false, error: "DP2 game path not set — open the prep wizard first" };
  if (!uabeaPath)  return { success: false, error: "UABEA path not set" };

  let toolsDir = settings.toolsDir;
  if (!toolsDir) {
    toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
    await writeSettings({ ...settings, toolsDir });
  }

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 (pwsh.exe) не знайдено" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/fonts-export.ps1");
  const outDir = path.join(toolsDir, "DP2", "Fonts");
  await fs.mkdir(outDir, { recursive: true });
  // Pre-cleanup: видаляємо сміттєві font_<pid>-* файли від попередніх версій
  // та all .ttf/.otf — щоб expor завжди давав чистий набір.
  try {
    const items = await fs.readdir(outDir);
    for (const n of items) {
      if (/^font_\d+-.*\.(ttf|otf)$/i.test(n) || /\.(ttf|otf)$/i.test(n)) {
        try { await fs.unlink(path.join(outDir, n)); } catch {}
      }
    }
  } catch {}

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
  if (!assetsPath) return { success: false, error: "DP2 game path not set" };
  if (!uabeaPath)  return { success: false, error: "UABEA path not set" };

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 не знайдено" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/fonts-replace.ps1");

  // Точкова заміна: assetsFile приходить з frontend (з hardcoded FONTS
  // mapping). Не вгадуємо, не пробуємо «обидва» — пишемо рівно у вказаний
  // .assets, як просив користувач.
  const gameDir = path.dirname(assetsPath);
  const fontName = (payload && payload.name ? String(payload.name) : "").trim();
  const targetAssets = assetsFile
    ? path.join(gameDir, assetsFile)
    : assetsPath;
  const targetAssetsBase = path.basename(targetAssets);

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
    child.on("exit", async (code) => {
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-15).join("\n").trim();
        resolve({ success: false, error: (tail || `Exit ${code}`).trim(), log: allStdout });
        return;
      }
      // Cache-copy у toolsDir/DP2/Fonts/<name>-<assetsFile>-<pid>.<ext>.
      try {
        const cur = await readSettings();
        let toolsDir = cur.toolsDir;
        if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
        const cacheDir = path.join(toolsDir, "DP2", "Fonts");
        await fs.mkdir(cacheDir, { recursive: true });
        const safeName = (fontName || `font_${pathId}`).replace(/[\\/:\*\?"<>\|]/g, "_");
        const ext = path.extname(newFontPath).toLowerCase() || ".ttf";
        const dst = path.join(cacheDir, `${safeName}-${targetAssetsBase}-${pathId}${ext}`);
        await fs.copyFile(newFontPath, dst);
      } catch (cacheErr) {
        allStdout += "\n[cache] " + (cacheErr.message || cacheErr);
      }
      resolve({ success: true, outputPath: targetAssets, log: allStdout });
    });
  });
});

// ── IPC: list уже-експортованих TTF у toolsDir/dp2-fonts/ + читати байти ─
ipcMain.handle("dp2:fonts-list", async () => {
  const settings = await readSettings();
  if (!settings.toolsDir) return { dir: null, files: [] };
  const dir = path.join(settings.toolsDir, "DP2", "Fonts");
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

// Відновлює оригінальні .assets з .bak (для DP2 шрифтів). Корисно коли
// наш replace зламав byte-data і гра показує fallback.
ipcMain.handle("dp2:fonts-restore-bak", async () => {
  const settings = await readSettings();
  const assetsPath = settings.assetsPath;
  if (!assetsPath) return { success: false, error: "DP2 game path not set" };
  const gameDir = path.dirname(assetsPath);
  const targets = ["sharedassets0.assets", "resources.assets"];
  const restored = [];
  const skipped = [];
  for (const t of targets) {
    const dst = path.join(gameDir, t);
    const bak = dst + ".bak";
    try { await fs.access(bak); }
    catch { skipped.push({ file: t, reason: "no .bak" }); continue; }
    try {
      await fs.copyFile(bak, dst);
      restored.push(t);
    } catch (e) {
      return { success: false, error: `restore ${t} fail: ${e.message || e}`, restored, skipped };
    }
  }
  return { success: true, restored, skipped };
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

// ── DP2 text prep: status + extract + copy-to-done ──────────────
// Користувач не має готових JSON-дампів — програма мусить сама витягти їх
// з sharedassets0.assets при першому виборі директорії гри. Створюємо у
// gameDir/TEXT/ORIGINAL (еталон) + gameDir/TEXT/DONE (робочі копії).

// Helper: повертає очікуваний шлях файлу у дереві категорій. Якщо entry без
// category — кладемо просто в корінь (для backward compat).
function dp2TextLocate(rootDir, entry) {
  if (typeof entry === "string") return path.join(rootDir, entry);
  return entry.category
    ? path.join(rootDir, entry.category, entry.file)
    : path.join(rootDir, entry.file);
}

// Backward-compat cleanup: коли користувач уже мав extract від попередньої
// версії програми, файли лежали плоско в корені TEXT/ORIGINAL та TEXT/DONE.
// Нова версія розкладає у subdir-и за категорією — викликаємо це окремо у
// wizard, щоб видалити старі плоскі дублікати, навіть якщо extract пропускався.
ipcMain.handle("dp2:text-prep-cleanup-flat", async (_e, payload) => {
  const { originalDir, doneDir, requiredFiles } = payload || {};
  if (!Array.isArray(requiredFiles)) return { ok: false, error: "bad args" };
  let removed = 0;
  async function tryDelete(p) {
    try { await fs.unlink(p); removed++; } catch {}
  }
  for (const entry of requiredFiles) {
    if (typeof entry === "string" || !entry.category || !entry.file) continue;
    for (const root of [originalDir, doneDir].filter(Boolean)) {
      const flat = path.join(root, entry.file);
      const sub = path.join(root, entry.category, entry.file);
      try {
        await fs.access(sub);
        await tryDelete(flat);
        await tryDelete(flat + ".bak");
      } catch {}
    }
  }
  return { ok: true, removed };
});

// Helper: TEXT/ORIGINAL та TEXT/DONE лежать у toolsDir (Documents/SWERY-...
// /dp2-text/), а НЕ у директорії гри. Це робить переклади незалежними від
// Steam-перевстановлень і дозволяє користувачу легко знайти/бекапити їх.
async function dp2TextDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "DP2", "Text");
  return {
    baseDir,
    originalDir: path.join(baseDir, "Original"),
    doneDir: path.join(baseDir, "Done"),
  };
}

// ── Hotel Barcelona prep ──────────────────────────────────────────
//
// Int64-safe JSON helpers. HBR-дампи містять Int64-поля > 2^53, які JSON.parse
// мовчки truncate'ує до Double-точності (втрата 2-3 останніх цифр). Поля які
// треба захищати:
//   - m_PathID (PPtr.m_PathID) — посилання на assets
//   - pathId / scriptPathId — у meta.json
//   - rid (managed-reference id у _CommandInfos.Array[*]._Argument)
// Без обгортки rid'и зливаються в одне округлене значення → Unity GC бачить
// dangling-ref → краш `il2cpp_unity_liveness_calculation_from_statics`.
function hbrParseJsonInt64Safe(raw) {
  const safe = raw
    .replace(/"m_PathID"\s*:\s*(-?\d+)/g, '"m_PathID":"$1"')
    .replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"')
    .replace(/"rid"\s*:\s*(-?\d+)/g, '"rid":"$1"');
  return JSON.parse(safe);
}
function hbrStringifyJsonInt64Safe(obj) {
  let raw = JSON.stringify(obj, null, 2);
  raw = raw.replace(/"m_PathID"\s*:\s*"(-?\d+)"/g, '"m_PathID": $1');
  raw = raw.replace(/"rid"\s*:\s*"(-?\d+)"/g, '"rid": $1');
  return raw;
}

async function hbrTextDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "HBR", "Text");
  return {
    baseDir,
    originalDir: path.join(baseDir, "Original"),
    doneDir: path.join(baseDir, "Done"),
    metaDir: path.join(baseDir, "Meta"),
    metaFile: path.join(baseDir, "Meta", "hbr-meta.json"),
  };
}

ipcMain.handle("dp2:hbr-text-prep-status", async () => {
  const settings = await readSettings();
  const { originalDir, doneDir, metaDir, metaFile } = await hbrTextDirs();
  let metaExists = false;
  let originalCount = 0;
  let doneCount = 0;
  try { await fs.access(metaFile); metaExists = true; } catch {}
  try {
    const items = await fs.readdir(originalDir);
    originalCount = items.filter((n) => n.endsWith(".json")).length;
  } catch {}
  try {
    const items = await fs.readdir(doneDir);
    doneCount = items.filter((n) => n.endsWith(".json")).length;
  } catch {}
  let bundlePath = settings.hbrBundlePath || null;
  let bundleOk = false;
  if (bundlePath) {
    try { await fs.access(bundlePath); bundleOk = true; } catch { bundlePath = null; }
  }
  // ok=true якщо bundle є АБО уже витягнуто щось у Original. Так редактор
  // не вимагає re-extract якщо файли вже на диску після попередньої сесії.
  const ok = bundleOk || originalCount > 0;
  return {
    ok, bundlePath, bundleOk, originalDir, doneDir, metaDir, metaFile,
    metaExists, originalCount, doneCount,
    error: ok ? undefined : "hbrBundlePath not set (game root missing in onboarding) and no extracted files yet",
  };
});

async function hbrRunExtract() {
  const settings = await readSettings();
  const bundlePath = settings.hbrBundlePath;
  if (!bundlePath) return { ok: false, error: "hbrBundlePath not set" };
  try { await fs.access(bundlePath); }
  catch { return { ok: false, error: "bundle-not-found: " + bundlePath }; }
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const { originalDir, metaFile } = await hbrTextDirs();
  try { await fs.mkdir(originalDir, { recursive: true }); } catch (e) {
    return { ok: false, error: "mkdir fail: " + (e.message || e) };
  }
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/hbr-text-export.ps1");

  // Multi-bundle: знаходимо всі _resources*.bundle у тій самій теці. DLC-
  // bundle'и виключаємо — їхні MonoBehaviour мають _DLC1 у m_Name і ламали
  // pack-flow (Hotel Barcelona база і DLC мають різні PathID-простори).
  // Якщо знадобиться знову — приберемо exclude.
  const aaSwDir = path.dirname(bundlePath);
  let entries = []; try { entries = await fs.readdir(aaSwDir); } catch {}
  const allBundles = entries
    .filter((f) => /^_resources.*\.bundle$/i.test(f) && !f.endsWith(".bak") && !/dlc/i.test(f))
    .map((f) => path.join(aaSwDir, f));
  if (allBundles.length === 0) allBundles.push(bundlePath);
  const win = BrowserWindow.getAllWindows()[0];
  try { win?.webContents.send("dp2:hbr-text-prep-progress", `[STEP] Scanning ${allBundles.length} bundle(s): ${allBundles.map((b) => path.basename(b)).join(", ")}`); } catch {}

  const aggregateItems = [];
  const bundlesProcessed = [];
  for (const bp of allBundles) {
    const tmpMeta = path.join(path.dirname(metaFile), `_tmp-meta-${path.basename(bp)}.json`);
    const ok = await new Promise((resolve) => {
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-BundlePath", bp,
        "-OutDir", originalDir,
        "-MetaPath", tmpMeta,
        "-UabeaDir", uabeaDir,
      ];
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let leftover = "";
      const emit = (chunk) => {
        leftover += chunk;
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() || "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try { win?.webContents.send("dp2:hbr-text-prep-progress", ln); } catch {}
        }
      };
      child.stdout.on("data", (d) => emit(d.toString()));
      child.stderr.on("data", (d) => emit(d.toString()));
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    if (!ok) continue;
    try {
      // Int64 PathID > 2^53: JSON.parse без обгортки truncate'ує його як Double
      // (втрата 3-4 останніх цифр). Обертаємо pathId/scriptPathId у string ще
      // до parse — далі по pipeline вони залишаються рядками.
      const rawTmp = await fs.readFile(tmpMeta, "utf8");
      const safeTmp = rawTmp.replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
      const m = JSON.parse(safeTmp);
      if (Array.isArray(m.items)) aggregateItems.push(...m.items);
      bundlesProcessed.push(path.basename(bp));
    } catch {}
    try { await fs.unlink(tmpMeta); } catch {}
  }

  // Записуємо об'єднану meta.
  const merged = {
    bundles: bundlesProcessed,
    items: aggregateItems,
    exportedAt: new Date().toISOString(),
  };
  await fs.writeFile(metaFile, JSON.stringify(merged, null, 2), "utf8");
  try { win?.webContents.send("dp2:hbr-text-prep-progress", `[STEP] DONE multi-bundle: ${aggregateItems.length} items from ${bundlesProcessed.length} bundle(s)`); } catch {}
  return { ok: true, total: aggregateItems.length, bundles: bundlesProcessed };
}

ipcMain.handle("dp2:hbr-text-prep-extract", async () => hbrRunExtract());

// Patch migration: гра випустила оновлення → bundle-хеш у назві файлу
// поміняв sсь, +/- кілька рядків у текстах, MonoBehaviour-структура та PathID
// зазвичай стабільні. Цей handler:
//   1. Бекапить поточні Text/Original, Text/Done, Text/Meta у _backup-<ts>/.
//   2. Чистить Original/Done/Meta.
//   3. Робить свіжий extract з нового bundle (заповнює Original + Meta).
//   4. Для кожного new-item шукає старий Done у бекапі за pathId, мерджить
//      `_Text` значення (де переклад було зроблено) у new structure.
//   5. Записує merged-Done.
// КРИТИЧНО: для read/write JSON використовуємо hbrParseJsonInt64Safe /
// hbrStringifyJsonInt64Safe, бо `rid`-поле > 2^53 в managed-references й JS
// JSON.parse без обгортки нищить його точність.
ipcMain.handle("dp2:hbr-patch-migrate-check", async () => {
  const settings = await readSettings();
  const bundlePath = settings.hbrBundlePath;
  if (!bundlePath) return { ok: false, error: "hbrBundlePath not set" };
  const { metaFile, doneDir } = await hbrTextDirs();
  let metaBundles = [];
  let metaItemsCount = 0;
  try {
    const raw = await fs.readFile(metaFile, "utf8");
    const meta = JSON.parse(raw);
    metaBundles = Array.isArray(meta.bundles) ? meta.bundles : [];
    metaItemsCount = Array.isArray(meta.items) ? meta.items.length : 0;
  } catch {
    return { ok: true, hasMeta: false, needed: false, newBundle: path.basename(bundlePath) };
  }
  let doneCount = 0;
  try {
    const ents = await fs.readdir(doneDir);
    doneCount = ents.filter((f) => f.endsWith(".json")).length;
  } catch {}
  const newBundle = path.basename(bundlePath);
  const oldBundle = metaBundles[0] || "";
  return {
    ok: true,
    hasMeta: true,
    newBundle,
    oldBundle,
    needed: oldBundle !== newBundle && oldBundle !== "",
    metaItemsCount,
    doneCount,
  };
});

ipcMain.handle("dp2:hbr-patch-migrate", async () => {
  const settings = await readSettings();
  const bundlePath = settings.hbrBundlePath;
  if (!bundlePath) return { ok: false, error: "hbrBundlePath not set" };
  try { await fs.access(bundlePath); }
  catch { return { ok: false, error: "bundle-not-found: " + bundlePath }; }
  const { baseDir, originalDir, doneDir, metaDir, metaFile } = await hbrTextDirs();
  const win = BrowserWindow.getAllWindows()[0];
  const emit = (msg) => { try { win?.webContents.send("dp2:hbr-text-prep-progress", msg); } catch {} };

  // 1. Backup поточних теку.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bakRoot = path.join(baseDir, `_backup-${ts}`);
  await fs.mkdir(bakRoot, { recursive: true });
  const bakOrig = path.join(bakRoot, "Original");
  const bakDone = path.join(bakRoot, "Done");
  const bakMeta = path.join(bakRoot, "Meta");
  async function copyDir(src, dst) {
    try { await fs.mkdir(dst, { recursive: true }); } catch {}
    let entries; try { entries = await fs.readdir(src); } catch { return; }
    for (const f of entries) {
      const sp = path.join(src, f), dp = path.join(dst, f);
      const st = await fs.stat(sp);
      if (st.isDirectory()) await copyDir(sp, dp);
      else await fs.copyFile(sp, dp);
    }
  }
  emit(`[STEP] Backup → ${bakRoot}`);
  await copyDir(originalDir, bakOrig);
  await copyDir(doneDir, bakDone);
  await copyDir(metaDir, bakMeta);

  // 2. Очищаємо Original / Done / Meta (структуру лишаємо).
  async function wipeDir(dir) {
    let entries; try { entries = await fs.readdir(dir); } catch { return; }
    for (const f of entries) {
      try { await fs.unlink(path.join(dir, f)); } catch {}
    }
  }
  await wipeDir(originalDir);
  await wipeDir(doneDir);
  await wipeDir(metaDir);

  // 3. Свіжий extract з нового bundle.
  emit("[STEP] Extract from new bundle…");
  const ext = await hbrRunExtract();
  if (!ext.ok) {
    return { ok: false, error: "extract failed: " + (ext.error || "?"), backup: bakRoot };
  }

  // 4. Читаємо нову meta + ітеруємо items, шукаємо старе Done за pathId,
  //    мерджимо `_Text`-значення там, де old-Done відрізнявся від old-Original.
  const newMetaRaw = await fs.readFile(metaFile, "utf8");
  const newMeta = JSON.parse(newMetaRaw);
  const newItems = Array.isArray(newMeta.items) ? newMeta.items : [];

  function pidFromName(n) { const m = n.match(/-(-?\d+)\.json$/); return m ? m[1] : null; }
  let bakDoneFiles = []; try { bakDoneFiles = await fs.readdir(bakDone); } catch {}
  let bakOrigFiles = []; try { bakOrigFiles = await fs.readdir(bakOrig); } catch {}
  const bakDoneByPid = new Map();
  const bakOrigByPid = new Map();
  for (const f of bakDoneFiles) { const p = pidFromName(f); if (p) bakDoneByPid.set(p, f); }
  for (const f of bakOrigFiles) { const p = pidFromName(f); if (p) bakOrigByPid.set(p, f); }

  function flattenTexts(obj) {
    const m = new Map();
    const lst = obj?._List?.Array;
    if (!Array.isArray(lst)) return m;
    for (const row of lst) {
      const tid = row?._TextId ?? "";
      const arr = row?._Texts?.Array;
      if (!Array.isArray(arr)) continue;
      for (let j = 0; j < arr.length; j++) m.set(`${tid}|${j}`, arr[j]?._Text ?? "");
    }
    return m;
  }

  let mergedFiles = 0, totalTouched = 0, totalNewCells = 0, totalKept = 0;
  for (const it of newItems) {
    const pidStr = String(it.pathId);
    const newDumpPath = path.join(originalDir, it.file);
    let newObj;
    try {
      const raw = await fs.readFile(newDumpPath, "utf8");
      newObj = hbrParseJsonInt64Safe(raw);
    } catch (e) {
      emit(`[WARN] read new ${it.file} failed: ${e.message}`);
      continue;
    }

    const oldDoneName = bakDoneByPid.get(pidStr);
    const oldOrigName = bakOrigByPid.get(pidStr);
    let doneObj = newObj;
    if (oldDoneName && oldOrigName) {
      try {
        const oldDoneRaw = await fs.readFile(path.join(bakDone, oldDoneName), "utf8");
        const oldOrigRaw = await fs.readFile(path.join(bakOrig, oldOrigName), "utf8");
        const oldDoneObj = hbrParseJsonInt64Safe(oldDoneRaw);
        const oldOrigObj = hbrParseJsonInt64Safe(oldOrigRaw);
        const oOrig = flattenTexts(oldOrigObj);
        const oDone = flattenTexts(oldDoneObj);
        doneObj = JSON.parse(JSON.stringify(newObj));
        const lst = doneObj?._List?.Array || [];
        for (const row of lst) {
          const tid = row?._TextId ?? "";
          const arr = row?._Texts?.Array;
          if (!Array.isArray(arr)) continue;
          for (let j = 0; j < arr.length; j++) {
            const key = `${tid}|${j}`;
            const origText = oOrig.get(key);
            const doneText = oDone.get(key);
            if (doneText !== undefined && origText !== undefined && doneText !== origText) {
              arr[j]._Text = doneText; totalTouched++;
            } else if (origText === undefined) totalNewCells++;
            else totalKept++;
          }
        }
      } catch (e) {
        emit(`[WARN] merge ${it.name} failed: ${e.message} — used new English as-is`);
      }
    }
    const newDonePath = path.join(doneDir, it.file);
    await fs.writeFile(newDonePath, hbrStringifyJsonInt64Safe(doneObj), "utf8");
    // Original теж пере-серіалізуємо через Int64-safe — щоб формат був бітово
    // рівним з Done і не виглядав «дивно» у diff-tools.
    await fs.writeFile(newDumpPath, hbrStringifyJsonInt64Safe(newObj), "utf8");
    mergedFiles++;
  }

  // Збагачуємо meta полем migratedFrom для діагностики.
  try {
    const m = JSON.parse(await fs.readFile(metaFile, "utf8"));
    m.migratedFrom = path.basename(bakRoot);
    m.migratedAt = new Date().toISOString();
    await fs.writeFile(metaFile, JSON.stringify(m, null, 2), "utf8");
  } catch {}

  emit(`[STEP] DONE migration: ${mergedFiles} files, ${totalTouched} translated cells preserved, ${totalNewCells} new English cells, backup at ${path.basename(bakRoot)}`);
  return {
    ok: true,
    mergedFiles,
    translated: totalTouched,
    newCells: totalNewCells,
    keptEnglish: totalKept,
    backup: bakRoot,
  };
});

// Pack HBR translations back into the game bundle (hbr-text-import.ps1).
// Спільна pack-логіка: викликається і з `dp2:hbr-pack-into-game`, і з
// `dp2:hbr-build-release`. Раніше release-handler намагався виcмикнути
// pack-listener через `ipcMain.listeners()`, але `ipcMain.handle()` НЕ
// додає у `listeners` — це окремий механізм. Тому використовуємо звичайну
// функцію-помічника.
async function hbrRunPack() {
  const settings = await readSettings();
  const bundlePath = settings.hbrBundlePath;
  if (!bundlePath) return { ok: false, error: "hbrBundlePath not set" };
  try { await fs.access(bundlePath); }
  catch { return { ok: false, error: "bundle-not-found: " + bundlePath }; }
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const { doneDir, metaFile, metaDir } = await hbrTextDirs();
  try { await fs.access(doneDir); } catch { return { ok: false, error: "Done dir empty/missing" }; }
  try { await fs.access(metaFile); } catch { return { ok: false, error: "Meta file missing — run extract first" }; }
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/hbr-text-import.ps1");

  // Multi-bundle pack: читаємо meta, groupуємо items по `bundle` (basename),
  // для кожної групи робимо окремий запуск import-script зі своєю tmp-meta
  // (script сам обробляє один bundle за раз).
  let meta;
  try {
    // PathID — Unity Int64. Числа > 2^53 у JSON.parse стають Double і втрачають
    // точність ("-8972238306652206080" → "-8972238306652206000"), тож PS-скрипт
    // не знаходить asset. Обгортаємо pathId/scriptPathId у string перед parse —
    // тоді у tmpMeta вони лишаються рядками, PS скрипт парсить як Int64.
    const raw = await fs.readFile(metaFile, "utf8");
    const safe = raw.replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
    meta = JSON.parse(safe);
  }
  catch (e) { return { ok: false, error: "meta parse fail: " + (e.message || e) }; }
  const items = Array.isArray(meta.items) ? meta.items : [];
  if (items.length === 0) return { ok: false, error: "meta has no items" };
  const groups = {};
  for (const it of items) {
    const key = it.bundle || "";
    if (!groups[key]) groups[key] = [];
    groups[key].push(it);
  }
  const aaSwDir = path.dirname(bundlePath);
  const win = BrowserWindow.getAllWindows()[0];

  // Аггрегаційні лічильники по всіх bundle-у.
  let totalAllFields = 0;
  let allApplied = 0;
  const allFailed = [];
  const bundleSizes = {};
  let combinedLog = "";

  for (const [bundleName, subItems] of Object.entries(groups)) {
    const fullPath = path.join(aaSwDir, bundleName + ".bundle");
    try { await fs.access(fullPath); }
    catch {
      try { win?.webContents.send("dp2:hbr-pack-progress", `[SKIP] bundle not found: ${bundleName}.bundle`); } catch {}
      continue;
    }
    const tmpMeta = path.join(metaDir, `_tmp-pack-meta-${bundleName}.json`);
    await fs.writeFile(tmpMeta, JSON.stringify({ items: subItems }, null, 2), "utf8");
    try { win?.webContents.send("dp2:hbr-pack-progress", `[STEP] ───── ${bundleName}.bundle (${subItems.length} items)`); } catch {}

    const result = await new Promise((resolve) => {
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-BundlePath", fullPath,
        "-DoneDir", doneDir,
        "-MetaPath", tmpMeta,
        "-UabeaDir", uabeaDir,
      ];
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let allStdout = "";
      let leftover = "";
      let bundleFields = 0;
      const emit = (chunk) => {
        allStdout += chunk;
        leftover += chunk;
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() || "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          const fm = ln.match(/\[PATCHED\][^\n]*(?:fields|bytes)=(\d+)/);
          if (fm) bundleFields += parseInt(fm[1], 10) || 0;
          try { win?.webContents.send("dp2:hbr-pack-progress", ln); } catch {}
        }
      };
      child.stdout.on("data", (d) => emit(d.toString()));
      child.stderr.on("data", (d) => emit(d.toString()));
      child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout, totalFields: bundleFields }));
      child.on("exit", (code) => {
        if (leftover.trim()) { try { win?.webContents.send("dp2:hbr-pack-progress", leftover); } catch {} }
        if (code !== 0) {
          const tail = allStdout.split("\n").slice(-25).join("\n").trim();
          resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout, totalFields: bundleFields });
          return;
        }
        let summary = null;
        const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
        if (m) { try { summary = JSON.parse(m[1]); } catch {} }
        resolve({ ok: true, summary, log: allStdout, totalFields: bundleFields });
      });
    });
    combinedLog += `\n=== ${bundleName} ===\n` + result.log;
    try { await fs.unlink(tmpMeta); } catch {}
    totalAllFields += result.totalFields || 0;
    if (result.summary) {
      allApplied += result.summary.applied || 0;
      if (Array.isArray(result.summary.failed)) allFailed.push(...result.summary.failed);
    }
    try { const st = await fs.stat(fullPath); bundleSizes[bundleName] = st.size; } catch {}
    if (!result.ok) {
      // Save log і повертаємо помилку (зупиняємось на першому fail-bundle).
      const out = { ok: false, error: result.error, totalFields: totalAllFields, bundlePath, bundleSize: bundleSizes[path.basename(bundlePath, ".bundle")] };
      try {
        let toolsDir = settings.toolsDir;
        if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
        const logsDir = path.join(toolsDir, "LOGS", "HBR");
        await fs.mkdir(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const logPath = path.join(logsDir, `hbr-pack-${ts}.log`);
        await fs.writeFile(logPath, combinedLog, "utf8");
        out.logPath = logPath;
      } catch {}
      return out;
    }
  }

  // Лог + сумарна відповідь.
  const out = {
    ok: true,
    summary: { applied: allApplied, failed: allFailed },
    totalFields: totalAllFields,
    bundlePath,
    bundleSize: bundleSizes[path.basename(bundlePath, ".bundle")],
    bakPath: bundlePath + ".bak",
  };
  try { const sb = await fs.stat(bundlePath + ".bak"); out.bakSize = sb.size; } catch {}
  try {
    let toolsDir = settings.toolsDir;
    if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
    const logsDir = path.join(toolsDir, "LOGS", "HBR");
    await fs.mkdir(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logPath = path.join(logsDir, `hbr-pack-${ts}.log`);
    await fs.writeFile(logPath, combinedLog, "utf8");
    out.logPath = logPath;
  } catch {}
  return out;
}

ipcMain.handle("dp2:hbr-pack-into-game", async () => {
  return await hbrRunPack();
});

// Pre-pack lint: для кожного Done-файлу пройти `_List.Array[*]._Texts.Array[*]`
// і знайти рядки, де набір плейсхолдерів `{n}/${var}/<tag>/[ctl]/\n` у current
// (Done) НЕ збігається з Original. Це не блокує pack, але дає попередження
// користувачу — щоб не запакувати білд із бракуючими/зайвими маркерами.
ipcMain.handle("dp2:hbr-text-lint-placeholders", async () => {
  const { originalDir, doneDir } = await hbrTextDirs();
  let entries; try { entries = await fs.readdir(originalDir); }
  catch { return { ok: false, error: "no extracted text" }; }
  // Той самий набір, що в parser.ts (PLACEHOLDER_RES). Квадратні дужки
  // `[Continue]`, `[Dodge]`, `[Shockwave]` тощо у HBR — це template-references
  // (гра підставляє з інших translation-entries), які МОЖНА і ТРЕБА
  // перекладати на українські відповідники. Тому ми НЕ лічимо звичайні
  // [Word] як placeholders — інакше lint червонить 21+ валідних рядків.
  // Виняток — [...] з суфіксом `.json` (посилання на bundle-файл): такі
  // мають лишатися байт-у-байт і у перекладі, бо це шлях.
  const PATS = [
    /\{[A-Za-z0-9_]+\}/g,
    /\$\{[^}]+\}/g,
    /<\/?[A-Za-z][^>]*>/g,
    /\[[^\]]+\.json\]/g,
    /\\n/g, /\\r\\n/g,
  ];
  function extractTags(s) {
    if (!s) return [];
    const out = [];
    for (const re of PATS) { const m = s.match(re); if (m) out.push(...m); }
    return out.sort();
  }
  function diff(o, c) {
    const oC = new Map(); const cC = new Map();
    for (const x of o) oC.set(x, (oC.get(x) ?? 0) + 1);
    for (const x of c) cC.set(x, (cC.get(x) ?? 0) + 1);
    const missing = []; const extra = [];
    for (const [k, v] of oC) { const d = v - (cC.get(k) ?? 0); for (let i = 0; i < d; i++) missing.push(k); }
    for (const [k, v] of cC) { const d = v - (oC.get(k) ?? 0); for (let i = 0; i < d; i++) extra.push(k); }
    return { missing, extra };
  }
  const violations = [];
  let scannedFiles = 0; let scannedRows = 0;
  for (const fname of entries) {
    if (!fname.endsWith(".json")) continue;
    const origPath = path.join(originalDir, fname);
    const donePath = path.join(doneDir, fname);
    let origRaw; let doneRaw;
    try { origRaw = await fs.readFile(origPath, "utf8"); } catch { continue; }
    try { doneRaw = await fs.readFile(donePath, "utf8"); } catch { continue; }
    try {
      const orig = JSON.parse(origRaw);
      const done = JSON.parse(doneRaw);
      const oList = (orig && orig._List && orig._List.Array) || [];
      const dList = (done && done._List && done._List.Array) || [];
      scannedFiles++;
      for (let i = 0; i < dList.length; i++) {
        const textId = (dList[i] && dList[i]._TextId) || `#${i}`;
        const dTexts = (dList[i] && dList[i]._Texts && dList[i]._Texts.Array) || [];
        const oTexts = (oList[i] && oList[i]._Texts && oList[i]._Texts.Array) || [];
        for (let j = 0; j < dTexts.length; j++) {
          scannedRows++;
          const d = (dTexts[j] && dTexts[j]._Text) || "";
          const o = (oTexts[j] && oTexts[j]._Text) || "";
          if (!d || d === o) continue; // not translated → skip lint
          const { missing, extra } = diff(extractTags(o), extractTags(d));
          if (missing.length === 0 && extra.length === 0) continue;
          violations.push({
            file: fname, textId, variantIdx: j,
            missing, extra,
            original: o, current: d,
          });
        }
      }
    } catch {}
  }
  return { ok: true, scannedFiles, scannedRows, violations };
});

// Прибрати DLC-сліди з HBR/Text: видаляє Done/Original .json (а також .bak),
// у яких bundle назва містить "dlc", і викидає DLC-items з meta. Не чіпає
// сам ігровий .bundle файл. Безпечно викликати кілька разів.
ipcMain.handle("dp2:hbr-text-purge-dlc", async () => {
  const { originalDir, doneDir, metaFile } = await hbrTextDirs();
  const isDlc = (n) => /dlc/i.test(n);
  let removedFiles = 0;
  for (const dir of [originalDir, doneDir]) {
    let items = []; try { items = await fs.readdir(dir); } catch { continue; }
    for (const n of items) {
      if (!isDlc(n)) continue;
      try { await fs.unlink(path.join(dir, n)); removedFiles++; } catch {}
    }
  }
  let removedMeta = 0;
  try {
    const raw = await fs.readFile(metaFile, "utf8");
    const safe = raw.replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
    const meta = JSON.parse(safe);
    if (Array.isArray(meta.items)) {
      const before = meta.items.length;
      meta.items = meta.items.filter((it) => !(it && (isDlc(it.file || "") || isDlc(it.bundle || "") || isDlc(it.name || ""))));
      removedMeta = before - meta.items.length;
    }
    if (Array.isArray(meta.bundles)) {
      meta.bundles = meta.bundles.filter((b) => !isDlc(b));
    }
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");
  } catch {}
  return { ok: true, removedFiles, removedMeta };
});

// TGL Mono Export: викликає tgl-mono-export.ps1.
// payload: { bundlePath, outDir, nameFilter }
ipcMain.handle("dp2:tgl-mono-export", async (_e, payload) => {
  const { bundlePath, outDir, nameFilter } = payload || {};
  if (!bundlePath) return { ok: false, error: "bundlePath not set" };
  if (!outDir) return { ok: false, error: "outDir not set" };
  try { await fs.access(bundlePath); }
  catch { return { ok: false, error: "bundle not found: " + bundlePath }; }
  const settings = await readSettings();
  if (!settings.uabeaPath) return { ok: false, error: "UABEA not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/tgl-mono-export.ps1");
  try { await fs.mkdir(outDir, { recursive: true }); } catch {}
  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-BundlePath", bundlePath,
      "-OutDir", outDir,
      "-UabeaDir", uabeaDir,
    ];
    if (nameFilter) { args.push("-NameFilter", nameFilter); }
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    child.stdout.on("data", (d) => { allStdout += d.toString(); });
    child.stderr.on("data", (d) => { allStdout += d.toString(); });
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-15).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let summary = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: allStdout });
    });
  });
});

// TGL Mono Import: викликає tgl-mono-import.ps1.
// payload: { bundlePath, jsonPath, pathId? }
ipcMain.handle("dp2:tgl-mono-import", async (_e, payload) => {
  const { bundlePath, jsonPath, pathId } = payload || {};
  if (!bundlePath) return { ok: false, error: "bundlePath not set" };
  if (!jsonPath) return { ok: false, error: "jsonPath not set" };
  try { await fs.access(bundlePath); }
  catch { return { ok: false, error: "bundle not found: " + bundlePath }; }
  try { await fs.access(jsonPath); }
  catch { return { ok: false, error: "json not found: " + jsonPath }; }
  const settings = await readSettings();
  if (!settings.uabeaPath) return { ok: false, error: "UABEA not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/tgl-mono-import.ps1");
  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-BundlePath", bundlePath,
      "-JsonPath", jsonPath,
      "-UabeaDir", uabeaDir,
    ];
    if (pathId) { args.push("-PathId", String(pathId)); }
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let allStdout = "";
    child.stdout.on("data", (d) => { allStdout += d.toString(); });
    child.stderr.on("data", (d) => { allStdout += d.toString(); });
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-15).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let summary = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: allStdout });
    });
  });
});

// ── IPC: HBR Fonts (Atlas + MonoBehaviour dump) ─────────────────────────
// Step 2 після завантаження TMP_FontAssetCreator-тулзи: розпаковуємо з того ж
// bundle, де живе текст, SDF-атласи (Texture2D з "atlas" у m_Name) та
// TMP_FontAsset-MonoBehaviour (m_Name=FOT-…). Зберігаємо у toolsDir/HBR/Fonts/.

function hbrFontsRoot(settings) {
  if (!settings.toolsDir) return null;
  return path.join(settings.toolsDir, "HBR", "Fonts");
}

ipcMain.handle("dp2:hbr-fonts-status", async () => {
  const settings = await readSettings();
  const root = hbrFontsRoot(settings);
  if (!root) return { ok: false, error: "toolsDir not set" };
  const atlasDir = path.join(root, "Atlas");
  const monoDir = path.join(root, "MonoBehaviour");
  const list = async (d, ext) => {
    try {
      const items = await fs.readdir(d, { withFileTypes: true });
      return items.filter((x) => x.isFile() && x.name.toLowerCase().endsWith(ext)).map((x) => x.name);
    } catch { return []; }
  };
  const atlas = await list(atlasDir, ".png");
  const mono = await list(monoDir, ".json");
  const bundlePath = settings.hbrBundlePath || null;
  let bundleOk = false;
  if (bundlePath) { try { await fs.access(bundlePath); bundleOk = true; } catch {} }
  return {
    ok: true, root, atlasDir, monoDir,
    atlasCount: atlas.length, monoCount: mono.length,
    bundlePath, bundleOk,
  };
});

// Спільний раннер для обох scriptів — bundle + outDir + UabeaDir, стрім
// прогресу у відповідний канал.
async function hbrRunFontsScript({ scriptName, outSubdir, progressChannel }) {
  const settings = await readSettings();
  if (!settings.hbrBundlePath) return { ok: false, error: "hbrBundlePath not set" };
  try { await fs.access(settings.hbrBundlePath); }
  catch { return { ok: false, error: "bundle-not-found: " + settings.hbrBundlePath }; }
  if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const root = hbrFontsRoot(settings);
  if (!root) return { ok: false, error: "toolsDir not set" };
  const outDir = path.join(root, outSubdir);
  await fs.mkdir(outDir, { recursive: true });
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/" + scriptName);
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-BundlePath", settings.hbrBundlePath,
    "-OutDir", outDir,
    "-UabeaDir", uabeaDir,
  ];
  return await new Promise((resolve) => {
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
        try { win?.webContents.send(progressChannel, ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send(progressChannel, leftover); } catch {}
      }
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-15).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let summary = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, outDir, summary, log: allStdout });
    });
  });
}

ipcMain.handle("dp2:hbr-fonts-atlas-export", async () => {
  return await hbrRunFontsScript({
    scriptName: "hbr-fonts-atlas-export.ps1",
    outSubdir: "Atlas",
    progressChannel: "dp2:hbr-fonts-atlas-progress",
  });
});

ipcMain.handle("dp2:hbr-fonts-mono-export", async () => {
  return await hbrRunFontsScript({
    scriptName: "hbr-fonts-mono-export.ps1",
    outSubdir: "MonoBehaviour",
    progressChannel: "dp2:hbr-fonts-mono-progress",
  });
});

// Pack fonts back into the bundle — повертає JSON+PNG з HBR/Fonts/{MonoBehaviour,Atlas}
// у той самий bundle, де живе текст. Скрипт пише ОДНИМ uncompressed-Write —
// той самий патерн, що hbr-text-import, інакше Unity видає CRC mismatch.
ipcMain.handle("dp2:hbr-fonts-import", async () => {
  const settings = await readSettings();
  if (!settings.hbrBundlePath) return { ok: false, error: "hbrBundlePath not set" };
  try { await fs.access(settings.hbrBundlePath); }
  catch { return { ok: false, error: "bundle-not-found: " + settings.hbrBundlePath }; }
  if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const root = hbrFontsRoot(settings);
  if (!root) return { ok: false, error: "toolsDir not set" };
  const atlasDir = path.join(root, "Atlas");
  const monoDir = path.join(root, "MonoBehaviour");
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/hbr-fonts-import.ps1");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-BundlePath", settings.hbrBundlePath,
    "-AtlasDir", atlasDir,
    "-MonoDir", monoDir,
    "-UabeaDir", uabeaDir,
  ];
  return await new Promise((resolve) => {
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
        try { win?.webContents.send("dp2:hbr-fonts-import-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:hbr-fonts-import-progress", leftover); } catch {}
      }
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let summary = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: allStdout });
    });
  });
});

// Запустити TMPUnity.exe з teki FontGenerator. Detached + unref — щоб додаток
// не "тримав" процес TMPUnity і не падав разом з ним.
ipcMain.handle("dp2:hbr-fontgen-launch", async () => {
  const settings = await readSettings();
  if (!settings.toolsDir) return { ok: false, error: "toolsDir not set" };
  // hbrFontgenStatus повертає exePath — використаємо ту саму логіку, що й
  // editor: підкласти у root FontGenerator/<TMPUnity>.exe. Реальний exe
  // повертає сам hbr-fontgen-status (його ми вже маємо).
  // Тут просто беремо те, що hbr-fontgen-status поверне ззовні — і запускаємо.
  // Викликати інший хендлер з main process — некрасиво, тож копія мінімальної
  // логіки: пошук .exe у root.
  const root = path.join(settings.toolsDir, "HBR", "FontGenerator");
  let exePath = null;
  try {
    const items = await fs.readdir(root, { withFileTypes: true });
    const direct = items.find((x) => x.isFile() && /TMPUnity.*\.exe$/i.test(x.name));
    if (direct) exePath = path.join(root, direct.name);
    if (!exePath) {
      // Шукати в підтеках першого рівня.
      for (const sub of items) {
        if (!sub.isDirectory()) continue;
        try {
          const inner = await fs.readdir(path.join(root, sub.name), { withFileTypes: true });
          const hit = inner.find((x) => x.isFile() && /TMPUnity.*\.exe$/i.test(x.name));
          if (hit) { exePath = path.join(root, sub.name, hit.name); break; }
        } catch {}
      }
    }
  } catch { return { ok: false, error: "FontGenerator folder not found: " + root }; }
  if (!exePath) return { ok: false, error: "TMPUnity*.exe not found in " + root };
  try {
    const child = spawn(exePath, [], {
      detached: true, stdio: "ignore", cwd: path.dirname(exePath),
    });
    child.unref();
    return { ok: true, exePath };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// Запуск гри через steam://rungameid/<appId>.
ipcMain.handle("dp2:launch-steam-game", async (_e, appId) => {
  const id = String(appId || "").replace(/[^0-9]/g, "");
  if (!id) return { ok: false, error: "bad appId" };
  try {
    await shell.openExternal("steam://rungameid/" + id);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Build release: пак виконується звичайно, після успішного — копіюємо
// catalog.json + bundle у Documents/SWERY-Localization-Tool/HBR/release/
// з повторенням ігрової структури тек. Тоді користувач просто копіює
// release/* у корінь HOTEL BARCELONA/ — і одразу грає.
ipcMain.handle("dp2:hbr-build-release", async () => {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const bundlePath = settings.hbrBundlePath;
  if (!bundlePath) return { ok: false, error: "hbrBundlePath not set" };
  // Pack у гру напряму через спільну функцію (без ipcMain.listeners-хака —
  // ipcMain.handle не реєструє у listeners, тому той трюк давав
  // "pack handler missing").
  const packResult = await hbrRunPack();
  if (!packResult.ok) return { ok: false, error: packResult.error || "pack fail", packResult };

  try {
    // Структура: <toolsDir>/HBR/release/HOTEL BARCELONA_Data/StreamingAssets/aa/{catalog.json, StandaloneWindows64/<bundle>}
    const releaseRoot = path.join(toolsDir, "HBR", "release");
    // Очищаємо попередній release, щоб не змішувати старі/нові файли.
    try {
      await fs.rm(releaseRoot, { recursive: true, force: true });
    } catch {}
    const aaDir = path.dirname(path.dirname(bundlePath));   // .../aa
    const catalogSrc = path.join(aaDir, "catalog.json");
    const aaRelDst = path.join(releaseRoot, "HOTEL BARCELONA_Data", "StreamingAssets", "aa");
    const swDirDst = path.join(aaRelDst, "StandaloneWindows64");
    await fs.mkdir(swDirDst, { recursive: true });
    // catalog.json
    let catalogCopied = false;
    try { await fs.copyFile(catalogSrc, path.join(aaRelDst, "catalog.json")); catalogCopied = true; }
    catch (e) { return { ok: false, error: "Не вдалося скопіювати catalog.json: " + (e.message || e) }; }
    // Копіюємо всі _resources*.bundle (включно з DLC) — їх може бути кілька.
    const aaSwDir = path.dirname(bundlePath);
    let swEntries = []; try { swEntries = await fs.readdir(aaSwDir); } catch {}
    const bundlesToCopy = swEntries
      .filter((f) => /^_resources.*\.bundle$/i.test(f) && !f.endsWith(".bak"));
    const copiedBundles = [];
    let totalSize = 0;
    for (const bn of bundlesToCopy) {
      try {
        await fs.copyFile(path.join(aaSwDir, bn), path.join(swDirDst, bn));
        const st = await fs.stat(path.join(swDirDst, bn));
        copiedBundles.push({ name: bn, size: st.size });
        totalSize += st.size;
      } catch {}
    }
    const mainBundleName = path.basename(bundlePath);
    const mainEntry = copiedBundles.find((b) => b.name === mainBundleName);

    return {
      ok: true,
      releaseRoot,
      catalogCopied,
      bundleName: mainBundleName,
      bundleSize: mainEntry ? mainEntry.size : totalSize,
      bundles: copiedBundles,
      packSummary: packResult.summary,
      logPath: packResult.logPath,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Backup Done у BACKUPS/HotelBarcelona/<timestamp>/.
ipcMain.handle("dp2:hbr-backup-done", async () => {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const { doneDir } = await hbrTextDirs();
  try { await fs.access(doneDir); } catch { return { ok: false, error: "Done dir missing" }; }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bakRoot = path.join(toolsDir, "BACKUPS", "HotelBarcelona", ts, "Text_Done");
  async function copyRecursive(src, dst) {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) await copyRecursive(s, d);
      else await fs.copyFile(s, d);
    }
  }
  try {
    await copyRecursive(doneDir, bakRoot);
    return { ok: true, path: bakRoot };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Open HBR-related folder у Explorer.
ipcMain.handle("dp2:hbr-open-folder", async (_e, which) => {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const dirs = await hbrTextDirs();
  const map = {
    original: dirs.originalDir,
    done: dirs.doneDir,
    meta: dirs.metaDir,
    backups: path.join(toolsDir, "BACKUPS", "HotelBarcelona"),
    logs: path.join(toolsDir, "LOGS"),
    game: settings.hbrRoot || (settings.hbrBundlePath ? path.dirname(settings.hbrBundlePath) : null),
  };
  const target = map[which];
  if (!target) return { ok: false, error: "unknown folder: " + which };
  try { await fs.mkdir(target, { recursive: true }); } catch {}
  shell.openPath(target);
  return { ok: true, path: target };
});

ipcMain.handle("dp2:hbr-text-list", async () => {
  const { originalDir, doneDir } = await hbrTextDirs();
  const items = [];
  try {
    const files = await fs.readdir(doneDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      // Пропускаємо службові dot-файли (`.hbr-status.json` + його `.bak.json`,
      // `.preimport.bak.json` тощо). Ці sidecar-и не повинні з'являтись у списку.
      if (f.startsWith(".")) continue;
      const donePath = path.join(doneDir, f);
      const origPath = path.join(originalDir, f);
      let size = 0;
      try { const st = await fs.stat(donePath); size = st.size; } catch {}
      items.push({ file: f, donePath, origPath, size });
    }
  } catch {}
  items.sort((a, b) => a.file.localeCompare(b.file));
  return { ok: true, items, originalDir, doneDir };
});

ipcMain.handle("dp2:hbr-text-read", async (_e, fullPath) => {
  try {
    const raw = await fs.readFile(fullPath, "utf8");
    return { ok: true, raw };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle("dp2:hbr-text-write", async (_e, payload) => {
  const { fullPath, raw } = payload || {};
  if (!fullPath || typeof raw !== "string") return { ok: false, error: "bad args" };
  try {
    const safe = assertSafeWritePath(fullPath);
    return await withFileLock(safe, async () => {
      const bak = safe + ".bak";
      try { await fs.access(bak); }
      catch { try { await fs.copyFile(safe, bak); } catch {} }
      await fs.writeFile(safe, raw, "utf8");
      return { ok: true };
    });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Restore Done/<file>.json from its sibling .bak (created on first save).
ipcMain.handle("dp2:hbr-text-restore-bak", async (_e, fullPath) => {
  if (!fullPath || typeof fullPath !== "string") return { ok: false, error: "bad args" };
  try {
    const safe = assertSafeWritePath(fullPath);
    const bak = safe + ".bak";
    try { await fs.access(bak); }
    catch { return { ok: false, error: "no-bak" }; }
    return await withFileLock(safe, async () => {
      const raw = await fs.readFile(bak, "utf8");
      await fs.writeFile(safe, raw, "utf8");
      return { ok: true, raw };
    });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Compute corpus-wide translation stats for HBR (Done vs Original). Cheap
// enough to run on Home screen entry — 60 files × ~JSON.parse. Skipped if
// originalDir is missing (project not extracted yet).
ipcMain.handle("dp2:hbr-corpus-stats", async () => {
  try {
    const { originalDir, doneDir } = await hbrTextDirs();
    return await callHeavy("hbr-corpus-stats", { originalDir, doneDir });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ── HBR Font Generator (TMPUnity by MrIkso) ────────────────────────
// .zip via Dropbox direct link (dl=1 returns 302 to dl.dropboxusercontent.com).
// setupTools.downloadFile already follows redirects so this just works.
const HBR_FONTGEN_URL = "https://www.dropbox.com/scl/fi/zrf5k92drx89ttrey3nr9/TMPUnity.zip?rlkey=6aajtgdskxamh7davqyi3z6sz&st=nrb7tavk&dl=1";
function hbrFontGenDir() {
  const docs = app.getPath("documents");
  return path.join(docs, "SWERY-Localization-Tool", "HBR", "FontGenerator");
}
async function hbrFontGenExecutable() {
  // Best-effort lookup of the unpacked .exe (depth ≤ 3).
  const root = hbrFontGenDir();
  try { await fs.access(root); } catch { return null; }
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.shift();
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) stack.push({ dir: p, depth: depth + 1 }); }
      else if (e.isFile() && /\.exe$/i.test(e.name)) return p;
    }
  }
  return null;
}
ipcMain.handle("dp2:hbr-fontgen-status", async () => {
  const root = hbrFontGenDir();
  let installed = false; let exePath = null;
  try { await fs.access(root); installed = true; } catch {}
  if (installed) exePath = await hbrFontGenExecutable();
  return { ok: true, installed: !!exePath, root, exePath };
});
ipcMain.handle("dp2:hbr-fontgen-download", async () => {
  const root = hbrFontGenDir();
  const zipPath = path.join(root, "TMPUnity.zip");
  try {
    await fs.mkdir(root, { recursive: true });
    // Already unpacked? skip.
    const existing = await hbrFontGenExecutable();
    if (existing) {
      try {
        mainWindow?.webContents.send("dp2:hbr-fontgen-progress", {
          phase: "done", i18nKey: "hbr.fontgen.alreadyHave",
          total: 0, downloaded: 0, percent: 100, bytesPerSec: 0,
        });
      } catch {}
      return { ok: true, root, exePath: existing, alreadyExisted: true };
    }
    let lastEmit = 0; let lastBytes = 0; const startedAt = Date.now();
    try {
      mainWindow?.webContents.send("dp2:hbr-fontgen-progress", {
        phase: "download", i18nKey: "hbr.fontgen.downloading",
        i18nParams: { name: "TMPUnity.zip" },
        total: 0, downloaded: 0, percent: 0, bytesPerSec: 0,
      });
    } catch {}
    const res = await setupTools.downloadFile(HBR_FONTGEN_URL, zipPath, (p) => {
      const now = Date.now();
      const dt = (now - (lastEmit || startedAt)) / 1000;
      const bps = dt > 0 ? (p.downloaded - lastBytes) / dt : 0;
      lastEmit = now; lastBytes = p.downloaded;
      try {
        mainWindow?.webContents.send("dp2:hbr-fontgen-progress", {
          phase: "download", i18nKey: "hbr.fontgen.downloading",
          i18nParams: { name: "TMPUnity.zip" },
          total: p.total, downloaded: p.downloaded, percent: p.percent,
          bytesPerSec: bps,
        });
      } catch {}
    }, { skipIfExists: false });
    // Unpack.
    try {
      mainWindow?.webContents.send("dp2:hbr-fontgen-progress", {
        phase: "extract", i18nKey: "hbr.fontgen.extracting",
        total: res.bytes, downloaded: res.bytes, percent: 100, bytesPerSec: 0,
      });
    } catch {}
    await setupTools.extractZip(zipPath, root);
    await setupTools.flattenIfSingleSubdir(root);
    try { await fs.unlink(zipPath); } catch {}
    const exePath = await hbrFontGenExecutable();
    try {
      mainWindow?.webContents.send("dp2:hbr-fontgen-progress", {
        phase: "done", i18nKey: "hbr.fontgen.installed",
        total: res.bytes, downloaded: res.bytes, percent: 100, bytesPerSec: 0,
      });
    } catch {}
    return { ok: true, root, exePath, bytes: res.bytes };
  } catch (e) {
    try {
      mainWindow?.webContents.send("dp2:hbr-fontgen-progress", {
        phase: "error", message: String(e.message || e),
        total: 0, downloaded: 0, percent: 0, bytesPerSec: 0,
      });
    } catch {}
    return { ok: false, error: String(e.message || e) };
  }
});

// ── HBR external tool: CatalogTool.exe ─────────────────────────────
// Downloads a small helper exe into Documents/SWERY-Localization-Tool/
// so we can patch catalog.json/.bin during the pack step.
const CATALOG_TOOL_URL = "https://hikarosato.github.io/guide/tools/CatalogTool.exe";
function hbrCatalogToolPath() {
  const docs = app.getPath("documents");
  return path.join(docs, "SWERY-Localization-Tool", "CatalogTool.exe");
}
ipcMain.handle("dp2:hbr-tools-status", async () => {
  const dest = hbrCatalogToolPath();
  try {
    const st = await fs.stat(dest);
    return { ok: true, present: true, path: dest, size: st.size };
  } catch {
    return { ok: true, present: false, path: dest };
  }
});
ipcMain.handle("dp2:hbr-tools-download", async () => {
  const dest = hbrCatalogToolPath();
  try {
    try {
      const st = await fs.stat(dest);
      if (st.size > 0) {
        try {
          mainWindow?.webContents.send("dp2:hbr-tools-progress", {
            phase: "done", i18nKey: "hbr.tools.alreadyHave",
            total: st.size, downloaded: st.size, percent: 100, bytesPerSec: 0,
          });
        } catch {}
        return { ok: true, path: dest, alreadyExisted: true };
      }
    } catch {}
    let lastEmit = 0;
    let startedAt = Date.now();
    let lastBytes = 0;
    try {
      mainWindow?.webContents.send("dp2:hbr-tools-progress", {
        phase: "download", i18nKey: "hbr.tools.downloading",
        i18nParams: { name: "CatalogTool.exe" },
        total: 0, downloaded: 0, percent: 0, bytesPerSec: 0,
      });
    } catch {}
    const res = await setupTools.downloadFile(CATALOG_TOOL_URL, dest, (p) => {
      const now = Date.now();
      const dt = (now - (lastEmit || startedAt)) / 1000;
      const bps = dt > 0 ? (p.downloaded - lastBytes) / dt : 0;
      lastEmit = now;
      lastBytes = p.downloaded;
      try {
        mainWindow?.webContents.send("dp2:hbr-tools-progress", {
          phase: "download", i18nKey: "hbr.tools.downloading",
          i18nParams: { name: "CatalogTool.exe" },
          total: p.total, downloaded: p.downloaded, percent: p.percent,
          bytesPerSec: bps,
        });
      } catch {}
    }, { skipIfExists: false });
    try {
      mainWindow?.webContents.send("dp2:hbr-tools-progress", {
        phase: "done", i18nKey: "hbr.tools.downloaded",
        total: res.bytes, downloaded: res.bytes, percent: 100, bytesPerSec: 0,
      });
    } catch {}
    return { ok: true, path: res.destPath, bytes: res.bytes, alreadyExisted: !!res.alreadyExisted };
  } catch (e) {
    try {
      mainWindow?.webContents.send("dp2:hbr-tools-progress", {
        phase: "error", message: String(e.message || e),
        total: 0, downloaded: 0, percent: 0, bytesPerSec: 0,
      });
    } catch {}
    return { ok: false, error: String(e.message || e) };
  }
});

// Locate <hbrRoot>/HOTEL BARCELONA_Data/StreamingAssets/aa/ — directory that
// holds catalog.json. We need it to drag&drop catalog onto CatalogTool.exe.
async function hbrAaDir() {
  const settings = await readSettings();
  let aaDir = null;
  if (settings.hbrRoot) {
    aaDir = path.join(settings.hbrRoot, "HOTEL BARCELONA_Data", "StreamingAssets", "aa");
  } else if (settings.hbrBundlePath) {
    // aa = parent of StandaloneWindows64
    const parent = path.dirname(path.dirname(settings.hbrBundlePath));
    if (path.basename(parent) === "aa") aaDir = parent;
  }
  return aaDir;
}
ipcMain.handle("dp2:hbr-catalog-status", async () => {
  const aaDir = await hbrAaDir();
  if (!aaDir) return { ok: false, error: "aa directory not resolved (hbrRoot missing)" };
  const catalogJson = path.join(aaDir, "catalog.json");
  const catalogOld  = path.join(aaDir, "catalog.json.old");
  let hasCatalog = false; let hasOld = false;
  try { await fs.access(catalogJson); hasCatalog = true; } catch {}
  try { await fs.access(catalogOld); hasOld = true; } catch {}
  return { ok: true, aaDir, catalogJson, catalogOld, hasCatalog, hasOld };
});
ipcMain.handle("dp2:hbr-catalog-patch", async () => {
  const aaDir = await hbrAaDir();
  if (!aaDir) return { ok: false, error: "aa directory not resolved (hbrRoot missing)" };
  const catalogJson = path.join(aaDir, "catalog.json");
  const catalogOld  = path.join(aaDir, "catalog.json.old");
  try { await fs.access(catalogJson); }
  catch { return { ok: false, error: "catalog.json not found: " + catalogJson }; }
  // Already patched — nothing to do.
  try {
    await fs.access(catalogOld);
    return { ok: true, alreadyPatched: true, catalogJson, catalogOld };
  } catch {}
  const toolSrc = hbrCatalogToolPath();
  try { await fs.access(toolSrc); }
  catch { return { ok: false, error: "CatalogTool.exe not downloaded yet" }; }
  const toolDst = path.join(aaDir, "CatalogTool.exe");
  try { await fs.copyFile(toolSrc, toolDst); }
  catch (e) { return { ok: false, error: "copy tool to aa fail: " + (e.message || e) }; }
  // Drag&drop = launch the exe with the file path as argv[1]. Run with
  // cwd=aaDir so any relative writes (catalog.json.old) land next to it.
  const cp = require("child_process");
  const exitInfo = await new Promise((resolve) => {
    let settled = false;
    const ps = cp.spawn(toolDst, [catalogJson], { cwd: aaDir, windowsHide: true });
    ps.on("error", (err) => { if (!settled) { settled = true; resolve({ ok: false, error: String(err.message || err) }); } });
    ps.on("close", (code) => { if (!settled) { settled = true; resolve({ ok: true, code }); } });
  });
  // Whatever the exit code — try to verify the artifact and clean up.
  let patched = false;
  try { await fs.access(catalogOld); patched = true; } catch {}
  try { await fs.unlink(toolDst); } catch {}
  if (!exitInfo.ok) return { ok: false, error: exitInfo.error || "CatalogTool launch fail" };
  if (!patched) return { ok: false, error: "CatalogTool ran (exit " + exitInfo.code + ") but catalog.json.old not produced" };
  return { ok: true, alreadyPatched: false, catalogJson, catalogOld };
});

ipcMain.handle("dp2:hbr-text-prep-mirror", async (_e, payload) => {
  const { overwrite } = payload || {};
  const { originalDir, doneDir } = await hbrTextDirs();
  try { await fs.mkdir(doneDir, { recursive: true }); } catch (e) {
    return { ok: false, error: "mkdir fail: " + (e.message || e) };
  }
  let files = [];
  try { files = await fs.readdir(originalDir); } catch { return { ok: false, error: "Original not found" }; }
  const copied = []; const skipped = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const src = path.join(originalDir, f);
    const dst = path.join(doneDir, f);
    let dstExists = false;
    try { await fs.access(dst); dstExists = true; } catch {}
    if (dstExists && !overwrite) { skipped.push(f); continue; }
    try { await fs.copyFile(src, dst); copied.push(f); }
    catch (e) { return { ok: false, error: `copy fail (${f}): ${e.message || e}`, copied, skipped }; }
  }
  return { ok: true, copied, skipped, doneDir };
});

ipcMain.handle("dp2:text-prep-status", async (_e, payload) => {
  const { assetsPath, requiredFiles } = payload || {};
  if (!assetsPath || !Array.isArray(requiredFiles)) {
    return { ok: false, error: "bad args" };
  }
  try {
    await fs.access(assetsPath);
  } catch {
    return { ok: false, error: "assets-not-found", assetsPath };
  }
  const { originalDir, doneDir } = await dp2TextDirs();
  const gameDir = path.dirname(assetsPath);
  const result = {
    ok: true,
    gameDir,
    originalDir,
    doneDir,
    originalExisting: [],
    originalMissing: [],
    doneExisting: [],
    doneMissing: [],
  };
  for (const entry of requiredFiles) {
    const name = typeof entry === "string" ? entry : entry.file;
    const orig = dp2TextLocate(originalDir, entry);
    const done = dp2TextLocate(doneDir, entry);
    try { await fs.access(orig); result.originalExisting.push(name); }
    catch { result.originalMissing.push(name); }
    try { await fs.access(done); result.doneExisting.push(name); }
    catch { result.doneMissing.push(name); }
  }
  return result;
});

ipcMain.handle("dp2:text-prep-extract", async (_e, payload) => {
  const { assetsPath, pathIds, entries } = payload || {};
  if (!assetsPath || !Array.isArray(pathIds) || pathIds.length === 0) {
    return { ok: false, error: "bad args" };
  }
  try { await fs.access(assetsPath); }
  catch { return { ok: false, error: "assets-not-found: " + assetsPath }; }

  const settings = await readSettings();
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA не задано (Налаштування)" };

  const { originalDir: outDir } = await dp2TextDirs();
  try {
    await fs.mkdir(outDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "Не вдалося створити TEXT/ORIGINAL: " + (e.message || e) };
  }
  // Mapping pathId → category для післе-extract sort у підпапки.
  const pidToEntry = new Map();
  if (Array.isArray(entries)) {
    for (const e of entries) if (e && e.pathId != null) pidToEntry.set(Number(e.pathId), e);
  }

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/dp2-text-export.ps1");

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", assetsPath,
      "-OutDir", outDir,
      "-UabeaDir", uabeaDir,
      "-PathIds", pathIds.join(","),
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
        try { win?.webContents.send("dp2:text-prep-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: allStdout }));
    child.on("exit", async (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:text-prep-progress", leftover); } catch {}
      }
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: allStdout, outDir });
        return;
      }
      let summary = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      // Розкладаємо по підпапках за категорією: <outDir>/<category>/<file>.
      if (summary && Array.isArray(summary.exported) && pidToEntry.size > 0) {
        for (const it of summary.exported) {
          const entry = pidToEntry.get(Number(it.pathId));
          if (!entry || !entry.category) continue;
          try {
            const subDir = path.join(outDir, entry.category);
            await fs.mkdir(subDir, { recursive: true });
            const dst = path.join(subDir, entry.file);
            await fs.rename(it.file, dst);
            it.file = dst;
          } catch {}
        }
      }
      // Backward-compat cleanup: видаляємо будь-які JSON-файли, що лежать у
      // корені outDir з очікуваним іменем (попередні версії клали плоско),
      // якщо їхня категоризована копія вже існує у subdir.
      if (pidToEntry.size > 0) {
        for (const entry of pidToEntry.values()) {
          if (!entry || !entry.category || !entry.file) continue;
          const flat = path.join(outDir, entry.file);
          const inSub = path.join(outDir, entry.category, entry.file);
          try {
            await fs.access(inSub);
            // Якщо субдиректорна копія є — старий плоский файл і його .bak
            // безпечно видалити.
            try { await fs.unlink(flat); } catch {}
            try { await fs.unlink(flat + ".bak"); } catch {}
          } catch {}
        }
      }
      resolve({ ok: true, outDir, summary, log: allStdout });
    });
  });
});

ipcMain.handle("dp2:text-prep-copy-to-done", async (_e, payload) => {
  const { originalDir, doneDir, requiredFiles, overwrite } = payload || {};
  if (!originalDir || !doneDir || !Array.isArray(requiredFiles)) {
    return { ok: false, error: "bad args" };
  }
  try {
    await fs.mkdir(doneDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "mkdir fail: " + (e.message || e) };
  }
  const copied = [];
  const skipped = [];
  const missingSource = [];
  for (const entry of requiredFiles) {
    const name = typeof entry === "string" ? entry : entry.file;
    const src = dp2TextLocate(originalDir, entry);
    const dst = dp2TextLocate(doneDir, entry);
    try { await fs.access(src); }
    catch { missingSource.push(name); continue; }
    let dstExists = false;
    try { await fs.access(dst); dstExists = true; } catch {}
    if (dstExists && !overwrite) { skipped.push(name); continue; }
    try {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      copied.push(name);
    } catch (e) {
      return { ok: false, error: `copy fail (${name}): ${e.message || e}`, copied, skipped };
    }
  }
  // Backward-compat cleanup: видаляємо плоскі дублікати у корені doneDir
  // (попередня версія програми клала файли без підпапок) — щоб вони не
  // дублювалися в дереві файлів editor-а.
  for (const entry of requiredFiles) {
    if (typeof entry === "string" || !entry.category || !entry.file) continue;
    const flatDone = path.join(doneDir, entry.file);
    const flatOrig = path.join(originalDir, entry.file);
    const subDone = path.join(doneDir, entry.category, entry.file);
    try {
      await fs.access(subDone);
      try { await fs.unlink(flatDone); } catch {}
      try { await fs.unlink(flatDone + ".bak"); } catch {}
      try { await fs.unlink(flatOrig); } catch {}
      try { await fs.unlink(flatOrig + ".bak"); } catch {}
    } catch {}
  }
  return { ok: true, copied, skipped, missingSource };
});

// ── IPC: build .assets via PowerShell + AssetsTools.NET ─────────
// Один клік — отримуємо локалізований .assets файл поруч з оригіналом.
// Викликає import-to-assets.ps1, який імпортує всі JSON-дампи з теки
// у MonoBehaviour'и за PathID-збігом і записує новий .assets.
ipcMain.handle("dp2:build-assets", async () => {
  const settings = await readSettings();
  const { uabeaPath, assetsPath, lastFolder } = settings;
  if (!assetsPath) return { success: false, error: "DP2 game path not set — open the prep wizard first" };
  if (!lastFolder) return { success: false, error: "Спочатку відкрий теку з JSON-дампами" };
  if (!uabeaPath)  return { success: false, error: "UABEA path not set (DLLs + classdata.tpk required)" };

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

      if (code !== 0) {
        // Показуємо stderr + останні 30 рядків stdout (DIAG/STEP включно).
        const tail = stdout.split("\n").slice(-30).join("\n").trim();
        const errMsg =
          (stderr.trim()
            ? stderr.trim() + (tail ? "\n\n--- last log lines ---\n" + tail : "")
            : tail) || `Exit code ${code}`;
        resolve({ success: false, error: errMsg, logPath, log: fullLog });
        return;
      }
      // Фаза 2: UILabel («Інші рядки») у sharedassets1.assets. Робимо тільки
      // якщо у Others/Done щось є. Помилка тут не валить весь build — корпус
      // уже зібраний у фазі 1.
      const others = await runOthersImport(pwshLookup, settings).catch((e) => ({ ok: false, error: String(e.message || e) }));
      resolve({
        success: true,
        outputPath,
        logPath,
        log: fullLog,
        others,
      });
    });
  });
});

// Фаза 2 «Зберегти та зібрати»: пакує UILabel-Done JSON-и у sharedassets1.assets.
// Викликається після успішного імпорту корпусу (sharedassets0). Якщо у
// `Others/Done` нічого нема — повертає { ok: true, imported: 0, skipped: true }.
async function runOthersImport(pwshLookup, settings) {
  const doneDir = await dp2OthersDoneDir();
  let hasAny = false;
  try {
    const ents = await fs.readdir(doneDir, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile() || !e.name.startsWith("UILabel-") || !e.name.endsWith(".json")) continue;
      if (e.name.endsWith(".bak.json")) continue;
      hasAny = true; break;
    }
  } catch { /* теки нема — просто скіп */ }
  if (!hasAny) return { ok: true, imported: 0, skipped: true, reason: "empty-others" };

  const sharedAssets1 = await dp2Sharedassets1Path();
  if (!sharedAssets1) return { ok: false, error: "DP2 path not set (sharedassets1)" };
  try { await fs.access(sharedAssets1); }
  catch { return { ok: false, error: "sharedassets1.assets not found: " + sharedAssets1 }; }

  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/dp2-others-import.ps1");

  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", sharedAssets1,
      "-JsonDir", doneDir,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", async (code) => {
      const logPath = path.join(path.dirname(sharedAssets1), "dp2-others-import.log");
      const ts = new Date().toISOString();
      const fullLog =
        `=== DP2 Others import @ ${ts} (exit=${code}) ===\n` +
        `assets: ${sharedAssets1}\n` +
        `jsonDir: ${doneDir}\n\n` +
        `--- STDOUT ---\n${stdout}\n` +
        `--- STDERR ---\n${stderr}\n`;
      try { await fs.writeFile(logPath, fullLog, "utf8"); } catch {}

      if (code !== 0) {
        const tail = stdout.split("\n").slice(-20).join("\n").trim();
        resolve({ ok: false, error: stderr.trim() || tail || `Exit ${code}`, logPath });
        return;
      }
      let summary = null;
      const m = stdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, logPath });
    });
  });
}

// ── IPC: DP2 Textures (resources.assets + .resS in-place patch) ─────────
// Експорт усіх або вибраних PathID у PNG; заміна окремого PathID одним
// PNG-файлом. Скрипти кодекують DXT5/BC через UABEA native libs.

ipcMain.handle("dp2:textures-export", async (_e, payload) => {
  const settings = await readSettings();
  const { uabeaPath } = settings;
  const assetsFile = (payload && payload.assetsFile) || "resources.assets";
  const pathIds = (payload && Array.isArray(payload.pathIds)) ? payload.pathIds : null;
  if (!settings.assetsPath) return { success: false, error: "DP2 game path not set — open the prep wizard first" };
  if (!uabeaPath) return { success: false, error: "UABEA path not set" };

  // resources.assets лежить у тій самій теці, що sharedassets0.assets
  // (settings.assetsPath). Тож беремо parent dir + assetsFile.
  const gameDir = path.dirname(settings.assetsPath);
  const fullAssets = path.join(gameDir, assetsFile);
  try { await fs.access(fullAssets); }
  catch { return { success: false, error: ".assets не знайдено: " + fullAssets }; }

  let toolsDir = settings.toolsDir;
  if (!toolsDir) {
    toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
    await writeSettings({ ...settings, toolsDir });
  }
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 не знайдено" };

  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/textures-export.ps1");
  const outDir = path.join(toolsDir, "DP2", "Textures");
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
    let leftover = "";
    const win = BrowserWindow.getAllWindows()[0];
    const emit = (chunk) => {
      allStdout += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { win?.webContents.send("dp2:textures-export-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:textures-export-progress", leftover); } catch {}
      }
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
  if (!settings.assetsPath) return { success: false, error: "DP2 game path not set" };
  if (!uabeaPath) return { success: false, error: "UABEA path not set" };
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
  const dir = path.join(settings.toolsDir, "DP2", "Textures");
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

// ── IPC: HBR Textures (bundle in-place patch via UABEA / AssetsTools.NET) ─
// Експорт PathID → PNG; заміна одного або кількох PathID за списком. Bundle
// перезаписується ОДНИМ uncompressed-Write (як hbr-text-import / hbr-fonts-
// import). .textures.bak створюється ОДИН РАЗ при першому replace.

function hbrTexturesRoot(settings) {
  if (!settings.toolsDir) return null;
  return path.join(settings.toolsDir, "HBR", "Textures");
}
function hbrTexturesUnpackDir(settings) {
  const root = hbrTexturesRoot(settings);
  return root ? path.join(root, "Unpack") : null;
}

ipcMain.handle("dp2:hbr-textures-status", async () => {
  const settings = await readSettings();
  const unpack = hbrTexturesUnpackDir(settings);
  const bundlePath = settings.hbrBundlePath || null;
  let bundleOk = false;
  if (bundlePath) { try { await fs.access(bundlePath); bundleOk = true; } catch {} }
  if (!unpack) return { ok: false, error: "toolsDir not set", bundlePath, bundleOk };
  let count = 0;
  try {
    const items = await fs.readdir(unpack, { withFileTypes: true });
    count = items.filter((x) => x.isFile() && /\.png$/i.test(x.name)).length;
  } catch {}
  return { ok: true, unpackDir: unpack, count, bundlePath, bundleOk };
});

ipcMain.handle("dp2:hbr-textures-export", async (_e, payload) => {
  const settings = await readSettings();
  if (!settings.hbrBundlePath) return { success: false, error: "hbrBundlePath not set — open HBR text first to pick the game folder" };
  try { await fs.access(settings.hbrBundlePath); }
  catch { return { success: false, error: "bundle-not-found: " + settings.hbrBundlePath }; }
  if (!settings.uabeaPath) return { success: false, error: "UABEA path not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 not found" };
  const unpack = hbrTexturesUnpackDir(settings);
  if (!unpack) return { success: false, error: "toolsDir not set" };
  await fs.mkdir(unpack, { recursive: true });
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/hbr-textures-export.ps1");

  const pathIds = (payload && Array.isArray(payload.pathIds)) ? payload.pathIds.map(String) : null;

  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-BundlePath", settings.hbrBundlePath,
    "-OutDir", unpack,
    "-UabeaDir", uabeaDir,
  ];
  if (pathIds && pathIds.length) {
    args.push("-PathIds", pathIds.join(","));
  }

  return await new Promise((resolve) => {
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
        try { win?.webContents.send("dp2:hbr-textures-export-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:hbr-textures-export-progress", leftover); } catch {}
      }
      if (code !== 0) {
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        resolve({ success: false, error: tail || `Exit ${code}`, log: allStdout });
        return;
      }
      let summary = null;
      const m = allStdout.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ success: true, outDir: unpack, summary, log: allStdout });
    });
  });
});

ipcMain.handle("dp2:hbr-textures-replace", async (_e, payload) => {
  const settings = await readSettings();
  if (!settings.hbrBundlePath) return { success: false, error: "hbrBundlePath not set" };
  try { await fs.access(settings.hbrBundlePath); }
  catch { return { success: false, error: "bundle-not-found: " + settings.hbrBundlePath }; }
  if (!settings.uabeaPath) return { success: false, error: "UABEA path not set" };

  // Очікуємо payload: { items: [{ pathId: "<int64-string>", pngPath: "C:\\..." }, ...] }
  const items = (payload && Array.isArray(payload.items)) ? payload.items : null;
  if (!items || !items.length) return { success: false, error: "Не задано список замін (items)" };

  // Pre-validate у Node-частині (fail fast, до запуску PowerShell).
  for (const it of items) {
    if (!it || !it.pathId) return { success: false, error: "items: missing pathId" };
    if (!it.pngPath) return { success: false, error: "items: missing pngPath" };
    try { await fs.access(it.pngPath); }
    catch { return { success: false, error: "PNG not found: " + it.pngPath }; }
  }

  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { success: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/hbr-textures-replace.ps1");

  // JSON-payload передаємо через файл — args з \-шляхами і UTF-8 ламаються
  // при escapinng через PowerShell -ArgumentList.
  const root = hbrTexturesRoot(settings);
  if (!root) return { success: false, error: "toolsDir not set" };
  await fs.mkdir(root, { recursive: true });
  const inputJsonPath = path.join(root, "_replace-input.json");
  const payloadJson = items.map((it) => ({ pathId: String(it.pathId), pngPath: String(it.pngPath) }));
  await fs.writeFile(inputJsonPath, JSON.stringify(payloadJson, null, 2), "utf8");

  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-BundlePath", settings.hbrBundlePath,
    "-UabeaDir", uabeaDir,
    "-InputJson", inputJsonPath,
  ];

  return await new Promise((resolve) => {
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
        try { win?.webContents.send("dp2:hbr-textures-replace-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ success: false, error: err.message }));
    child.on("exit", (code) => {
      if (leftover.trim()) {
        try { win?.webContents.send("dp2:hbr-textures-replace-progress", leftover); } catch {}
      }
      // Підчистка input.json — він уже не потрібен.
      fs.unlink(inputJsonPath).catch(() => {});
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

ipcMain.handle("dp2:hbr-textures-list", async () => {
  const settings = await readSettings();
  const dir = hbrTexturesUnpackDir(settings);
  if (!dir) return { dir: null, files: [] };
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

ipcMain.handle("dp2:hbr-textures-read-base64", async (_e, filePath) => {
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
    const extractDir = path.join(settings.toolsDir, "TGL", "Fonts");
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
    const safe = assertSafeWritePath(jsonPath);
    return await withFileLock(safe, async () => {
      const bak = safe + ".bak";
      try { await fs.access(bak); }
      catch { await fs.copyFile(safe, bak); }
      await fs.writeFile(safe, content, "utf8");
      return { ok: true, bakPath: bak };
    });
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
    toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  }
  // Запам'ятовуємо cabPath, щоб наступного разу не запитувати — toolsDir теж.
  try { await writeSettings({ ...settings, toolsDir, tglCabPath: cabPath }); } catch {}
  const outDir = path.join(toolsDir, "TGL", "Fonts");
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
        // pwsh показав help → один з аргументів не дійшов. Повертаємо
        // фактичну командну строку, щоб бачити що саме передавалось.
        const cmdline = `${pwshLookup} ${args.map((a) => /\s/.test(a) ? `"${a}"` : a).join(" ")}`;
        const tail = allStdout.split("\n").slice(-20).join("\n").trim();
        if (/Usage:|pwsh\[\.exe\]/.test(allStdout)) {
          resolve({ ok: false, error: `PowerShell не зрозумів параметри. Перевір налаштування шляху до pwsh.exe.\n\nКомандна строка:\n${cmdline}\n\n${tail}`, log: allStdout });
          return;
        }
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
    const safe = assertSafeWritePath(pngPath);
    return await withFileLock(safe, async () => {
      const bak = safe + ".bak";
      try { await fs.access(bak); }
      catch { await fs.copyFile(safe, bak); }
      await fs.writeFile(safe, Buffer.from(base64, "base64"));
      return { ok: true, bakPath: bak };
    });
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

// ── IPC: TGL text Monaco-editor (Documents/SWERY/TGL/Text/TRANSLATION) ──
// Користувач хотів повноцінний Monaco-редактор для TGL замість list-view.
// Файл-перекладу живе у `Documents\SWERY-Localization-Tool\TGL\Text\
// TRANSLATION\<binName>.txt` і ДЗЕРКАЛИТЬСЯ у поточний `<binPath>.txt`
// workfile, щоб існуюча pack-логіка (heavy-worker 'tgl-pack') бачила
// останні зміни без додаткових змін.
async function tglTextDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) {
    toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  }
  const baseDir = path.join(toolsDir, "TGL", "Text");
  return {
    baseDir,
    originalDir: path.join(baseDir, "ORIGINAL"),
    translationDir: path.join(baseDir, "TRANSLATION"),
  };
}

function tglBinName(binPath) {
  return path.basename(binPath).replace(/\.bin$/i, "");
}

ipcMain.handle("dp2:tgl-text-prep", async (_event, payload) => {
  const binPath = String((payload && payload.binPath) || "").trim();
  if (!binPath) return { ok: false, error: "binPath not set" };
  try { await fs.access(binPath); }
  catch { return { ok: false, error: "bin not found: " + binPath }; }
  const { translationDir, originalDir } = await tglTextDirs();
  await fs.mkdir(translationDir, { recursive: true });
  await fs.mkdir(originalDir, { recursive: true });
  const base = tglBinName(binPath);
  const translationPath = path.join(translationDir, `${base}.txt`);
  const originalPath = path.join(originalDir, `${base}.txt`);

  // Завантажуємо .bin через heavy worker — отримуємо EN records + поточний UA.
  let load;
  try { load = await callHeavy("tgl-load", { binPath }); }
  catch (e) { return { ok: false, error: "tgl-load: " + (e.message || e) }; }
  const records = Array.isArray(load.records) ? load.records : [];
  const uaArr = Array.isArray(load.ua) ? load.ua : [];
  const originalLines = records.map((r) => String(r.en ?? ""));

  // ORIGINAL: завжди оновлюємо (snapshot EN з .bin для read-only-перегляду).
  const originalContent = originalLines.join("\n");
  try { await fs.writeFile(originalPath, originalContent, "utf8"); } catch {}

  // TRANSLATION: якщо файл уже існує — беремо його. Інакше — з workfile
  // (binPath + ".txt") якщо є, інакше — копія EN.
  let translationContent;
  try {
    translationContent = await fs.readFile(translationPath, "utf8");
  } catch {
    try {
      translationContent = await fs.readFile(binPath + ".txt", "utf8");
    } catch {
      translationContent = uaArr.length === records.length
        ? uaArr.join("\n")
        : originalContent;
    }
    try { await fs.writeFile(translationPath, translationContent, "utf8"); } catch {}
  }
  return {
    ok: true,
    binName: base,
    translationPath,
    originalPath,
    originalContent,
    translationContent,
    lineCount: records.length,
  };
});

ipcMain.handle("dp2:tgl-text-write", async (_event, payload) => {
  const binPath = String((payload && payload.binPath) || "").trim();
  const content = String((payload && payload.content) ?? "");
  if (!binPath) return { ok: false, error: "binPath not set" };
  const { translationDir } = await tglTextDirs();
  await fs.mkdir(translationDir, { recursive: true });
  const translationPath = path.join(translationDir, `${tglBinName(binPath)}.txt`);
  try {
    await fs.writeFile(translationPath, content, "utf8");
    // Дзеркалимо у workfile поряд з .bin — pack-логіка читає звідти.
    try { await fs.writeFile(binPath + ".txt", content, "utf8"); } catch {}
    return { ok: true, translationPath };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// ── IPC: THE MISSING text pipeline ───────────────────────────────
async function missingTextDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "MISSING", "Text");
  return {
    baseDir,
    originalDir: path.join(baseDir, "Original"),
    doneDir: path.join(baseDir, "Done"),
    metaDir: path.join(baseDir, "Meta"),
    metaFile: path.join(baseDir, "Meta", "missing-meta.json"),
  };
}

// «Зібрати білд для релізу» — копіює усі модифіковані ігрові файли (ті, для
// яких є .bak) у `<docs>/SWERY-Localization-Tool/MISSING/Release/<relative-path>`.
// Логіка: рекурсивно обходимо <gameData> і його підтеки, шукаємо `*.bak`, для
// кожного знайденого backup-файла копіюємо «живий» counterpart (без .bak/.tex.bak/
// .resS.bak/.uitxt.bak/.dll.bak суфіксів). Це дає мінімальний набір файлів, які
// користувач має покласти у свою гру, щоб отримати локалізацію.
ipcMain.handle("dp2:missing-build-release", async () => {
  try {
    const settings = await readSettings();
    const assetsPath = settings.missingAssetsPath;
    if (!assetsPath) return { ok: false, error: "missingAssetsPath не задано" };
    const dataDir = path.dirname(assetsPath); // ...\TheMISSING_Data
    // Корінь гри = parent від data-dir (на випадок, якщо колись треба буде
    // включати щось поза _Data, типу Steam-DRM patches). Зараз обмежуємось
    // самим _Data.
    const gameRoot = path.dirname(dataDir);
    const toolsDir = settings.toolsDir || path.join(app.getPath("documents"), "SWERY-Localization-Tool");
    const releaseDir = path.join(toolsDir, "MISSING", "Release");

    // Розпізнаємо різні .bak-суфікси, які наш pipeline створює.
    const BAK_SUFFIXES = [".bak", ".tex.bak", ".resS.bak", ".uitxt.bak", ".dll.bak"];
    function stripBak(name) {
      for (const s of BAK_SUFFIXES) {
        if (name.toLowerCase().endsWith(s)) return name.slice(0, -s.length);
      }
      return null;
    }

    // Рекурсивний walk з обмеженням на 4 рівні (без сюрпризів типу __MACOSX).
    const found = [];
    async function walk(dir, depth) {
      if (depth > 4) return;
      let ents;
      try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p, depth + 1);
          continue;
        }
        const liveName = stripBak(e.name);
        if (!liveName) continue;
        const live = path.join(dir, liveName);
        try { await fs.access(live); } catch { continue; } // нема живого counterpart'у
        found.push(live);
      }
    }
    await walk(dataDir, 0);

    if (found.length === 0) {
      return { ok: false, error: "Не знайдено жодного модифікованого файлу (.bak відсутні). Спочатку запакуй текст/текстури/шрифти/DLL у гру." };
    }

    // Чистимо попередню Release-теку (щоб не лишалися застарілі файли).
    try { await fs.rm(releaseDir, { recursive: true, force: true }); } catch {}
    await fs.mkdir(releaseDir, { recursive: true });

    const filesCopied = [];
    let totalSize = 0;
    for (const src of found) {
      const rel = path.relative(gameRoot, src);
      const dst = path.join(releaseDir, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      const st = await fs.stat(dst);
      filesCopied.push({ rel: rel.replace(/\\/g, "/"), size: st.size });
      totalSize += st.size;
    }

    // Шапка з версією + датою + інструкція як використати реліз.
    let pkgVersion = "?";
    try { pkgVersion = require("../package.json").version; } catch {}
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const lines = [
      `# THE MISSING — Ukrainian Localization Release`,
      `# Built: ${ts}`,
      `# Tool version: SWERY Localization Tool v${pkgVersion}`,
      `#`,
      `# Інструкція:`,
      `#  1. Закрий гру.`,
      `#  2. Зроби резервну копію оригінальних файлів зі своєї гри (на випадок).`,
      `#  3. Скопіюй увесь вміст цієї теки у корінь TheMISSING (де лежить TheMISSING.exe),`,
      `#     ПЕРЕЗАПИШИ існуючі файли. Відносна структура збережена.`,
      `#  4. Запускай гру через Steam — українська локалізація буде активна.`,
      `#`,
      `# Файли (${filesCopied.length}, ${(totalSize / (1024*1024)).toFixed(1)} MB):`,
      ``,
      ...filesCopied.map((f) => `  ${f.rel}  (${(f.size / (1024*1024)).toFixed(2)} MB)`),
    ];
    await fs.writeFile(path.join(releaseDir, "README.txt"), lines.join("\r\n"), "utf8");

    return {
      ok: true,
      releaseDir,
      files: filesCopied,
      count: filesCopied.length,
      totalSize,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("dp2:missing-prep-status", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath || null;
  let assetsOk = false;
  try { if (assetsPath) { await fs.access(assetsPath); assetsOk = true; } } catch {}
  const { originalDir, doneDir, metaFile } = await missingTextDirs();
  let originalCount = 0, doneCount = 0, metaExists = false;
  try { const e = await fs.readdir(originalDir); originalCount = e.filter((f) => f.endsWith(".dat")).length; } catch {}
  try { const e = await fs.readdir(doneDir); doneCount = e.filter((f) => f.endsWith(".dat")).length; } catch {}
  try { await fs.access(metaFile); metaExists = true; } catch {}
  return { ok: true, assetsPath, assetsOk, originalDir, doneDir, metaFile, metaExists, originalCount, doneCount };
});

ipcMain.handle("dp2:missing-prep-extract", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath;
  if (!assetsPath) return { ok: false, error: "missingAssetsPath not set" };
  try { await fs.access(assetsPath); }
  catch { return { ok: false, error: "assets-not-found: " + assetsPath }; }
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const { originalDir, metaFile } = await missingTextDirs();
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(path.dirname(metaFile), { recursive: true });
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/missing-text-export.ps1");
  const win = BrowserWindow.getAllWindows()[0];
  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", assetsPath,
      "-OutDir", originalDir,
      "-MetaPath", metaFile,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let leftover = "", all = "";
    const emit = (chunk) => {
      all += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { win?.webContents.send("dp2:missing-prep-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: all }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = all.split("\n").slice(-25).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: all });
        return;
      }
      let summary = null;
      const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: all });
    });
  });
});

ipcMain.handle("dp2:missing-text-list", async () => {
  const { originalDir, doneDir, metaFile } = await missingTextDirs();
  let metaItems = [];
  try {
    const raw = await fs.readFile(metaFile, "utf8");
    const m = JSON.parse(raw);
    if (Array.isArray(m.items)) metaItems = m.items;
  } catch {}
  // Доповнюємо метою інфо про наявність Original/Done.
  const items = [];
  for (const it of metaItems) {
    const origPath = path.join(originalDir, it.file);
    const donePath = path.join(doneDir, it.file);
    let hasOrig = false, hasDone = false;
    try { await fs.access(origPath); hasOrig = true; } catch {}
    try { await fs.access(donePath); hasDone = true; } catch {}
    items.push({
      name: it.name,
      file: it.file,
      pathId: String(it.pathId),
      scriptLen: it.scriptLen || 0,
      origPath, donePath,
      hasOrig, hasDone,
    });
  }
  return { ok: true, items };
});

ipcMain.handle("dp2:missing-text-read", async (_e, fullPath) => {
  try {
    const buf = await fs.readFile(String(fullPath));
    // Повертаємо base64 — JS-парсер у renderer перетворить у Uint8Array.
    return { ok: true, base64: buf.toString("base64") };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:missing-text-write", async (_e, payload) => {
  const fullPath = String((payload && payload.fullPath) || "").trim();
  const base64 = String((payload && payload.base64) || "");
  if (!fullPath || !base64) return { ok: false, error: "fullPath/base64 missing" };
  try {
    const safe = assertSafeWritePath(fullPath);
    return await withFileLock(safe, async () => {
      await fs.mkdir(path.dirname(safe), { recursive: true });
      await fs.writeFile(safe, Buffer.from(base64, "base64"));
      return { ok: true };
    });
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:missing-pack", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath;
  if (!assetsPath) return { ok: false, error: "missingAssetsPath not set" };
  try { await fs.access(assetsPath); }
  catch { return { ok: false, error: "assets-not-found: " + assetsPath }; }
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const { doneDir, metaFile } = await missingTextDirs();
  try { await fs.access(doneDir); } catch { return { ok: false, error: "Done dir empty" }; }
  try { await fs.access(metaFile); } catch { return { ok: false, error: "Meta missing — run extract first" }; }
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/missing-text-import.ps1");
  const win = BrowserWindow.getAllWindows()[0];
  return await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-AssetsPath", assetsPath,
      "-DoneDir", doneDir,
      "-MetaPath", metaFile,
      "-UabeaDir", uabeaDir,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let leftover = "", all = "";
    const emit = (chunk) => {
      all += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { win?.webContents.send("dp2:missing-pack-progress", ln); } catch {}
      }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message, log: all }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = all.split("\n").slice(-25).join("\n").trim();
        resolve({ ok: false, error: tail || `Exit ${code}`, log: all });
        return;
      }
      let summary = null;
      const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: all });
    });
  });
});

// Per-row UI state для MISSING: статус + закладка. Ключ = MsgEnum (стабільний
// глобально через length-table). Зберігаємо у Meta/status.json.
function missingStatusFile(metaDir) { return path.join(metaDir, "status.json"); }
ipcMain.handle("dp2:missing-text-meta-read", async () => {
  try {
    const { metaDir } = await missingTextDirs();
    const file = missingStatusFile(metaDir);
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, rows: parsed?.rows ?? {} };
  } catch { return { ok: true, rows: {} }; }
});
ipcMain.handle("dp2:missing-text-meta-write", async (_event, payload) => {
  try {
    const { metaDir } = await missingTextDirs();
    await fs.mkdir(metaDir, { recursive: true });
    const rows = (payload && payload.rows) || {};
    await fs.writeFile(missingStatusFile(metaDir), JSON.stringify({ version: 1, rows }, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Quick corpus-stats для MISSING — швидкий шлях для HomeV2 без завантаження
// у renderer'і. Робить ті ж лічильники, що computeMissingCorpusStats() у
// MissingEditor: total + translated. Парсер msg-формату — мінімальний (тільки
// читання stringCount + strings).
function missingParseMsgCounts(buf) {
  // Skip Unity TextAsset wrap, якщо є (m_Name length + name + pad + scriptLen).
  // Тут .dat вже без wrap (PS-скрипт стрипає), але про всяк перевіримо magic.
  let script = buf;
  if (buf.length >= 4 && (buf[0] !== 0x4D || buf[1] !== 0x53 || buf[2] !== 0x47)) {
    // Має wrap — пропускаємо до "MSG.".
    for (let i = 0; i < Math.min(buf.length - 4, 256); i++) {
      if (buf[i] === 0x4D && buf[i+1] === 0x53 && buf[i+2] === 0x47 && buf[i+3] === 0x2E) {
        script = buf.subarray(i);
        break;
      }
    }
  }
  if (script.length < 0x40) return { strings: [] };
  const dv = new DataView(script.buffer, script.byteOffset, script.byteLength);
  const sto = dv.getUint32(0x10, true);
  const sb  = dv.getUint32(0x14, true);
  const sc  = dv.getUint32(0x30, true);
  const strings = [];
  for (let i = 0; i < sc; i++) {
    const off = dv.getInt32(sto + i * 4, true);
    let end = sb + off;
    if (end < 0 || end > script.length) { strings.push(""); continue; }
    while (end < script.length && script[end] !== 0) end++;
    strings.push(Buffer.from(script.subarray(sb + off, end)).toString("utf8"));
  }
  return { strings };
}
const MISSING_PLACEHOLDER_RE = /^[A-Z_0-9]+_en$|^V_[A-Z]{2}_\d{3}$/;
const MISSING_HAS_CYR = /[Ѐ-ӿ]/;

ipcMain.handle("dp2:missing-corpus-stats-quick", async () => {
  try {
    const { originalDir, doneDir } = await missingTextDirs();
    const r = await callHeavy("missing-corpus-stats-quick", { originalDir, doneDir });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e.message || e), total: 0, translated: 0 };
  }
});

// IMHeightInfo (box-sizes) extract/pack. Зберігаємо у Meta/heightinfo.bin
// (orig) та Done/heightinfo.bin (модифікований; пакується у resources.assets
// разом із текстом).
function missingHeightInfoOrigFile(metaDir) { return path.join(metaDir, "heightinfo.bin"); }
function missingHeightInfoDoneFile(doneDir) { return path.join(doneDir, "heightinfo.bin"); }

ipcMain.handle("dp2:missing-boxsize-extract", async () => {
  try {
    const settings = await readSettings();
    const assetsPath = settings.missingAssetsPath;
    if (!assetsPath) return { ok: false, error: "missingAssetsPath не задано" };
    const { metaDir } = await missingTextDirs();
    await fs.mkdir(metaDir, { recursive: true });
    const outFile = missingHeightInfoOrigFile(metaDir);
    // КРИТИЧНО: пріоритетно беремо з `.bak`, якщо існує. Live `.assets` може
    // бути вже модифікований попередніми text-pack'ами, а heightinfo там
    // після Auto-fit + Pack — вже applied (не reference). Backup тримає
    // pre-pack стан і там heightinfo завжди залишається оригіналом, бо
    // text-pack не зачіпає IMHeightInfo MonoBehaviour. Якщо `.bak` нема —
    // fallback на live `.assets` (свіжо встановлена гра, перший extract).
    let extractFrom = assetsPath;
    const bakCandidate = assetsPath + ".bak";
    try { await fs.access(bakCandidate); extractFrom = bakCandidate; }
    catch {}
    const result = await new Promise((resolve) => {
      const child = spawn(settings.pwshPath || "pwsh", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.join(scriptsDir, "missing-boxsize-extract.ps1"),
        "-AssetsPath", extractFrom,
        "-OutFile", outFile,
        "-UabeaDir", settings.uabeaInstallDir || path.join(settings.toolsDir || path.join(app.getPath("documents"), "SWERY-Localization-Tool"), "uabea"),
      ], { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim() };
    return { ok: true, outFile };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Завантажує IMHeightInfo bytes (Done/heightinfo.bin якщо є, інакше Original).
ipcMain.handle("dp2:missing-boxsize-read", async () => {
  try {
    const { metaDir, doneDir } = await missingTextDirs();
    const doneFile = missingHeightInfoDoneFile(doneDir);
    const origFile = missingHeightInfoOrigFile(metaDir);
    let path_;
    try { await fs.access(doneFile); path_ = doneFile; }
    catch { try { await fs.access(origFile); path_ = origFile; } catch { return { ok: false, error: "heightinfo.bin не знайдено. Зроби extract." }; } }
    const bytes = await fs.readFile(path_);
    return { ok: true, base64: bytes.toString("base64"), source: path_ === doneFile ? "done" : "original" };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Окремий read для Original (Meta/heightinfo.bin) — потрібен у Auto-fit як
// нерухомий reference: без нього алгоритм мультиплікативно нарощує W на
// кожен apply (origW читається з вже-модифікованого Done і ratio*padding
// застосовується знову та знову).
ipcMain.handle("dp2:missing-boxsize-read-original", async () => {
  try {
    const { metaDir } = await missingTextDirs();
    const origFile = missingHeightInfoOrigFile(metaDir);
    try { await fs.access(origFile); }
    catch { return { ok: false, error: "Original heightinfo не знайдено. Зробіть extract." }; }
    const bytes = await fs.readFile(origFile);
    return { ok: true, base64: bytes.toString("base64") };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── IPC: MISSING DLL (Assembly-CSharp.dll) editor + targeted dialog fix ──
//
// Знаходить Managed/ поряд із resources.assets (settings.missingAssetsPath),
// викликає Mono.Cecil-PowerShell скрипти для:
//   - extract: всі ldstr → JSON (для UI-таблиці перекладу)
//   - apply:   JSON {id, original, replacement}[] → DLL з .bak
//   - dialog-fix: одна-кнопка patch FixedBallon.SetText + TextExSettings..ctor
//   - dialog-fix-revert: rollback з .bak (повертає DLL до оригіналу)
function missingDllPath() {
  return async () => {
    const settings = await readSettings();
    if (!settings.missingAssetsPath) return null;
    const managedDir = path.join(path.dirname(settings.missingAssetsPath), "Managed");
    return path.join(managedDir, "Assembly-CSharp.dll");
  };
}
async function _missingDllPath() {
  const settings = await readSettings();
  if (!settings.missingAssetsPath) return null;
  const managedDir = path.join(path.dirname(settings.missingAssetsPath), "Managed");
  return path.join(managedDir, "Assembly-CSharp.dll");
}

ipcMain.handle("dp2:missing-dll-strings-extract", async () => {
  try {
    const dllPath = await _missingDllPath();
    if (!dllPath) return { ok: false, error: "missingAssetsPath not set" };
    try { await fs.access(dllPath); } catch { return { ok: false, error: "Assembly-CSharp.dll not found at " + dllPath }; }
    const settings = await readSettings();
    if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
    const pwshLookup = await findPwsh(settings);
    if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
    const uabeaDir = path.dirname(settings.uabeaPath);
    const { metaDir } = await missingTextDirs();
    const outFile = path.join(metaDir, "..", "DLL", "assembly-csharp-strings.json");
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    const scriptPath = resolveResource("scripts/missing-dll-strings-extract.ps1");
    const result = await new Promise((resolve) => {
      const child = spawn(pwshLookup, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-DllPath", dllPath, "-UabeaDir", uabeaDir, "-OutFile", outFile, "-MinLength", "1",
      ], { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim(), log: result.stdout };
    const raw = await fs.readFile(outFile, "utf8");
    const payload = JSON.parse(raw);
    return { ok: true, items: payload.items, total: payload.total, outFile };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("dp2:missing-dll-strings-apply", async (_e, payload) => {
  try {
    const dllPath = await _missingDllPath();
    if (!dllPath) return { ok: false, error: "missingAssetsPath not set" };
    const edits = (payload && Array.isArray(payload.edits)) ? payload.edits : null;
    if (!edits || edits.length === 0) return { ok: false, error: "edits[] empty" };
    const settings = await readSettings();
    if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
    const pwshLookup = await findPwsh(settings);
    if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
    const uabeaDir = path.dirname(settings.uabeaPath);
    const { metaDir } = await missingTextDirs();
    const inputJson = path.join(metaDir, "..", "DLL", "_apply-input.json");
    await fs.mkdir(path.dirname(inputJson), { recursive: true });
    await fs.writeFile(inputJson, JSON.stringify({ edits }, null, 0), "utf8");
    const scriptPath = resolveResource("scripts/missing-dll-strings-apply.ps1");
    const result = await new Promise((resolve) => {
      const child = spawn(pwshLookup, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-DllPath", dllPath, "-UabeaDir", uabeaDir, "-InputJson", inputJson,
      ], { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    try { await fs.unlink(inputJson); } catch {}
    if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim(), log: result.stdout };
    const m = result.stdout.match(/RESULT_JSON:\s*(.+)$/m);
    let summary = null;
    if (m) { try { summary = JSON.parse(m[1]); } catch {} }
    return { ok: true, summary, log: result.stdout };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

async function _runMissingDialogFixScript(extraArgs) {
  const dllPath = await _missingDllPath();
  if (!dllPath) return { ok: false, error: "missingAssetsPath not set" };
  try { await fs.access(dllPath); } catch { return { ok: false, error: "Assembly-CSharp.dll not found at " + dllPath }; }
  const settings = await readSettings();
  if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(settings.uabeaPath);
  const scriptPath = resolveResource("scripts/missing-dll-dialog-fix.ps1");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-DllPath", dllPath, "-UabeaDir", uabeaDir,
    ...(extraArgs || []),
  ];
  const result = await new Promise((resolve) => {
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim(), log: result.stdout };
  const m = result.stdout.match(/RESULT_JSON:\s*(.+)$/m);
  let summary = null;
  if (m) { try { summary = JSON.parse(m[1]); } catch {} }
  return { ok: true, summary, log: result.stdout };
}

ipcMain.handle("dp2:missing-dll-dialog-fix", async () => _runMissingDialogFixScript([]));
ipcMain.handle("dp2:missing-dll-dialog-fix-revert", async () => _runMissingDialogFixScript(["-Revert"]));
ipcMain.handle("dp2:missing-dll-dialog-fix-status", async () => _runMissingDialogFixScript(["-Status"]));

// ── MISSING Interface UI-text export/import (sharedassets UI.Text round-trip) ──
ipcMain.handle("dp2:missing-ui-text-export", async (_e, payload) => {
  try {
    const settings = await readSettings();
    if (!settings.missingAssetsPath) return { ok: false, error: "missingAssetsPath not set" };
    const dataDir = path.dirname(settings.missingAssetsPath);
    if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
    const pwshLookup = await findPwsh(settings);
    if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
    const uabeaDir = path.dirname(settings.uabeaPath);
    const outFile = (payload && payload.outFile) || (await (async () => {
      const { baseDir } = await missingTextDirs();
      await fs.mkdir(baseDir, { recursive: true });
      return path.join(baseDir, "interface.txt");
    })());
    const scriptPath = resolveResource("scripts/missing-ui-text-export.ps1");
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-DataDir", dataDir, "-UabeaDir", uabeaDir, "-OutFile", outFile,
    ];
    if (payload && payload.includeNonAscii) args.push("-IncludeNonAscii");
    const result = await new Promise((resolve) => {
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim(), log: result.stdout };
    const m = result.stdout.match(/RESULT_JSON:\s*(.+)$/m);
    let summary = null;
    if (m) { try { summary = JSON.parse(m[1]); } catch {} }
    return { ok: true, summary, outFile, log: result.stdout };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

async function _runMissingUiTextImport(inFile) {
  const settings = await readSettings();
  if (!settings.missingAssetsPath) return { ok: false, error: "missingAssetsPath not set" };
  const dataDir = path.dirname(settings.missingAssetsPath);
  if (!settings.uabeaPath) return { ok: false, error: "UABEA path not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(settings.uabeaPath);
  try { await fs.access(inFile); }
  catch { return { ok: false, error: `Файл не знайдено: ${inFile}.` }; }
  const scriptPath = resolveResource("scripts/missing-ui-text-import.ps1");
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-DataDir", dataDir, "-UabeaDir", uabeaDir, "-InFile", inFile,
  ];
  const result = await new Promise((resolve) => {
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim(), log: result.stdout };
  const m = result.stdout.match(/RESULT_JSON:\s*(.+)$/m);
  let summary = null;
  if (m) { try { summary = JSON.parse(m[1]); } catch {} }
  return { ok: true, summary, inFile, log: result.stdout };
}

ipcMain.handle("dp2:missing-ui-text-import", async (_e, payload) => {
  const inFile = (payload && payload.inFile) || (await (async () => {
    const { baseDir } = await missingTextDirs();
    return path.join(baseDir, "interface.txt");
  })());
  return _runMissingUiTextImport(inFile);
});

// Inline-варіант: renderer передає content прямо як string. Main пише його
// у тимчасовий файл і викликає import — використовується з MissingEditor.
// importCombined для секції [__Interface__], яка вже у combined.txt.
ipcMain.handle("dp2:missing-ui-text-import-inline", async (_e, payload) => {
  try {
    const content = (payload && payload.content) || "";
    if (!content) return { ok: false, error: "empty content" };
    const { baseDir } = await missingTextDirs();
    await fs.mkdir(baseDir, { recursive: true });
    const tmpFile = path.join(baseDir, "_interface-import.tmp.txt");
    await fs.writeFile(tmpFile, content, "utf8");
    try {
      return await _runMissingUiTextImport(tmpFile);
    } finally {
      try { await fs.unlink(tmpFile); } catch {}
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Зберігає модифіковані bytes у Done/heightinfo.bin.
ipcMain.handle("dp2:missing-boxsize-save", async (_event, payload) => {
  try {
    const base64 = String((payload && payload.base64) || "");
    if (!base64) return { ok: false, error: "empty base64" };
    const bytes = Buffer.from(base64, "base64");
    const { doneDir } = await missingTextDirs();
    await fs.mkdir(doneDir, { recursive: true });
    const file = missingHeightInfoDoneFile(doneDir);
    await fs.writeFile(file, bytes);
    return { ok: true, file, size: bytes.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Pack: пише Done/heightinfo.bin назад у resources.assets через PS-скрипт.
// Викликається ОКРЕМО від основного pack-скрипта (текст), тому що той
// працює лише з TextAsset'ами і не знає, як підмінити MonoBehaviour.
ipcMain.handle("dp2:missing-boxsize-pack", async () => {
  try {
    const settings = await readSettings();
    const assetsPath = settings.missingAssetsPath;
    if (!assetsPath) return { ok: false, error: "missingAssetsPath не задано" };
    const { doneDir } = await missingTextDirs();
    const inFile = missingHeightInfoDoneFile(doneDir);
    try { await fs.access(inFile); } catch { return { ok: true, skipped: true, error: "Done/heightinfo.bin відсутній — нічого паковати" }; }
    const result = await new Promise((resolve) => {
      const child = spawn(settings.pwshPath || "pwsh", [
        "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", path.join(scriptsDir, "missing-boxsize-pack.ps1"),
        "-AssetsPath", assetsPath,
        "-InFile", inFile,
        "-UabeaDir", settings.uabeaInstallDir || path.join(settings.toolsDir || path.join(app.getPath("documents"), "SWERY-Localization-Tool"), "uabea"),
      ], { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) return { ok: false, error: (result.stderr || result.stdout || "").trim() };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── IPC: THE MISSING fonts pipeline ──────────────────────────────
async function missingFontsDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "MISSING", "Fonts");
  return {
    baseDir,
    originalDir: path.join(baseDir, "Original"),
    replaceDir: path.join(baseDir, "Replacement"),
    metaDir: path.join(baseDir, "Meta"),
    metaFile: path.join(baseDir, "Meta", "missing-fonts-meta.json"),
  };
}

ipcMain.handle("dp2:missing-fonts-status", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath || null;
  let assetsOk = false;
  try { if (assetsPath) { await fs.access(assetsPath); assetsOk = true; } } catch {}
  const { originalDir, replaceDir, metaFile } = await missingFontsDirs();
  let originalCount = 0, replaceCount = 0, metaExists = false;
  try { const e = await fs.readdir(originalDir); originalCount = e.filter((f) => /\.(ttf|otf)$/i.test(f)).length; } catch {}
  try { const e = await fs.readdir(replaceDir); replaceCount = e.filter((f) => /\.(ttf|otf)$/i.test(f)).length; } catch {}
  try { await fs.access(metaFile); metaExists = true; } catch {}
  return { ok: true, assetsPath, assetsOk, originalDir, replaceDir, metaFile, metaExists, originalCount, replaceCount };
});

ipcMain.handle("dp2:missing-fonts-export", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath;
  if (!assetsPath) return { ok: false, error: "missingAssetsPath not set" };
  try { await fs.access(assetsPath); } catch { return { ok: false, error: "assets-not-found" }; }
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const { originalDir, metaFile } = await missingFontsDirs();
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(path.dirname(metaFile), { recursive: true });
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/missing-fonts-export.ps1");
  const win = BrowserWindow.getAllWindows()[0];
  return await new Promise((resolve) => {
    const args = ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File", scriptPath,
      "-AssetsPath", assetsPath, "-OutDir", originalDir, "-MetaPath", metaFile, "-UabeaDir", uabeaDir];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let leftover = "", all = "";
    const emit = (chunk) => {
      all += chunk; leftover += chunk;
      const lines = leftover.split(/\r?\n/); leftover = lines.pop() || "";
      for (const ln of lines) { if (!ln.trim()) continue; try { win?.webContents.send("dp2:missing-fonts-progress", ln); } catch {} }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (e) => resolve({ ok: false, error: e.message, log: all }));
    child.on("exit", (code) => {
      if (code !== 0) { resolve({ ok: false, error: all.split("\n").slice(-20).join("\n"), log: all }); return; }
      let summary = null; const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: all });
    });
  });
});

ipcMain.handle("dp2:missing-fonts-list", async () => {
  const { originalDir, replaceDir, metaFile } = await missingFontsDirs();
  let items = [];
  try {
    const raw = await fs.readFile(metaFile, "utf8");
    const m = JSON.parse(raw);
    items = Array.isArray(m.items) ? m.items : [];
  } catch {}
  const out = [];
  for (const it of items) {
    const origPath = path.join(originalDir, it.file);
    const replacePath = path.join(replaceDir, it.file);
    let hasOrig = false, hasReplace = false, replaceSize = 0;
    try { await fs.access(origPath); hasOrig = true; } catch {}
    try { const st = await fs.stat(replacePath); hasReplace = true; replaceSize = st.size; } catch {}
    out.push({ ...it, pathId: String(it.pathId), origPath, replacePath, hasOrig, hasReplace, replaceSize });
  }
  return { ok: true, items: out };
});

ipcMain.handle("dp2:missing-fonts-pick-replace", async (_e, payload) => {
  const item = payload && payload.item;
  if (!item) return { ok: false, error: "no item" };
  const res = await dialog.showOpenDialog({
    title: `Заміна шрифту: ${item.name}`,
    properties: ["openFile"],
    filters: [{ name: "Fonts", extensions: ["ttf", "otf"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false, error: "cancelled" };
  const src = res.filePaths[0];
  const { replaceDir } = await missingFontsDirs();
  await fs.mkdir(replaceDir, { recursive: true });
  const dst = path.join(replaceDir, item.file);
  await fs.copyFile(src, dst);
  return { ok: true, replacePath: dst, src };
});

ipcMain.handle("dp2:missing-fonts-clear-replace", async (_e, payload) => {
  const item = payload && payload.item;
  if (!item) return { ok: false, error: "no item" };
  const { replaceDir } = await missingFontsDirs();
  const dst = path.join(replaceDir, item.file);
  try { await fs.unlink(dst); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:missing-fonts-pack", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath;
  if (!assetsPath) return { ok: false, error: "missingAssetsPath not set" };
  try { await fs.access(assetsPath); } catch { return { ok: false, error: "assets-not-found" }; }
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const { replaceDir, metaFile } = await missingFontsDirs();
  try { await fs.access(replaceDir); } catch { return { ok: false, error: "no replacements" }; }
  try { await fs.access(metaFile); } catch { return { ok: false, error: "Meta missing — run export first" }; }
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/missing-fonts-import.ps1");
  const win = BrowserWindow.getAllWindows()[0];
  return await new Promise((resolve) => {
    const args = ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File", scriptPath,
      "-AssetsRoot", path.dirname(assetsPath), "-ReplaceDir", replaceDir, "-MetaPath", metaFile, "-UabeaDir", uabeaDir];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let leftover = "", all = "";
    const emit = (chunk) => {
      all += chunk; leftover += chunk;
      const lines = leftover.split(/\r?\n/); leftover = lines.pop() || "";
      for (const ln of lines) { if (!ln.trim()) continue; try { win?.webContents.send("dp2:missing-fonts-pack-progress", ln); } catch {} }
    };
    child.stdout.on("data", (d) => emit(d.toString()));
    child.stderr.on("data", (d) => emit(d.toString()));
    child.on("error", (e) => resolve({ ok: false, error: e.message, log: all }));
    child.on("exit", (code) => {
      if (code !== 0) { resolve({ ok: false, error: all.split("\n").slice(-20).join("\n"), log: all }); return; }
      let summary = null; const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary, log: all });
    });
  });
});

// ── IPC: THE MISSING textures pipeline ──────────────────────────
// Перевикористовуємо DP2-скрипти textures-export.ps1 / textures-replace.ps1.
// Правила екстракту: для кожного assets-file — список pathIds + regex по m_Name.
// Wildcard "stamp" вирішується через NamePatterns у PS-скрипті: динамічно
// знайдені текстури далі живуть як файли у Original/ (UI читає з диску).
const MISSING_TEXTURE_RULES = [
  {
    assets: "resources.assets",
    pathIds: [705, 475, 232, 661],
    // new_01 — точна назва; stamp\d* — будь-які stamp-* textures.
    namePatterns: "^new_01$|^stamp",
  },
  { assets: "sharedassets25.assets", pathIds: [21], namePatterns: "" },
  { assets: "sharedassets44.assets", pathIds: [69], namePatterns: "" },
];

async function missingTexturesDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "MISSING", "Textures");
  return {
    baseDir,
    originalDir: path.join(baseDir, "Original"),
    replaceDir: path.join(baseDir, "Replacement"),
  };
}

ipcMain.handle("dp2:missing-textures-status", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath || null;
  const dataDir = assetsPath ? path.dirname(assetsPath) : null;
  let assetsOk = false;
  if (dataDir) {
    assetsOk = true;
    for (const r of MISSING_TEXTURE_RULES) {
      const p = path.join(dataDir, r.assets);
      try { await fs.access(p); } catch { assetsOk = false; break; }
    }
  }
  const { originalDir, replaceDir } = await missingTexturesDirs();
  // Items будуємо з фактично екстрактнутих .png файлів у Original/. Назва
  // PowerShell-export'а: <m_Name>-<assets-file>.<ext>-<pathId>.png.
  // Парсимо її назад у item.
  const items = [];
  let pngs = [];
  try { pngs = (await fs.readdir(originalDir)).filter((f) => f.endsWith(".png")); } catch {}
  for (const f of pngs) {
    // <name>-<assets.assets>-<pathId>.png. assets-name містить ".assets",
    // а name може мати дефіси, тому регекс на хвостову частину.
    const m = f.match(/^(.+)-([^-]+\.assets)-(\d+)\.png$/i);
    if (!m) continue;
    const name = m[1];
    const assets = m[2];
    const pathId = parseInt(m[3], 10);
    const origPath = path.join(originalDir, f);
    const replacePath = path.join(replaceDir, f);
    let hasReplace = false, replaceSize = 0;
    try { const st = await fs.stat(replacePath); hasReplace = true; replaceSize = st.size; } catch {}
    items.push({ name, pathId, assets, fileName: f, origPath, replacePath, hasOrig: true, hasReplace, replaceSize });
  }
  items.sort((a, b) => a.assets.localeCompare(b.assets) || a.name.localeCompare(b.name));
  return { ok: true, assetsPath, assetsOk, originalDir, replaceDir, items };
});

ipcMain.handle("dp2:missing-textures-export", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath;
  if (!assetsPath) return { ok: false, error: "missingAssetsPath not set" };
  const dataDir = path.dirname(assetsPath);
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/textures-export.ps1");
  const { originalDir } = await missingTexturesDirs();
  await fs.mkdir(originalDir, { recursive: true });
  const win = BrowserWindow.getAllWindows()[0];
  let totalExported = 0;
  let allLog = "";
  for (const rule of MISSING_TEXTURE_RULES) {
    const fullAssets = path.join(dataDir, rule.assets);
    try { await fs.access(fullAssets); }
    catch {
      allLog += `[SKIP] ${rule.assets} not found\n`;
      continue;
    }
    await new Promise((resolve) => {
      const args = ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File", scriptPath,
        "-AssetsPath", fullAssets, "-OutDir", originalDir, "-UabeaDir", uabeaDir,
        "-PathIds", rule.pathIds.join(","),
        "-NamePatterns", rule.namePatterns || ""];
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let leftover = "";
      const emit = (chunk) => {
        allLog += chunk;
        leftover += chunk;
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() || "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          if (/^Exported /.test(ln)) totalExported++;
          try { win?.webContents.send("dp2:missing-textures-progress", ln); } catch {}
        }
      };
      child.stdout.on("data", (d) => emit(d.toString()));
      child.stderr.on("data", (d) => emit(d.toString()));
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  }
  return { ok: true, summary: { total: totalExported }, log: allLog };
});

ipcMain.handle("dp2:missing-textures-pick-replace", async (_e, payload) => {
  const item = payload && payload.item;
  if (!item) return { ok: false, error: "no item" };
  const res = await dialog.showOpenDialog({
    title: `Заміна текстури: ${item.name}`,
    properties: ["openFile"],
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false, error: "cancelled" };
  const src = res.filePaths[0];
  const { replaceDir } = await missingTexturesDirs();
  await fs.mkdir(replaceDir, { recursive: true });
  const dst = path.join(replaceDir, item.fileName);
  await fs.copyFile(src, dst);
  return { ok: true, replacePath: dst, src };
});

ipcMain.handle("dp2:missing-textures-clear-replace", async (_e, payload) => {
  const item = payload && payload.item;
  if (!item) return { ok: false, error: "no item" };
  const { replaceDir } = await missingTexturesDirs();
  try { await fs.unlink(path.join(replaceDir, item.fileName)); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:missing-textures-pack", async () => {
  const settings = await readSettings();
  const assetsPath = settings.missingAssetsPath;
  if (!assetsPath) return { ok: false, error: "missingAssetsPath not set" };
  const dataDir = path.dirname(assetsPath);
  const { uabeaPath } = settings;
  if (!uabeaPath) return { ok: false, error: "UABEA not set" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 not found" };
  const uabeaDir = path.dirname(uabeaPath);
  const scriptPath = resolveResource("scripts/textures-replace.ps1");
  const { replaceDir } = await missingTexturesDirs();
  const win = BrowserWindow.getAllWindows()[0];

  // Збираємо список замін з реальних файлів у Replacement/. Файл має ім'я
  // <name>-<assets>-<pathId>.png — з нього парсимо мапінг для PS-replace.
  let replacements = [];
  try {
    const entries = await fs.readdir(replaceDir);
    for (const f of entries) {
      if (!f.endsWith(".png")) continue;
      const m = f.match(/^(.+)-([^-]+\.assets)-(\d+)\.png$/i);
      if (!m) continue;
      replacements.push({ name: m[1], assets: m[2], pathId: parseInt(m[3], 10), fileName: f });
    }
  } catch {}

  let applied = 0;
  const failed = [];
  const changedAssets = new Set();
  let allLog = "";
  for (const t of replacements) {
    const replacePath = path.join(replaceDir, t.fileName);
    const fullAssets = path.join(dataDir, t.assets);
    // Бекап і tmp.
    const bak = fullAssets + ".tex.bak";
    try { await fs.access(bak); } catch { await fs.copyFile(fullAssets, bak); }
    const tmp = fullAssets + ".tmp";
    const res = await new Promise((resolve) => {
      const args = ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File", scriptPath,
        "-AssetsPath", fullAssets, "-PathId", String(t.pathId), "-NewPngFile", replacePath,
        "-OutputPath", tmp, "-UabeaDir", uabeaDir];
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let leftover = "", local = "";
      const emit = (chunk) => {
        allLog += chunk; local += chunk; leftover += chunk;
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() || "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try { win?.webContents.send("dp2:missing-textures-pack-progress", `[${t.name}] ${ln}`); } catch {}
        }
      };
      child.stdout.on("data", (d) => emit(d.toString()));
      child.stderr.on("data", (d) => emit(d.toString()));
      child.on("error", (e) => resolve({ ok: false, error: e.message, log: local }));
      child.on("exit", (code) => resolve({ ok: code === 0, log: local }));
    });
    if (!res.ok) {
      failed.push({ name: t.name, reason: res.log.split("\n").slice(-3).join(" ").trim() || "Exit !=0" });
      try { await fs.unlink(tmp); } catch {}
      continue;
    }
    // Розрізняємо два режими роботи textures-replace.ps1:
    //   * "resS-inplace" — PS пропатчив .resS НАПРЯМУ за offset; .assets
    //     не змінювалось, tmp не створено. Просто рахуємо як applied,
    //     swap не робимо.
    //   * "inline" — PS записав новий .assets у tmp (OutputPath); треба
    //     атомарно замінити живий .assets через fs.rename
    //     (на Windows це MoveFileEx з REPLACE_EXISTING).
    //
    // Раніше код завжди намагався rename tmp → fullAssets. Для inplace це
    // або стирало live .assets (старий unlink+rename), або, після фікса,
    // помилково рахувало success як failed («tmp missing/empty»).
    const mode = (() => {
      const m = res.log && res.log.match(/RESULT_JSON:\s*(.+)$/m);
      if (!m) return null;
      try { return JSON.parse(m[1]).mode || null; } catch { return null; }
    })();
    if (mode === "resS-inplace") {
      applied++;
      changedAssets.add(t.assets + ".resS");
      try { await fs.unlink(tmp); } catch {}
      continue;
    }
    try {
      // Inline mode → swap. Sanity-check: tmp існує і непорожній.
      const tmpStat = await fs.stat(tmp).catch(() => null);
      if (!tmpStat || tmpStat.size === 0) {
        failed.push({ name: t.name, reason: `tmp missing/empty: ${tmp}` });
        try { await fs.unlink(tmp); } catch {}
        continue;
      }
      await fs.rename(tmp, fullAssets);
      applied++;
      changedAssets.add(t.assets);
    } catch (e) {
      failed.push({ name: t.name, reason: `swap fail: ${e.message}` });
      try { await fs.unlink(tmp); } catch {}
    }
  }
  return { ok: true, summary: { applied, failed, changedAssets: [...changedAssets] }, log: allLog };
});

// ── IPC: DP1 setup pipeline ──────────────────────────────────────
// Що ми робимо при першому запуску DP1:
//   Крок 1. Завантажити DPMsgTool by MrIkso (Dropbox .zip) і розпакувати
//           у Documents\SWERY-Localization-Tool\DP1\Text\Tool.
//   Крок 2. Скопіювати mes_all.mes з теки гри
//           (<dp1Root>\updata_eu\_us\message\output\mes_all.mes), або
//           попросити користувача обрати файл вручну. Потім запустити
//           DPMsgTool.exe з mes-файлом як аргументом (drag&drop-режим) —
//           він створить JSON-дамп поруч.
const DP1_TOOL_URL = "https://www.dropbox.com/scl/fi/z19fx6x588ivohnr41gdw/DPMsgTool.zip?rlkey=dk1io871upc6345iipmcdfpag&st=g93q9vkq&dl=1";

function dp1TextRoot() {
  const docs = app.getPath("documents");
  return path.join(docs, "SWERY-Localization-Tool", "DP1", "Text");
}
function dp1ToolDir()     { return path.join(dp1TextRoot(), "Tool"); }
function dp1OriginalDir() { return path.join(dp1TextRoot(), "Original"); }
function dp1DoneDir()     { return path.join(dp1TextRoot(), "Done"); }
function dp1MetaDir()     { return path.join(dp1TextRoot(), "Meta"); }
function dp1OriginalJson(){ return path.join(dp1OriginalDir(), "mes_all.json"); }
function dp1DoneJson()    { return path.join(dp1DoneDir(), "mes_all.json"); }
function dp1MetaFile()    { return path.join(dp1MetaDir(), "meta.json"); }

// Прибирає всі вкладені {XXX} токени і повертає довжину printable-частини.
// Правило DPMsgTool by MrIkso: FSL = довжина substring до першого segment-break,
// з якого прибрано всі інші {…} токени. Якщо segment-break нема — вся стрічка.
function dp1ComputeFsl(text) {
  if (!text) return 0;
  const re = /\{NEXT_SEGMENT\}|\{NEXT_FRAME\b[^}]*\}/;
  const m = text.match(re);
  const head = m ? text.slice(0, m.index) : text;
  return head.replace(/\{[^{}]*\}/g, "").length;
}

// Серіалізація JSON для DPMsgTool: 2-space indent + CRLF. Бінарно ідентично
// тому, що генерує сама DPMsgTool — це доведено round-trip тестом.
function dp1StringifyRecords(records) {
  return JSON.stringify(records, null, 2).replace(/\n/g, "\r\n");
}

async function dp1FindToolExe() {
  const root = dp1ToolDir();
  try { await fs.access(root); } catch { return null; }
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.shift();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) stack.push({ dir: p, depth: depth + 1 }); }
      else if (e.isFile() && /^DPMsgTool\.exe$/i.test(e.name)) return p;
    }
  }
  return null;
}

async function dp1FindMesInGame(dp1Root) {
  if (!dp1Root) return null;
  const candidate = path.join(dp1Root, "updata_eu", "_us", "message", "output", "mes_all.mes");
  try { await fs.access(candidate); return candidate; } catch { return null; }
}

async function dp1FindJsonDump(toolDir) {
  // Після drag&drop DPMsgTool кладе JSON-дамп поруч. Зазвичай це eng.json
  // (його canonical-ім'я), але можемо ловити будь-який .json з масивом
  // записів — найновіший за mtime.
  try {
    const entries = await fs.readdir(toolDir, { withFileTypes: true });
    let best = null;
    for (const e of entries) {
      if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
      const full = path.join(toolDir, e.name);
      try {
        const st = await fs.stat(full);
        if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs, size: st.size };
      } catch {}
    }
    return best;
  } catch { return null; }
}

ipcMain.handle("dp2:dp1-setup-status", async () => {
  const root = dp1ToolDir();
  let toolDirExists = false;
  try { await fs.access(root); toolDirExists = true; } catch {}
  const exePath = toolDirExists ? await dp1FindToolExe() : null;
  const mesPath = toolDirExists ? path.join(root, "mes_all.mes") : null;
  let mesCopied = false;
  if (mesPath) { try { await fs.access(mesPath); mesCopied = true; } catch {} }
  const jsonInfo = toolDirExists ? await dp1FindJsonDump(root) : null;

  // Перевіряємо також Original/Done/Meta теки (їх може ще не бути на
  // першому запуску).
  let originalExists = false; let doneExists = false; let metaExists = false;
  try { await fs.access(dp1OriginalJson()); originalExists = true; } catch {}
  try { await fs.access(dp1DoneJson()); doneExists = true; } catch {}
  try { await fs.access(dp1MetaFile()); metaExists = true; } catch {}
  return {
    ok: true,
    root,
    exePath,
    mesPath,
    mesCopied,
    jsonPath: jsonInfo?.path ?? null,
    jsonSize: jsonInfo?.size ?? 0,
    textRoot: dp1TextRoot(),
    originalJson: dp1OriginalJson(),
    doneJson: dp1DoneJson(),
    metaFile: dp1MetaFile(),
    originalExists,
    doneExists,
    metaExists,
  };
});

ipcMain.handle("dp2:dp1-download-tool", async () => {
  const root = dp1ToolDir();
  const zipPath = path.join(root, "DPMsgTool.zip");
  try {
    await fs.mkdir(root, { recursive: true });
    const existing = await dp1FindToolExe();
    if (existing) {
      try {
        mainWindow?.webContents.send("dp2:dp1-tool-progress", {
          phase: "done", i18nKey: "dp1.setup.alreadyHave",
          total: 0, downloaded: 0, percent: 100, bytesPerSec: 0,
        });
      } catch {}
      return { ok: true, root, exePath: existing, alreadyExisted: true };
    }
    let lastEmit = 0; let lastBytes = 0; const startedAt = Date.now();
    try {
      mainWindow?.webContents.send("dp2:dp1-tool-progress", {
        phase: "download", i18nKey: "dp1.setup.downloading",
        i18nParams: { name: "DPMsgTool.zip" },
        total: 0, downloaded: 0, percent: 0, bytesPerSec: 0,
      });
    } catch {}
    const res = await setupTools.downloadFile(DP1_TOOL_URL, zipPath, (p) => {
      const now = Date.now();
      const dt = (now - (lastEmit || startedAt)) / 1000;
      const bps = dt > 0 ? (p.downloaded - lastBytes) / dt : 0;
      lastEmit = now; lastBytes = p.downloaded;
      try {
        mainWindow?.webContents.send("dp2:dp1-tool-progress", {
          phase: "download", i18nKey: "dp1.setup.downloading",
          i18nParams: { name: "DPMsgTool.zip" },
          total: p.total, downloaded: p.downloaded, percent: p.percent,
          bytesPerSec: bps,
        });
      } catch {}
    }, { skipIfExists: false });
    try {
      mainWindow?.webContents.send("dp2:dp1-tool-progress", {
        phase: "extract", i18nKey: "dp1.setup.extracting",
        total: res.bytes, downloaded: res.bytes, percent: 100, bytesPerSec: 0,
      });
    } catch {}
    await setupTools.extractZip(zipPath, root);
    await setupTools.flattenIfSingleSubdir(root);
    try { await fs.unlink(zipPath); } catch {}
    const exePath = await dp1FindToolExe();
    try {
      mainWindow?.webContents.send("dp2:dp1-tool-progress", {
        phase: "done", i18nKey: "dp1.setup.installed",
        total: res.bytes, downloaded: res.bytes, percent: 100, bytesPerSec: 0,
      });
    } catch {}
    return { ok: true, root, exePath, bytes: res.bytes };
  } catch (e) {
    try {
      mainWindow?.webContents.send("dp2:dp1-tool-progress", {
        phase: "error", message: String(e.message || e),
        total: 0, downloaded: 0, percent: 0, bytesPerSec: 0,
      });
    } catch {}
    return { ok: false, error: String(e.message || e) };
  }
});

// Копіює mes_all.mes у Tool dir (з гри або вибраний користувачем) і запускає
// DPMsgTool.exe з шляхом до mes як аргументом — той сам згенерує JSON-дамп
// поруч. Повертає шлях до згенерованого .json + кількість записів.
ipcMain.handle("dp2:dp1-prep-mes", async (_event, payload) => {
  const overrideMes = String((payload && payload.mesPath) || "").trim();
  const settings = await readSettings();
  const root = dp1ToolDir();
  try { await fs.mkdir(root, { recursive: true }); } catch {}
  const exePath = await dp1FindToolExe();
  if (!exePath) return { ok: false, error: "DPMsgTool.exe не знайдено. Спершу завантажте інструмент." };

  // 1) Знаходимо джерело mes_all.mes
  let sourceMes = overrideMes;
  if (!sourceMes) sourceMes = await dp1FindMesInGame(settings.dp1Root) ?? "";
  if (!sourceMes) {
    return { ok: false, needsPick: true, error: "Не знайшов mes_all.mes у грі. Виберіть файл вручну." };
  }
  try { await fs.access(sourceMes); } catch {
    return { ok: false, error: "mes_all.mes не існує: " + sourceMes };
  }

  // 2) Копіюємо у tool dir
  const targetMes = path.join(root, "mes_all.mes");
  try {
    await fs.copyFile(sourceMes, targetMes);
  } catch (e) {
    return { ok: false, error: "Не вдалося скопіювати mes_all.mes: " + (e.message || e) };
  }

  // 3) Запам'ятовуємо снапшот існуючих JSON, щоб після прогону відрізнити
  // новий дамп (DPMsgTool сам обирає ім'я; зазвичай це eng.json).
  let before = new Set();
  try {
    const items = await fs.readdir(root);
    for (const n of items) if (/\.json$/i.test(n)) before.add(n.toLowerCase());
  } catch {}

  // 4) Запускаємо DPMsgTool.exe <mesPath> — як drag&drop із Провідника.
  const result = await new Promise((resolve) => {
    const child = spawn(exePath, [targetMes], { windowsHide: true, cwd: root });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error: "DPMsgTool exit=" + result.code + ":\n" + (result.stderr || result.stdout || "").trim(),
    };
  }

  // 5) Знаходимо новостворений .json (або найновіший, якщо нічого не з'явилось).
  let producedJson = null;
  try {
    const items = await fs.readdir(root, { withFileTypes: true });
    let best = null;
    for (const e of items) {
      if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
      const lower = e.name.toLowerCase();
      const isNew = !before.has(lower);
      const full = path.join(root, e.name);
      const st = await fs.stat(full);
      const cand = { path: full, mtime: st.mtimeMs, size: st.size, isNew };
      if (!best ||
          (cand.isNew && !best.isNew) ||
          (cand.isNew === best.isNew && cand.mtime > best.mtime)) {
        best = cand;
      }
    }
    producedJson = best;
  } catch {}

  if (!producedJson) {
    return {
      ok: false,
      error: "DPMsgTool відпрацював, але JSON-дамп у " + root + " не знайдено.",
      stdout: result.stdout, stderr: result.stderr,
    };
  }

  // 6) Підраховуємо кількість записів і копіюємо JSON у Original/, Done/, Meta/.
  let recordCount = 0;
  let parsedRecords = null;
  try {
    const raw = await fs.readFile(producedJson.path, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsedRecords = parsed;
      recordCount = parsed.length;
    }
  } catch {}

  // Створюємо теки і копіюємо JSON.
  // Original — завжди перезаписуємо (це еталон з гри).
  // Done — лише якщо порожньо (інакше — збережений переклад користувача).
  // Meta — пишемо meta.json з summary.
  try {
    await fs.mkdir(dp1OriginalDir(), { recursive: true });
    await fs.mkdir(dp1DoneDir(), { recursive: true });
    await fs.mkdir(dp1MetaDir(), { recursive: true });
    await fs.copyFile(producedJson.path, dp1OriginalJson());
    let doneExists = false;
    try { await fs.access(dp1DoneJson()); doneExists = true; } catch {}
    if (!doneExists) {
      await fs.copyFile(producedJson.path, dp1DoneJson());
    }
    const meta = {
      sourceMes,
      sourceMesMtime: (await fs.stat(sourceMes)).mtimeMs,
      extractedAt: Date.now(),
      recordCount,
      visibleCount: parsedRecords
        ? parsedRecords.reduce((n, r) => n + (r && r.EmptyRecord ? 0 : 1), 0)
        : 0,
    };
    await fs.writeFile(dp1MetaFile(), JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    return {
      ok: false,
      error: "DPMsgTool ОК, але запис у Original/Done/Meta не вдався: " + (e.message || e),
      jsonPath: producedJson.path,
    };
  }

  return {
    ok: true,
    root,
    exePath,
    mesPath: targetMes,
    jsonPath: producedJson.path,
    jsonSize: producedJson.size,
    recordCount,
    sourceMes,
    originalJson: dp1OriginalJson(),
    doneJson: dp1DoneJson(),
    metaFile: dp1MetaFile(),
  };
});

// ── DP1 text editor IPC ──────────────────────────────────────────
// Завантажує Original + Done JSON у пам'ять renderer'а. Розмір ~8-10 MB
// разом (20003 записів) — у межах безпечного IPC payload.
ipcMain.handle("dp2:dp1-text-load", async () => {
  try {
    const r = await callHeavy("dp1-text-load", {
      originalJson: dp1OriginalJson(),
      doneJson: dp1DoneJson(),
      metaFile: dp1MetaFile(),
    });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Запис цілого Done JSON. Перерахунок FSL виконується тут — щоб renderer
// не дублював логіку. Правило: якщо doneText[i] === originalText[i] —
// passthrough originalFSL; інакше — рерахунок через dp1ComputeFsl().
ipcMain.handle("dp2:dp1-text-save", async (_event, payload) => {
  const records = payload && Array.isArray(payload.done) ? payload.done : null;
  if (!records) return { ok: false, error: "payload.done must be array" };
  try {
    // Worker сам тримає write через withFileLock? — ні, write робить через
    // fs.writeFile напряму. Lock тут не потрібен бо dp1 mes_all.json пише
    // тільки цей шлях (DPMsgTool runs паралельно лише при pack — і pack чекає save).
    const r = await callHeavy("dp1-text-save", {
      originalJson: dp1OriginalJson(),
      doneJson: dp1DoneJson(),
      metaFile: dp1MetaFile(),
      records,
    });
    return { ok: true, bytesWritten: r.bytesWritten };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Швидкі агрегати — для CorpusStatsModal (mode="dp1") та виводу на Home.
ipcMain.handle("dp2:dp1-text-corpus-stats", async () => {
  try {
    const r = await callHeavy("dp1-corpus-stats", {
      originalJson: dp1OriginalJson(),
      doneJson: dp1DoneJson(),
    });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Pre-pack lint: порівнює набори маркерів у Original vs Done.
// Повертає рядки, де перекладач втратив маркер, або додав сторонній.
ipcMain.handle("dp2:dp1-text-lint-markers", async () => {
  try {
    const r = await callHeavy("dp1-lint-markers", {
      originalJson: dp1OriginalJson(),
      doneJson: dp1DoneJson(),
    });
    return { ok: true, scannedRows: r.scannedRows, violations: r.violations };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Export combined.txt — як у MISSING/HBR: easy offline workflow.
// Формат: блок на запис із сепаратором та маркером готовності.
ipcMain.handle("dp2:dp1-text-export-combined", async (_event, payload) => {
  try {
    const origRaw = await fs.readFile(dp1OriginalJson(), "utf8");
    const doneRaw = await fs.readFile(dp1DoneJson(), "utf8");
    const original = JSON.parse(origRaw);
    const done = JSON.parse(doneRaw);
    const target = String((payload && payload.path) || "").trim()
      || path.join(dp1TextRoot(), "mes_all-combined.txt");
    const lines = [];
    lines.push("# DP1 mes_all.json combined export");
    lines.push("# Edit only UA blocks. Keep all {…} tokens intact.");
    lines.push("");
    for (let i = 0; i < original.length; i++) {
      const o = original[i] || {};
      if (o.EmptyRecord) continue;
      const d = done[i] || o;
      lines.push(`===== [${i}] Id1=${o.Id1} Id2=${o.Id2} =====`);
      lines.push(`EN: ${o.Text ?? ""}`);
      lines.push(`UA: ${d.Text ?? ""}`);
      lines.push("");
    }
    const out = lines.join("\r\n");
    await fs.writeFile(target, out, "utf8");
    return { ok: true, path: target, bytes: Buffer.byteLength(out) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("dp2:dp1-text-import-combined", async (_event, payload) => {
  const src = String((payload && payload.path) || "").trim();
  if (!src) return { ok: false, error: "Шлях не задано" };
  try {
    const raw = await fs.readFile(src, "utf8");
    const origJson = JSON.parse(await fs.readFile(dp1OriginalJson(), "utf8"));
    const doneJson = JSON.parse(await fs.readFile(dp1DoneJson(), "utf8"));
    const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
    let applied = 0, skipped = 0;
    const fakeDiffs = [];
    const HDR_RE = /^=====\s*\[(\d+)\]\s*Id1=(-?\d+)\s+Id2=(-?\d+)\s*=====/;
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(HDR_RE);
      if (!m) { i++; continue; }
      const idx = parseInt(m[1], 10);
      // Чітко очікуємо EN: на i+1 і UA: на i+2 (експорт пише саме так).
      // Якщо формат «з'їхав» — зупиняємось на наступному ===== хедері,
      // щоб не з'їсти EN/UA сусіднього блоку.
      let en = null; let ua = null;
      const enLine = lines[i + 1];
      const uaLine = lines[i + 2];
      if (enLine != null && !HDR_RE.test(enLine) && enLine.startsWith("EN: ")) {
        en = enLine.slice(4);
      }
      if (uaLine != null && !HDR_RE.test(uaLine) && uaLine.startsWith("UA: ")) {
        ua = uaLine.slice(4);
      }
      i++;
      if (idx < 0 || idx >= origJson.length || ua == null) { skipped++; continue; }
      const o = origJson[idx];
      if (!o || o.EmptyRecord) { skipped++; continue; }
      // Sanity-check: EN із файлу має збігатись із Original (інакше зсув).
      // Толерантні до trailing whitespace — текстові редактори часто його
      // обрізають при збереженні, але це не привід пропускати рядок:
      // порівнюємо стрімкі тілам (без trailing space/tab/CR).
      if (en !== null) {
        const expected = (o.Text ?? "").replace(/[ \t\r]+$/, "");
        const found = en.replace(/[ \t\r]+$/, "");
        if (expected !== found) {
          if (fakeDiffs.length < 5) fakeDiffs.push({ index: idx, expected: o.Text, found: en });
          skipped++;
          continue;
        }
      }
      const prev = doneJson[idx]?.Text ?? o.Text ?? "";
      if (prev !== ua) {
        doneJson[idx] = { ...(doneJson[idx] || o), Text: ua };
        applied++;
      }
    }
    if (applied > 0) {
      const out = dp1StringifyRecords(doneJson);
      await fs.writeFile(dp1DoneJson(), out, "utf8");
    }
    return { ok: true, applied, skipped, fakeDiffs };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Per-row UI стан: статус (draft/review/approved) + закладки. Зберігаємо
// окремо у Meta/status.json, щоб не міксувати з Done JSON (який пакується
// у гру). Формат:
//   { version: 1, rows: { "<index>": { status?: "draft"|"review"|"approved", bookmark?: true } } }
function dp1StatusFile() { return path.join(dp1MetaDir(), "status.json"); }

// Glyph-map (заміна кирилиці на латинські гліфи з кастомного шрифту гри).
// За замовчуванням — мапа, перевірена на практиці. Користувач може
// редагувати у модалці; зберігаємо у Meta/glyphmap.json. Mapping застосо-
// вується до КОЖНОГО рядка `Text` перед запуском DPMsgTool from-json.
function dp1GlyphMapFile() { return path.join(dp1MetaDir(), "glyphmap.json"); }
const DP1_DEFAULT_GLYPHMAP = {
  "О": "O", "о": "o", "А": "A", "а": "a", "Р": "P", "р": "p",
  "С": "C", "с": "c", "М": "M", "В": "B", "Е": "E", "е": "e",
  "Н": "H", "Т": "T", "І": "I", "і": "i", "Ї": "Í", "ї": "ï",
  "Х": "X", "х": "x", "у": "y",
  "Б": "Ô", "Г": "¿", "Ґ": "Ù", "Д": "Á", "Є": "Â", "Ж": "Ã",
  "З": "Ä", "И": "Å", "Й": "Æ", "К": "Ç", "Л": "È", "П": "É",
  "У": "Ê", "Ф": "Ë", "Ц": "Ì", "Ч": "Î", "Ш": "Ï", "Щ": "Ð",
  "Ь": "Ñ", "Ю": "Ò", "Я": "Ó",
  "б": "à", "в": "á", "г": "â", "ґ": "ã", "д": "ä", "є": "å",
  "ж": "æ", "з": "ç", "и": "è", "й": "é", "к": "ê", "л": "ë",
  "м": "ì", "н": "í", "п": "î", "т": "ú", "ф": "ñ", "ц": "ò",
  "ч": "ó", "ш": "ô", "щ": "õ", "я": "ù", "ю": "ø", "ь": "û",
  "—": "Ú",
};
async function dp1ReadGlyphMap() {
  try {
    const raw = await fs.readFile(dp1GlyphMapFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.map === "object" && parsed.map) return parsed.map;
  } catch {}
  return { ...DP1_DEFAULT_GLYPHMAP };
}
function dp1ApplyGlyphMap(text, map) {
  if (typeof text !== "string" || !text) return text;
  let out = "";
  for (const ch of text) out += (map[ch] != null ? map[ch] : ch);
  return out;
}

ipcMain.handle("dp2:dp1-glyphmap-read", async () => {
  const map = await dp1ReadGlyphMap();
  return { ok: true, map, defaults: DP1_DEFAULT_GLYPHMAP };
});
ipcMain.handle("dp2:dp1-glyphmap-write", async (_event, payload) => {
  try {
    await fs.mkdir(dp1MetaDir(), { recursive: true });
    const map = (payload && payload.map) || {};
    await fs.writeFile(dp1GlyphMapFile(), JSON.stringify({ version: 1, map }, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("dp2:dp1-text-meta-read", async () => {
  try {
    const raw = await fs.readFile(dp1StatusFile(), "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, rows: parsed?.rows ?? {} };
  } catch {
    return { ok: true, rows: {} };
  }
});

ipcMain.handle("dp2:dp1-text-meta-write", async (_event, payload) => {
  try {
    await fs.mkdir(dp1MetaDir(), { recursive: true });
    const rows = (payload && payload.rows) || {};
    await fs.writeFile(dp1StatusFile(), JSON.stringify({ version: 1, rows }, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Pack: копіює Done/mes_all.json у Tool/, запускає DPMsgTool from-json,
// результат (.mes) кладе у <dp1Root>\updata_eu\_us\message\output\mes_all.mes
// з .bak попередньої версії.
ipcMain.handle("dp2:dp1-pack", async () => {
  try {
    const settings = await readSettings();
    const exePath = await dp1FindToolExe();
    if (!exePath) return { ok: false, error: "DPMsgTool.exe не знайдено" };
    try { await fs.access(dp1DoneJson()); }
    catch { return { ok: false, error: "Done/mes_all.json не знайдено. Зробіть extract." }; }

    // 1) Беремо Done JSON, застосовуємо glyph-map до кожного Text, пишемо
    //    у Tool/mes_all.json. Без glyph-map кирилиця у грі не намалюється
    //    (кастомний шрифт гри не має нативних UCS-кодпоінтів кирилиці).
    const toolDir = dp1ToolDir();
    const targetJson = path.join(toolDir, "mes_all.json");
    const glyphMap = await dp1ReadGlyphMap();
    const doneRaw = await fs.readFile(dp1DoneJson(), "utf8");
    const doneArr = JSON.parse(doneRaw);
    if (!Array.isArray(doneArr)) return { ok: false, error: "Done/mes_all.json не масив" };
    const mapped = doneArr.map((r) => ({
      ...r,
      Text: dp1ApplyGlyphMap(r?.Text ?? "", glyphMap),
    }));
    await fs.writeFile(targetJson, dp1StringifyRecords(mapped), "utf8");

    // 2) Запускаємо DPMsgTool — drag&drop стиль (без mode-аргумента; tool
    // сам визначає за розширенням, що це from-json).
    const result = await new Promise((resolve) => {
      const child = spawn(exePath, [targetJson], { windowsHide: true, cwd: toolDir });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message }));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    if (result.code !== 0) {
      return {
        ok: false,
        error: "DPMsgTool exit=" + result.code + ":\n" + (result.stderr || result.stdout || "").trim(),
      };
    }
    // 3) Знаходимо створений *_new.mes.
    let producedMes = null;
    try {
      const items = await fs.readdir(toolDir);
      const newer = items.find((n) => /_new\.mes$/i.test(n));
      if (newer) producedMes = path.join(toolDir, newer);
    } catch {}
    if (!producedMes) {
      // Деякі версії DPMsgTool пишуть як mes_all.mes (перезаписує).
      const fallback = path.join(toolDir, "mes_all.mes");
      try { await fs.access(fallback); producedMes = fallback; } catch {}
    }
    if (!producedMes) {
      return { ok: false, error: "Не знайшов створений .mes у " + toolDir, stdout: result.stdout };
    }

    // 4) Куди ставимо: <dp1Root>\updata_eu\_us\message\output\mes_all.mes
    let targetMes = null;
    if (settings.dp1Root) {
      const outputDir = path.join(settings.dp1Root, "updata_eu", "_us", "message", "output");
      try { await fs.mkdir(outputDir, { recursive: true }); } catch {}
      targetMes = path.join(outputDir, "mes_all.mes");
    }
    if (!targetMes) {
      return {
        ok: true,
        intermediatePath: producedMes,
        warning: "dp1Root не задано — .mes лишається у " + producedMes,
      };
    }

    // .bak попередньої версії.
    let bakPath = null;
    try {
      await fs.access(targetMes);
      bakPath = targetMes + ".bak";
      try { await fs.unlink(bakPath); } catch {}
      await fs.copyFile(targetMes, bakPath);
    } catch {}

    await fs.copyFile(producedMes, targetMes);
    // Прибираємо проміжний *_new.mes після успішного копіювання.
    if (producedMes !== targetMes && /_new\.mes$/i.test(producedMes)) {
      try { await fs.unlink(producedMes); } catch {}
    }
    return { ok: true, outputPath: targetMes, intermediatePath: producedMes, bakPath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── DP1 Textures (XPC2 archive) ─────────────────────────────────
// Кожна текстура у DP1 — окремий .xpc файл: 4-байтовий magic "XPC2",
// header з offset/size полями, zlib-stream DDS/PNG. Формат розкритий
// reverse-engineering-ом (див. docs у Repo / DP_XPC_Tool by Little Bit UA).
//
// Pipeline:
//   1) DP1 game root → шукаємо всі *.xpc рекурсивно
//   2) Extract: zlib.inflateSync → DDS bytes у Documents/.../DP1/Textures/Original/
//   3) Replace: користувач кладе DDS у .../Done/<same name> → ми zlib-стискаємо
//      і пишемо назад у .xpc з оновленим header.
const zlib = require("node:zlib");

function dp1TexturesRoot() {
  return path.join(app.getPath("documents"), "SWERY-Localization-Tool", "DP1", "Textures");
}
function dp1TexturesOriginalDir() { return path.join(dp1TexturesRoot(), "Original"); }
function dp1TexturesDoneDir()     { return path.join(dp1TexturesRoot(), "Done"); }
function dp1TexturesMetaFile()    { return path.join(dp1TexturesRoot(), "meta.json"); }

function dp1FontsRoot() {
  return path.join(app.getPath("documents"), "SWERY-Localization-Tool", "DP1", "Fonts");
}
function dp1FontsOriginalDir() { return path.join(dp1FontsRoot(), "Original"); }
function dp1FontsDoneDir()     { return path.join(dp1FontsRoot(), "Done"); }

const XPC2_MAGIC = Buffer.from("XPC2", "ascii");

// Парсить header XPC2 архіву. Повертає offsets/sizes, internal_name та
// розпакований payload. КИДАЄ якщо magic не XPC2 або zlib зламано.
function parseXpc2(raw) {
  if (raw.length < 0x58 || !raw.slice(0, 4).equals(XPC2_MAGIC)) {
    throw new Error("Not an XPC2 archive (magic mismatch)");
  }
  const total_size = raw.readUInt32LE(0x04);
  const name_off   = raw.readUInt32LE(0x20);
  const data_off   = raw.readUInt32LE(0x24);
  const data_off2  = raw.readUInt32LE(0x50);
  const comp_size  = raw.readUInt32LE(0x54);
  // null-terminated string в name_off, обмежено data_off.
  let nameEnd = name_off;
  while (nameEnd < data_off && nameEnd < raw.length && raw[nameEnd] !== 0) nameEnd++;
  const internal_name = raw.slice(name_off, nameEnd).toString("latin1");
  if (data_off + comp_size > raw.length) {
    throw new Error(`compressed payload exceeds file (data_off=${data_off}+comp=${comp_size} > total=${raw.length})`);
  }
  const comp = raw.slice(data_off, data_off + comp_size);
  const payload = zlib.inflateSync(comp);
  return { total_size, name_off, data_off, data_off2, comp_size, internal_name, payload };
}

// Sanitize internal_name → безпечне FS-ім'я. Без directory parts, без CTRL.
function dp1XpcSafeName(internal, fallbackExt) {
  let n = internal.split("\x00")[0];
  n = n.replace(/[\x00-\x1F]/g, "");
  n = n.replace(/\\/g, "/").split("/").pop() || "";
  n = n.replace(/[<>:"|?*]/g, "_").replace(/\s+$/, "").replace(/\.+$/, "");
  if (!n) n = "payload" + (fallbackExt || ".bin");
  if (!path.extname(n) && fallbackExt) n += fallbackExt;
  return n;
}
function dp1XpcGuessExt(payload) {
  if (payload.length >= 4 && payload.slice(0, 4).equals(Buffer.from("DDS "))) return ".dds";
  if (payload.length >= 8 && payload.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return ".png";
  if (payload.length >= 2 && payload[0] === 0xFF && payload[1] === 0xD8) return ".jpg";
  return ".bin";
}

// Рекурсивно шукає всі *.xpc у root, повертає abs paths.
async function dp1ListXpcFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".xpc")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

// Список XPC-файлів у грі — для UI. Повертає relпуть + size + чи є вже extracted.
ipcMain.handle("dp2:dp1-textures-list", async () => {
  try {
    const settings = await readSettings();
    const gameRoot = settings.dp1Root;
    if (!gameRoot) return { ok: false, error: "dp1Root не задано — налаштуй у Settings шлях до гри" };
    try { await fs.access(gameRoot); }
    catch { return { ok: false, error: "Game root не існує: " + gameRoot }; }
    const xpcFiles = await dp1ListXpcFiles(gameRoot);
    // Читаємо meta.json (sidecar з нашими витягами) — щоб бачити які вже extracted.
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(dp1TexturesMetaFile(), "utf8")); } catch {}
    const items = await Promise.all(xpcFiles.map(async (full) => {
      const rel = path.relative(gameRoot, full);
      let size = 0; try { size = (await fs.stat(full)).size; } catch {}
      const m = meta[rel] || null;
      return {
        relPath: rel,
        fullPath: full,
        size,
        internalName: m?.internalName ?? null,
        ext: m?.ext ?? null,
        extracted: !!m?.extractedAt,
        replaced: !!m?.replacedAt,
      };
    }));
    items.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { ok: true, items, gameRoot, originalDir: dp1TexturesOriginalDir(), doneDir: dp1TexturesDoneDir() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Розпаковує всі .xpc у Original/. Емітить прогрес через "dp2:dp1-textures-progress".
ipcMain.handle("dp2:dp1-textures-extract-all", async () => {
  try {
    const settings = await readSettings();
    const gameRoot = settings.dp1Root;
    if (!gameRoot) return { ok: false, error: "dp1Root не задано" };
    const xpcFiles = await dp1ListXpcFiles(gameRoot);
    const origDir = dp1TexturesOriginalDir();
    await fs.mkdir(origDir, { recursive: true });
    await fs.mkdir(dp1TexturesDoneDir(), { recursive: true });
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(dp1TexturesMetaFile(), "utf8")); } catch {}
    let done = 0, failed = 0;
    for (const xpc of xpcFiles) {
      const rel = path.relative(gameRoot, xpc);
      try {
        const raw = await fs.readFile(xpc);
        const parsed = parseXpc2(raw);
        const ext = dp1XpcGuessExt(parsed.payload);
        const safe = dp1XpcSafeName(parsed.internal_name, ext);
        // Зберігаємо у Original/ зі структурою як у грі (за relPath без розширення .xpc).
        const relDir = path.dirname(rel);
        const outDir = path.join(origDir, relDir);
        await fs.mkdir(outDir, { recursive: true });
        const outFile = path.join(outDir, safe);
        await fs.writeFile(outFile, parsed.payload);
        meta[rel] = {
          internalName: parsed.internal_name,
          ext,
          safeName: safe,
          extractedAt: Date.now(),
          replacedAt: meta[rel]?.replacedAt ?? null,
        };
        done++;
      } catch (e) {
        failed++;
        meta[rel] = { ...(meta[rel] || {}), lastError: String(e.message || e) };
      }
      if ((done + failed) % 50 === 0) {
        try { mainWindow?.webContents.send("dp2:dp1-textures-progress", { done: done + failed, total: xpcFiles.length }); } catch {}
      }
    }
    await fs.writeFile(dp1TexturesMetaFile(), JSON.stringify(meta, null, 2), "utf8");
    try { mainWindow?.webContents.send("dp2:dp1-textures-progress", { done: xpcFiles.length, total: xpcFiles.length }); } catch {}
    return { ok: true, total: xpcFiles.length, extracted: done, failed };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Запакувати всі замінені текстури з Done/ назад у гру. Для кожного xpc:
//   1) читаємо оригінал з гри (для header passthrough)
//   2) знаходимо replacement у Done/<rel>/<safeName>
//   3) zlib.deflate новий payload, переписуємо header (data_off2 = data_off,
//      comp_size = new len), пишемо новий .xpc у гру (з .bak якщо ще нема).
ipcMain.handle("dp2:dp1-textures-pack-all", async () => {
  try {
    const settings = await readSettings();
    const gameRoot = settings.dp1Root;
    if (!gameRoot) return { ok: false, error: "dp1Root не задано" };
    let meta = {};
    try { meta = JSON.parse(await fs.readFile(dp1TexturesMetaFile(), "utf8")); } catch {
      return { ok: false, error: "meta.json не знайдено — спершу Extract" };
    }
    const doneDir = dp1TexturesDoneDir();
    let replaced = 0, skipped = 0, failed = 0;
    const entries = Object.entries(meta);
    for (const [rel, m] of entries) {
      if (!m || !m.safeName) { skipped++; continue; }
      const replPath = path.join(doneDir, path.dirname(rel), m.safeName);
      try { await fs.access(replPath); } catch { skipped++; continue; }
      const xpcAbs = path.join(gameRoot, rel);
      try {
        assertSafeWritePath(xpcAbs);
        const raw = await fs.readFile(xpcAbs);
        if (!raw.slice(0, 4).equals(XPC2_MAGIC)) throw new Error("Not XPC2");
        const data_off = raw.readUInt32LE(0x24);
        const newPayload = await fs.readFile(replPath);
        const newComp = zlib.deflateSync(newPayload, { level: 9 });
        // header passthrough до data_off, потім новий compressed payload.
        const newRaw = Buffer.alloc(data_off + newComp.length);
        raw.copy(newRaw, 0, 0, data_off);
        // оновлюємо data_off2 = data_off (як у Python tool — single-payload mode).
        newRaw.writeUInt32LE(data_off, 0x50);
        newRaw.writeUInt32LE(newComp.length, 0x54);
        newRaw.writeUInt32LE(newRaw.length, 0x04);
        newComp.copy(newRaw, data_off);
        // .bak — якщо ще нема.
        const bak = xpcAbs + ".bak";
        try { await fs.access(bak); }
        catch { try { await fs.copyFile(xpcAbs, bak); } catch {} }
        await withFileLock(xpcAbs, async () => {
          await fs.writeFile(xpcAbs, newRaw);
        });
        meta[rel] = { ...m, replacedAt: Date.now(), lastError: null };
        replaced++;
      } catch (e) {
        failed++;
        meta[rel] = { ...m, lastError: String(e.message || e) };
      }
      if ((replaced + skipped + failed) % 25 === 0) {
        try { mainWindow?.webContents.send("dp2:dp1-textures-progress", { done: replaced + skipped + failed, total: entries.length, phase: "pack" }); } catch {}
      }
    }
    await fs.writeFile(dp1TexturesMetaFile(), JSON.stringify(meta, null, 2), "utf8");
    try { mainWindow?.webContents.send("dp2:dp1-textures-progress", { done: entries.length, total: entries.length, phase: "pack" }); } catch {}
    return { ok: true, replaced, skipped, failed };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Single-file: розпакувати один .xpc → повернути payload base64 для preview.
ipcMain.handle("dp2:dp1-texture-read-payload", async (_event, relPath) => {
  try {
    const settings = await readSettings();
    const gameRoot = settings.dp1Root;
    if (!gameRoot || !relPath) return { ok: false, error: "missing dp1Root or relPath" };
    const xpc = path.join(gameRoot, relPath);
    const raw = await fs.readFile(xpc);
    const parsed = parseXpc2(raw);
    const ext = dp1XpcGuessExt(parsed.payload);
    return { ok: true, base64: parsed.payload.toString("base64"), ext, internalName: parsed.internal_name, payloadSize: parsed.payload.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Single-file: замінити payload у конкретному .xpc.
ipcMain.handle("dp2:dp1-texture-replace-one", async (_event, payload) => {
  try {
    const settings = await readSettings();
    const gameRoot = settings.dp1Root;
    const relPath = String(payload?.relPath || "").trim();
    const base64 = String(payload?.base64 || "");
    if (!gameRoot || !relPath || !base64) return { ok: false, error: "missing fields" };
    const xpcAbs = assertSafeWritePath(path.join(gameRoot, relPath));
    const raw = await fs.readFile(xpcAbs);
    if (!raw.slice(0, 4).equals(XPC2_MAGIC)) throw new Error("Not XPC2");
    const data_off = raw.readUInt32LE(0x24);
    const newPayload = Buffer.from(base64, "base64");
    const newComp = zlib.deflateSync(newPayload, { level: 9 });
    const newRaw = Buffer.alloc(data_off + newComp.length);
    raw.copy(newRaw, 0, 0, data_off);
    newRaw.writeUInt32LE(data_off, 0x50);
    newRaw.writeUInt32LE(newComp.length, 0x54);
    newRaw.writeUInt32LE(newRaw.length, 0x04);
    newComp.copy(newRaw, data_off);
    const bak = xpcAbs + ".bak";
    try { await fs.access(bak); }
    catch { try { await fs.copyFile(xpcAbs, bak); } catch {} }
    await withFileLock(xpcAbs, async () => {
      await fs.writeFile(xpcAbs, newRaw);
    });
    // Update meta.replacedAt
    try {
      let meta = {};
      try { meta = JSON.parse(await fs.readFile(dp1TexturesMetaFile(), "utf8")); } catch {}
      if (meta[relPath]) {
        meta[relPath] = { ...meta[relPath], replacedAt: Date.now() };
        await fs.writeFile(dp1TexturesMetaFile(), JSON.stringify(meta, null, 2), "utf8");
      }
    } catch {}
    return { ok: true, size: newRaw.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ── DDS BC1 (DXT1) codec ────────────────────────────────────────
// Compact pure-JS decoder/encoder for BC1 — потрібен для DP1 fontwide.dds
// (2048×1184, DXT1) edit-flow: розпакуємо у RGBA для canvas → користувач
// малює гліфи поверх → пакуємо назад у DXT1 і пишемо у Done/FONTWIDE.DDS.
// BC1 = 4×4 px block / 8 bytes = 2 RGB565 endpoints + 16×2-bit indices.

function rgb565Unpack(c) {
  const r5 = (c >> 11) & 0x1F;
  const g6 = (c >> 5) & 0x3F;
  const b5 = c & 0x1F;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}
function rgb565Pack(r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}
function bc1Decode(buf, width, height) {
  const out = new Uint8Array(width * height * 4);
  const blocksX = width >> 2;
  const blocksY = height >> 2;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 8;
      const c0 = buf.readUInt16LE(off);
      const c1 = buf.readUInt16LE(off + 2);
      const codes = buf.readUInt32LE(off + 4);
      const [r0, g0, b0] = rgb565Unpack(c0);
      const [r1, g1, b1] = rgb565Unpack(c1);
      let palette;
      if (c0 > c1) {
        palette = [
          [r0, g0, b0, 255],
          [r1, g1, b1, 255],
          [((2 * r0 + r1) / 3) | 0, ((2 * g0 + g1) / 3) | 0, ((2 * b0 + b1) / 3) | 0, 255],
          [((r0 + 2 * r1) / 3) | 0, ((g0 + 2 * g1) / 3) | 0, ((b0 + 2 * b1) / 3) | 0, 255],
        ];
      } else {
        palette = [
          [r0, g0, b0, 255],
          [r1, g1, b1, 255],
          [((r0 + r1) / 2) | 0, ((g0 + g1) / 2) | 0, ((b0 + b1) / 2) | 0, 255],
          [0, 0, 0, 0],
        ];
      }
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const idx = (codes >>> ((py * 4 + px) * 2)) & 0x3;
          const pix = palette[idx];
          const x = bx * 4 + px;
          const y = by * 4 + py;
          const o = (y * width + x) * 4;
          out[o] = pix[0]; out[o + 1] = pix[1]; out[o + 2] = pix[2]; out[o + 3] = pix[3];
        }
      }
    }
  }
  return out;
}

// Encoder: для кожного 4×4 блоку знаходимо min/max colors уздовж axis-у
// найбільшої variance, формуємо ендпоінти, mapping pixels на найближчий
// з 4 палітра-колорів. Простий неоптимальний алгоритм — достатньо для
// шрифтового атласу (де артефакти не помітні на тлі білих гліфів).
function bc1Encode(rgba, width, height) {
  const blocksX = width >> 2;
  const blocksY = height >> 2;
  const out = Buffer.alloc(blocksX * blocksY * 8);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      // Збираємо 16 пікселів блоку
      const pixels = new Array(16);
      let hasAlpha = false;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          const o = (y * width + x) * 4;
          const a = rgba[o + 3];
          if (a < 128) hasAlpha = true;
          pixels[py * 4 + px] = [rgba[o], rgba[o + 1], rgba[o + 2], a];
        }
      }
      // Знаходимо min/max по сумі RGB (proxy для intensity).
      let minP = pixels[0], maxP = pixels[0];
      let minSum = minP[0] + minP[1] + minP[2];
      let maxSum = minSum;
      for (let i = 1; i < 16; i++) {
        if (pixels[i][3] < 128) continue;
        const s = pixels[i][0] + pixels[i][1] + pixels[i][2];
        if (s < minSum) { minSum = s; minP = pixels[i]; }
        if (s > maxSum) { maxSum = s; maxP = pixels[i]; }
      }
      const c0 = rgb565Pack(maxP[0], maxP[1], maxP[2]);
      const c1 = rgb565Pack(minP[0], minP[1], minP[2]);
      let e0 = c0, e1 = c1;
      // Якщо блок має alpha-pixels → mode2 (e0 <= e1) + 4-й колір прозорий.
      if (hasAlpha && e0 > e1) { const t = e0; e0 = e1; e1 = t; }
      else if (!hasAlpha && e0 <= e1) {
        // Уникаємо невпорядкованого режиму — додамо 1 до e0 щоб був > e1.
        if (e0 < 0xFFFF) e0 = Math.max(e0 + 1, e1 + 1);
      }
      const [r0, g0, b0] = rgb565Unpack(e0);
      const [r1, g1, b1] = rgb565Unpack(e1);
      let palette;
      if (e0 > e1) {
        palette = [
          [r0, g0, b0, 255],
          [r1, g1, b1, 255],
          [((2 * r0 + r1) / 3) | 0, ((2 * g0 + g1) / 3) | 0, ((2 * b0 + b1) / 3) | 0, 255],
          [((r0 + 2 * r1) / 3) | 0, ((g0 + 2 * g1) / 3) | 0, ((b0 + 2 * b1) / 3) | 0, 255],
        ];
      } else {
        palette = [
          [r0, g0, b0, 255],
          [r1, g1, b1, 255],
          [((r0 + r1) / 2) | 0, ((g0 + g1) / 2) | 0, ((b0 + b1) / 2) | 0, 255],
          [0, 0, 0, 0],
        ];
      }
      // mapping: для кожного pixel — найближча колір (squared distance).
      let codes = 0;
      for (let i = 0; i < 16; i++) {
        const p = pixels[i];
        let best = 0, bestDist = Infinity;
        // Якщо alpha < 128 і палітра має transparent — мапимо туди.
        if (p[3] < 128 && palette[3][3] === 0) {
          best = 3;
        } else {
          for (let k = 0; k < (palette[3][3] === 0 ? 3 : 4); k++) {
            const pk = palette[k];
            const dr = p[0] - pk[0], dg = p[1] - pk[1], db = p[2] - pk[2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestDist) { bestDist = d; best = k; }
          }
        }
        codes |= (best & 0x3) << (i * 2);
      }
      const off = (by * blocksX + bx) * 8;
      out.writeUInt16LE(e0, off);
      out.writeUInt16LE(e1, off + 2);
      out.writeUInt32LE(codes >>> 0, off + 4);
    }
  }
  return out;
}

// ── DP1 Fonts (fontwide.xpc → FONTWIDE.DDS) ─────────────────────
// Шрифти у DP1 — окремий XPC2-архів `fontwide.xpc`, що розпаковується у
// одну DDS-текстуру `FONTWIDE.DDS`. Зараз робимо тільки extract:
// знаходимо .xpc у грі, розпаковуємо у Fonts/Original/FONTWIDE.DDS і
// готуємо порожню Fonts/Done/ для майбутніх замінників.
ipcMain.handle("dp2:dp1-fonts-prep", async () => {
  try {
    const settings = await readSettings();
    const gameRoot = settings.dp1Root;
    if (!gameRoot) return { ok: false, error: "dp1Root не задано — налаштуй у Settings шлях до гри" };
    // Шукаємо fontwide.xpc рекурсивно (case-insensitive).
    const all = await dp1ListXpcFiles(gameRoot);
    const xpc = all.find((p) => path.basename(p).toLowerCase() === "fontwide.xpc");
    if (!xpc) return { ok: false, error: "fontwide.xpc не знайдено у теці гри" };

    const origDir = dp1FontsOriginalDir();
    const doneDir = dp1FontsDoneDir();
    await fs.mkdir(origDir, { recursive: true });
    await fs.mkdir(doneDir, { recursive: true });

    const raw = await fs.readFile(xpc);
    const parsed = parseXpc2(raw);
    const ext = dp1XpcGuessExt(parsed.payload);
    // Жорстко тримаємо ім'я "FONTWIDE.DDS" (як просив юзер) — навіть якщо
    // internal_name відрізняється. Розширення підставляємо з реального
    // payload (мабуть .dds, але якщо колись зміниться формат — guess).
    const safe = "FONTWIDE" + (ext || ".dds");
    const outFile = path.join(origDir, safe);
    await fs.writeFile(outFile, parsed.payload);

    return {
      ok: true,
      xpcPath: xpc,
      ddsPath: outFile,
      doneDir,
      originalDir: origDir,
      internalName: parsed.internal_name,
      payloadSize: parsed.payload.length,
      ext,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// URL до офіційного шрифту DP1 (Cinema Calligraphy Regular) на Dropbox.
// Шрифт ліцензований Rising Star Games — це той самий файл, що гра використовує
// для рендеру субтитрів. Кладемо у DP1/Fonts/Cinema_Calligraphy-Regular.otf
// один раз при першому відкритті Fonts editor.
const DP1_TYPEFACE_URL = "https://www.dropbox.com/scl/fi/oqh2gcz2htwzoems183fm/Cinema_Calligraphy-Regular.otf?rlkey=81xetudep57dtzp3cmvtz12fx&st=lccbfua6&dl=1";
const DP1_TYPEFACE_NAME = "Cinema_Calligraphy-Regular.otf";

function dp1TypefacePath() {
  return path.join(dp1FontsRoot(), DP1_TYPEFACE_NAME);
}

// Перевіряє чи Cinema_Calligraphy-Regular.otf уже лежить локально; якщо ні —
// качає з Dropbox і кладе у DP1/Fonts/. Емітить прогрес через
// "dp2:dp1-fonts-typeface-progress" event. Перевикористовує setupTools.
//
// In-flight guard: React StrictMode (dev) робить mount/unmount/mount, тож
// renderer може викликати ensure двічі майже одночасно. Без guard другий
// виклик ловить ENOENT на rename .part — бо перший уже rename-нув.
let _dp1TypefaceInflight = null;
ipcMain.handle("dp2:dp1-fonts-ensure-typeface", async () => {
  if (_dp1TypefaceInflight) return _dp1TypefaceInflight;
  _dp1TypefaceInflight = (async () => {
    try {
      const root = dp1FontsRoot();
      await fs.mkdir(root, { recursive: true });
      const dest = dp1TypefacePath();
      try {
        const st = await fs.stat(dest);
        if (st.size > 50_000) {
          return { ok: true, path: dest, cached: true, size: st.size };
        }
      } catch {}
      try { mainWindow?.webContents.send("dp2:dp1-fonts-typeface-progress", { phase: "start", total: 0, downloaded: 0, percent: 0 }); } catch {}
      const res = await setupTools.downloadFile(DP1_TYPEFACE_URL, dest, (p) => {
        try {
          mainWindow?.webContents.send("dp2:dp1-fonts-typeface-progress", {
            phase: "download",
            total: p.total, downloaded: p.downloaded, percent: p.percent,
          });
        } catch {}
      });
      try { mainWindow?.webContents.send("dp2:dp1-fonts-typeface-progress", { phase: "done", total: res.size ?? 0, downloaded: res.size ?? 0, percent: 100 }); } catch {}
      return { ok: true, path: dest, cached: false, size: res.size };
    } catch (e) {
      try { mainWindow?.webContents.send("dp2:dp1-fonts-typeface-progress", { phase: "error", error: String(e.message || e) }); } catch {}
      return { ok: false, error: String(e.message || e) };
    } finally {
      _dp1TypefaceInflight = null;
    }
  })();
  return _dp1TypefaceInflight;
});

// Читає FONTWIDE.DDS (з Done/ якщо там існує, інакше Original/) і
// розпаковує BC1 у RGBA для canvas-preview у renderer.
ipcMain.handle("dp2:dp1-fonts-read-rgba", async () => {
  try {
    const doneFile = path.join(dp1FontsDoneDir(), "FONTWIDE.DDS");
    const origFile = path.join(dp1FontsOriginalDir(), "FONTWIDE.DDS");
    let src; let source = "done";
    try { await fs.access(doneFile); src = doneFile; }
    catch { try { await fs.access(origFile); src = origFile; source = "original"; }
            catch { return { ok: false, error: "FONTWIDE.DDS не знайдено — спершу натисни Перерозпакувати на сторінці Шрифти" }; } }
    const raw = await fs.readFile(src);
    if (raw.length < 128 || raw.slice(0, 4).toString() !== "DDS ") {
      return { ok: false, error: "Не схоже на DDS" };
    }
    const height = raw.readUInt32LE(12);
    const width = raw.readUInt32LE(16);
    const fourcc = raw.slice(84, 88).toString();
    if (fourcc !== "DXT1") {
      return { ok: false, error: `Unsupported DDS format: ${fourcc} (підтримується тільки DXT1/BC1)` };
    }
    const blockData = raw.slice(128); // header = 128 bytes
    const rgba = bc1Decode(blockData, width, height);
    return {
      ok: true,
      width, height,
      rgbaBase64: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString("base64"),
      source,
      srcPath: src,
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Зберігає змінений RGBA назад як BC1 DDS у Done/FONTWIDE.DDS.
// Header passthrough з Original — тільки pixel data перерахована.
ipcMain.handle("dp2:dp1-fonts-save-rgba", async (_event, payload) => {
  try {
    const width = Number(payload?.width || 0);
    const height = Number(payload?.height || 0);
    const b64 = String(payload?.rgbaBase64 || "");
    if (!width || !height || !b64) return { ok: false, error: "bad args" };
    if ((width & 3) !== 0 || (height & 3) !== 0) {
      return { ok: false, error: `Width/height must be /4: got ${width}×${height}` };
    }
    const rgba = Buffer.from(b64, "base64");
    if (rgba.length !== width * height * 4) {
      return { ok: false, error: `RGBA size mismatch: got ${rgba.length}, expect ${width * height * 4}` };
    }
    // Беремо header з Original — щоб гра не помітила різниці в pitch/flags.
    const origFile = path.join(dp1FontsOriginalDir(), "FONTWIDE.DDS");
    let header;
    try { header = (await fs.readFile(origFile)).slice(0, 128); }
    catch { return { ok: false, error: "Original/FONTWIDE.DDS не знайдено" }; }
    const compressed = bc1Encode(rgba, width, height);
    const out = Buffer.concat([header, compressed]);
    const doneDir = dp1FontsDoneDir();
    await fs.mkdir(doneDir, { recursive: true });
    const outFile = path.join(doneDir, "FONTWIDE.DDS");
    assertSafeWritePath(outFile);
    await withFileLock(outFile, async () => { await fs.writeFile(outFile, out); });
    return { ok: true, outFile, size: out.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Зчитує довільний TTF/OTF файл і повертає bytes як base64.
// Потрібно для FontFace API у renderer (canvas рендеритьgly гліфів).
ipcMain.handle("dp2:read-font-file", async (_event, fontPath) => {
  try {
    if (!fontPath || typeof fontPath !== "string") return { ok: false, error: "bad path" };
    const bytes = await fs.readFile(fontPath);
    return { ok: true, base64: bytes.toString("base64"), size: bytes.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
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

// ── IPC: open external URL (для GitHub release links з update-banner) ───
ipcMain.handle("dp2:open-external", async (_event, url) => {
  if (typeof url !== "string") return { ok: false, error: "url must be string" };
  // Дозволяємо тільки http(s) і steam:// — щоб renderer не міг відкрити
  // file:/// або довільний exec-протокол.
  if (!/^(https?|steam):\/\//i.test(url)) return { ok: false, error: "unsupported protocol" };
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// ── IPC: GitHub update check ──────────────────────────────────────
// Опитуємо releases/latest. Кеш у settings (lastUpdateCache + ts), TTL 6h.
// Якщо latest > app.getVersion() — renderer показує банер. Користувач може
// "приховати" версію → у settings.dismissedUpdateVersion записується tag.
const UPDATE_REPO = "LittleBitUA/SWERY-Localization-Tool";
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

function compareSemver(a, b) {
  // Робастно: бере цифрові частини мажор.мінор.патч (ігнорує суфікси -alpha тощо)
  const norm = (v) => String(v).replace(/^v/i, "").split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pa = norm(a); const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const va = pa[i] ?? 0; const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

ipcMain.handle("dp2:check-update", async (_event, payload) => {
  const force = !!(payload && payload.force);
  const settings = await readSettings();
  const now = Date.now();
  if (!force && settings.lastUpdateCache && settings.lastUpdateCheck &&
      (now - settings.lastUpdateCheck) < UPDATE_TTL_MS) {
    return settings.lastUpdateCache;
  }
  try {
    const url = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "SWERY-Localization-Tool",
        "Accept": "application/vnd.github+json",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const tag = String(data.tag_name || "").replace(/^v/i, "");
    if (!tag) return { ok: false, error: "release has no tag_name" };
    const current = app.getVersion();
    const available = compareSemver(current, tag) < 0;
    const result = {
      ok: true,
      available,
      current,
      latest: tag,
      htmlUrl: data.html_url,
      publishedAt: data.published_at,
      name: data.name || tag,
      body: data.body || "",
    };
    await writeSettings({ ...settings, lastUpdateCheck: now, lastUpdateCache: result });
    return result;
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle("dp2:app-version", () => app.getVersion());

// ── Auto-update: download .exe asset → swap → restart ─────────────────
// Підхід — той самий, що в DP1 Launcher: знаходимо .exe asset у latest
// release, завантажуємо у %TEMP% з прогресом, пишемо .bat що чекає поки
// поточний exe закриється, копіює новий на місце і запускає назад.
// VBS-обгортка над .bat — щоб не блимало консольне вікно (windowsHide
// ігнорується для detached child-процесів).
function findLatestExeAsset() {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    https.request({
      hostname: "api.github.com",
      path: `/repos/${UPDATE_REPO}/releases/latest`,
      method: "GET",
      headers: {
        "User-Agent": `SWERY-Localization-Tool/${app.getVersion()}`,
        "Accept": "application/vnd.github+json",
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = ""; res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(raw);
          // Шукаємо `portable.exe` як найпріоритетніший (наш artifact),
          // інакше будь-який .exe. .zip також підтримуємо як fallback.
          const assets = data.assets || [];
          const pick = assets.find((a) => /portable\.exe$/i.test(a.name))
            || assets.find((a) => /\.exe$/i.test(a.name))
            || assets.find((a) => /\.zip$/i.test(a.name));
          if (!pick) return reject(new Error("No .exe/.zip asset in latest release"));
          resolve({
            url: pick.browser_download_url,
            name: pick.name,
            size: pick.size,
            isZip: /\.zip$/i.test(pick.name),
          });
        } catch (err) { reject(err); }
      });
    }).on("error", reject).end();
  });
}

function downloadToFile(url, destPath, onProgress) {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    const fsNode = require("node:fs");
    let downloaded = 0; let total = 0;
    const start = Date.now();
    const file = fsNode.createWriteStream(destPath);
    const cleanup = (err) => {
      try { file.close(); } catch {}
      fs.unlink(destPath).catch(() => {});
      reject(err);
    };
    const go = (currentUrl, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(currentUrl); } catch (e) { return cleanup(e); }
      const req = https.get(parsed, {
        headers: { "User-Agent": `SWERY-Localization-Tool/${app.getVersion()}` },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return cleanup(new Error("Too many redirects"));
          return go(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(new Error(`HTTP ${res.statusCode}`));
        }
        total = parseInt(res.headers["content-length"] || "0", 10) || 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (onProgress) {
            const elapsed = (Date.now() - start) / 1000;
            const speed = elapsed > 0 ? downloaded / elapsed : 0;
            onProgress({ downloaded, total, speed });
          }
        });
        res.pipe(file);
        file.on("finish", () => { file.close(() => resolve({ size: downloaded })); });
        file.on("error", cleanup);
      });
      req.on("timeout", () => req.destroy(new Error("Request timeout")));
      req.on("error", cleanup);
    };
    go(url, 5);
  });
}

ipcMain.handle("dp2:apply-update", async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const send = (type, extra = {}) => {
    try { win?.webContents.send("dp2:update-progress", { type, ...extra }); } catch {}
  };
  if (!app.isPackaged) {
    send("error", { error: "Auto-update вимкнено в dev-режимі (запущено un-packaged Electron)." });
    return { ok: false, error: "dev-mode" };
  }
  try {
    send("locating");
    const asset = await findLatestExeAsset();
    const stamp = Date.now();
    const tmpAsset = path.join(os.tmpdir(), `swery-update-${stamp}-${asset.name}`);
    send("downloading", { name: asset.name, downloaded: 0, total: asset.size, speed: 0 });
    await downloadToFile(asset.url, tmpAsset, (p) => send("downloading", { ...p, name: asset.name }));

    const installDir = path.dirname(process.execPath);
    const exeName = path.basename(process.execPath);
    const targetExe = path.join(installDir, exeName);
    const batchPath = path.join(os.tmpdir(), `swery-update-${stamp}.bat`);
    const vbsPath = path.join(os.tmpdir(), `swery-update-${stamp}.vbs`);

    // Простий swap для single-exe portable: чекаємо exit + copy/move з ретраями
    // (файл може бути ще locked десь секунду після quit).
    const batch =
      "@echo off\r\n" +
      "chcp 65001 >nul\r\n" +
      "timeout /t 2 /nobreak >nul\r\n" +
      ":retry\r\n" +
      `copy /Y "${tmpAsset}" "${targetExe}" >nul 2>&1\r\n` +
      "if errorlevel 1 (timeout /t 1 /nobreak >nul & goto retry)\r\n" +
      `start "" "${targetExe}"\r\n` +
      `del "${tmpAsset}" >nul 2>&1\r\n` +
      `del "${vbsPath}" >nul 2>&1\r\n` +
      "del \"%~f0\"\r\n";
    await fs.writeFile(batchPath, batch, { encoding: "utf8" });
    const vbs = `CreateObject("WScript.Shell").Run "cmd /c ""${batchPath}""", 0, False\r\n`;
    await fs.writeFile(vbsPath, vbs, { encoding: "utf8" });

    send("installing");
    spawn("wscript.exe", [vbsPath], {
      detached: true, stdio: "ignore", windowsHide: true, shell: false,
    }).unref();
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (e) {
    const msg = String(e?.message ?? e);
    try { win?.webContents.send("dp2:update-progress", { type: "error", error: msg }); } catch {}
    return { ok: false, error: msg };
  }
});

// ── IPC: Steam game auto-detect ──────────────────────────────────────
// Знаходить теку common/<folderName> по всіх Steam-бібліотеках. Реєстр
// HKCU\Software\Valve\Steam → SteamPath, потім steamapps/libraryfolders.vdf
// → список library-paths. Працює навіть якщо гра встановлена на іншому диску.
async function readSteamPath() {
  // 1) Через реєстр (Windows): reg query HKCU\Software\Valve\Steam /v SteamPath
  try {
    const { execSync } = require("node:child_process");
    const stdout = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
      windowsHide: true, timeout: 4000,
    }).toString("utf8");
    const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) return m[1].trim().replace(/\//g, "\\");
  } catch {}
  // 2) Fallback: дефолтні шляхи.
  for (const guess of [
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
  ]) {
    try { await fs.access(guess); return guess; } catch {}
  }
  return null;
}

async function findSteamGame(folderName) {
  const steamPath = await readSteamPath();
  if (!steamPath) return { ok: false, error: "Steam path not found in registry" };
  const vdfPath = path.join(steamPath, "steamapps", "libraryfolders.vdf");
  let vdf = "";
  try { vdf = await fs.readFile(vdfPath, "utf8"); }
  catch { /* fallback — лише сам steamPath */ }
  // Витягуємо всі "path" "<value>" ключі — це самі library-теки.
  const libraries = new Set();
  libraries.add(steamPath);
  const re = /"path"\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(vdf)) !== null) {
    libraries.add(m[1].replace(/\\\\/g, "\\"));
  }
  for (const lib of libraries) {
    const candidate = path.join(lib, "steamapps", "common", folderName);
    try { const st = await fs.stat(candidate); if (st.isDirectory()) return { ok: true, path: candidate }; } catch {}
  }
  return { ok: false, error: `Game folder "${folderName}" not found in any Steam library` };
}

// ── D4 (Dark Dreams Don't Die) — UE3 v888 text editor ────────────
// Pipeline: COMPRESSED (LZO) msg_en_*.upk у грі → decompress.exe (Gildor) →
// uncompressed .upk → d4-text-export.ps1 (UELib + UPropertyTag stream)
// → JSON у Documents\SWERY-Localization-Tool\D4\Text\Original\.
// Mirror у Done/ для редагування. Pack — d4-text-import.ps1 будує
// uncompressed .upk з виправленим ExportTable + Latin-1 FString.

async function d4TextDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "D4", "Text");
  const tools = path.join(toolsDir, "D4", "Tools");
  return {
    baseDir,
    originalDir: path.join(baseDir, "Original"),
    doneDir: path.join(baseDir, "Done"),
    decompressedDir: path.join(baseDir, "Decompressed"),
    toolsDir: tools,
  };
}

// Шукаємо decompress.exe (Gildor) + Eliot.UELib.dll по кільком стандартним
// розташуванням. Якщо нема — повертаємо missing, UI запропонує prep.
async function d4ResolveTools() {
  const { toolsDir } = await d4TextDirs();
  const cands = {
    decompress: [
      path.join(toolsDir, "decompress.exe"),
      resolveResource("scripts/d4-tools/decompress.exe"),
    ],
    uelib: [
      path.join(toolsDir, "Eliot.UELib.dll"),
      path.join(toolsDir, "lib", "net8.0", "Eliot.UELib.dll"),
      path.join(app.getPath("temp"), "uelib", "extracted", "lib", "net8.0", "Eliot.UELib.dll"),
      resolveResource("scripts/d4-tools/Eliot.UELib.dll"),
    ],
  };
  async function firstExists(arr) {
    for (const p of arr) { try { await fs.access(p); return p; } catch {} }
    return null;
  }
  return {
    decompressExe: await firstExists(cands.decompress),
    uelibDll: await firstExists(cands.uelib),
  };
}

// Знаходимо у <d4Root> теку Ms01Game\CookedPCConsole і повертаємо список
// upk-файлів, які підлягають перекладу: msg_en_*.upk + Ms01Utility_LOC_INT.upk.
async function d4ResolveCooked(d4Root) {
  if (!d4Root) return { ok: false, error: "d4Root not set" };
  const cookedDir = path.join(d4Root, "Ms01Game", "CookedPCConsole");
  try { await fs.access(cookedDir); }
  catch { return { ok: false, error: "CookedPCConsole not found at " + cookedDir }; }
  let entries = [];
  try { entries = await fs.readdir(cookedDir); }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  // Тільки msg_en_*_SF.upk — там лежать всі ігрові діалоги (Ms01DataMessage).
  // Ms01Utility_LOC_INT.upk до тексту НЕ відноситься: цей пакет містить лише
  // 25 UFont + 175 Texture2D-атласів (бібліотека шрифтів гри). Для нього
  // окремий font-pipeline у вкладці «Шрифти».
  const msg = entries.filter((n) => /^msg_en_.+_SF\.upk$/i.test(n)).sort();
  return {
    ok: true,
    cookedDir,
    files: msg.map((name) => ({
      name,
      fullPath: path.join(cookedDir, name),
      isUtility: false,
    })),
  };
}

ipcMain.handle("dp2:d4-text-status", async () => {
  const settings = await readSettings();
  const d4Root = settings.d4Root || null;
  const { baseDir, originalDir, doneDir, decompressedDir, toolsDir } = await d4TextDirs();
  const cooked = d4Root ? await d4ResolveCooked(d4Root) : { ok: false, error: "d4Root not set" };
  const tools = await d4ResolveTools();
  // Поточний стан файлів у Done/Original: скільки .json лежить + швидкі
  // обсяги (для прогрес-бара та "X / Y" на головній картці).
  let originalCount = 0, doneCount = 0;
  try { const e = await fs.readdir(originalDir); originalCount = e.filter((f) => f.endsWith(".json")).length; } catch {}
  try { const e = await fs.readdir(doneDir); doneCount = e.filter((f) => f.endsWith(".json")).length; } catch {}
  return {
    ok: true,
    d4Root,
    cooked: cooked.ok ? cooked.cookedDir : null,
    cookedError: cooked.ok ? null : cooked.error,
    sourceFiles: cooked.ok ? cooked.files : [],
    baseDir, originalDir, doneDir, decompressedDir, toolsDir,
    originalCount, doneCount,
    tools: {
      decompressExe: tools.decompressExe,
      uelibDll: tools.uelibDll,
      ready: !!tools.decompressExe && !!tools.uelibDll,
    },
  };
});

ipcMain.handle("dp2:d4-text-extract", async () => {
  const settings = await readSettings();
  const d4Root = settings.d4Root;
  if (!d4Root) return { ok: false, error: "d4Root не задано" };
  const cooked = await d4ResolveCooked(d4Root);
  if (!cooked.ok) return { ok: false, error: cooked.error };
  const tools = await d4ResolveTools();
  if (!tools.decompressExe) return { ok: false, error: "decompress.exe не знайдено" };
  if (!tools.uelibDll) return { ok: false, error: "Eliot.UELib.dll не знайдено (поклади у Documents/SWERY-Localization-Tool/D4/Tools/)" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const { originalDir, doneDir, decompressedDir } = await d4TextDirs();
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(doneDir, { recursive: true });
  // Скидаємо кеш Decompressed/ — раніше тут могли залишитись compressed
  // копії від попередньої (зламаної) версії pipeline, які parser приймає
  // як готові й валиться на CompressionFlags=2. Безпечніше завжди заново.
  try { await fs.rm(decompressedDir, { recursive: true, force: true }); } catch {}
  await fs.mkdir(decompressedDir, { recursive: true });
  const exportScript = resolveResource("scripts/d4-text-export.ps1");
  const win = BrowserWindow.getAllWindows()[0];
  function emit(line) {
    try { win?.webContents.send("dp2:d4-text-progress", line); } catch {}
  }
  // Працюємо файл за файлом: decompress (якщо ще нема uncompressed копії у
  // Decompressed/) → export JSON у Original/<name>.json → копія в Done/ (якщо
  // там ще нема — Done — це робоча тека користувача).
  const results = [];
  for (const src of cooked.files) {
    const baseName = src.name.replace(/\.upk$/i, "");
    const decompressedPath = path.join(decompressedDir, src.name);
    const jsonOrig = path.join(originalDir, baseName + ".json");
    const jsonDone = path.join(doneDir, baseName + ".json");
    emit(`[STEP] ${src.name}`);
    // 1. Decompress (якщо потрібно).
    let needsDecompress = true;
    try { const st = await fs.stat(decompressedPath); if (st.size > 0) needsDecompress = false; } catch {}
    if (needsDecompress) {
      emit(`[STEP] decompress ${src.name}…`);
      const dec = await new Promise((resolve) => {
        // Gildor decompress.exe: `-out=<dir> <src>` → пише <dir>/<srcName>
        // напряму (без .dec суфіксу). Працюємо безпосередньо з ігровим
        // файлом — у Steam-тецi нічого не змінюємо, output у Decompressed/.
        const args = [`-out=${decompressedDir}`, src.fullPath];
        const child = spawn(tools.decompressExe, args, { windowsHide: true });
        let all = "";
        child.stdout.on("data", (d) => { all += d.toString(); });
        child.stderr.on("data", (d) => { all += d.toString(); });
        child.on("error", (err) => resolve({ ok: false, error: err.message, log: all }));
        child.on("exit", async () => {
          try {
            const st = await fs.stat(decompressedPath);
            if (st.size > 0) { resolve({ ok: true, log: all }); return; }
            resolve({ ok: false, error: "decompress: output 0 bytes", log: all });
          } catch (e) {
            const tail = all.split("\n").slice(-6).join(" ").trim();
            resolve({ ok: false, error: `decompress: no output at ${decompressedPath}. ${tail || e.message}`, log: all });
          }
        });
      });
      if (!dec.ok) {
        emit(`[ERR] decompress ${src.name}: ${dec.error}`);
        results.push({ name: src.name, ok: false, error: dec.error });
        continue;
      }
    } else {
      emit(`[SKIP] decompress (cached) ${src.name}`);
    }
    // 2. Export JSON.
    emit(`[STEP] export ${baseName}.json…`);
    const exp = await new Promise((resolve) => {
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", exportScript,
        "-SrcUpk", decompressedPath,
        "-OutJson", jsonOrig,
        "-UelibDll", tools.uelibDll,
      ];
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let leftover = "", all = "";
      const onData = (chunk) => {
        all += chunk;
        leftover += chunk;
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() || "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          emit(`  ${ln}`);
        }
      };
      child.stdout.on("data", (d) => onData(d.toString()));
      child.stderr.on("data", (d) => onData(d.toString()));
      child.on("error", (err) => resolve({ ok: false, error: err.message, log: all }));
      child.on("exit", (code) => {
        if (code !== 0) {
          const tail = all.split("\n").slice(-15).join("\n").trim();
          resolve({ ok: false, error: tail || `exit ${code}`, log: all });
          return;
        }
        let summary = null;
        const m = all.match(/RESULT_JSON:\s*(.+)$/m);
        if (m) { try { summary = JSON.parse(m[1]); } catch {} }
        resolve({ ok: true, summary, log: all });
      });
    });
    if (!exp.ok) {
      emit(`[ERR] export ${src.name}: ${exp.error}`);
      results.push({ name: src.name, ok: false, error: exp.error });
      continue;
    }
    // 3. Mirror у Done/ (якщо ще нема — копіюємо з Original).
    try { await fs.access(jsonDone); }
    catch {
      try { await fs.copyFile(jsonOrig, jsonDone); }
      catch (e) { emit(`[WARN] mirror Done: ${e.message}`); }
    }
    results.push({ name: src.name, ok: true, entries: exp.summary?.entries ?? 0 });
  }
  const ok = results.every((r) => r.ok);
  return { ok, results };
});

ipcMain.handle("dp2:d4-text-list", async () => {
  const { originalDir, doneDir } = await d4TextDirs();
  let names = [];
  try { names = (await fs.readdir(originalDir)).filter((n) => n.endsWith(".json")).sort(); } catch {}
  const items = [];
  for (const name of names) {
    const origPath = path.join(originalDir, name);
    const donePath = path.join(doneDir, name);
    let origSize = 0, doneSize = 0, doneMtime = 0;
    try { const st = await fs.stat(origPath); origSize = st.size; } catch {}
    try { const st = await fs.stat(donePath); doneSize = st.size; doneMtime = st.mtimeMs; } catch {}
    // «Перекладено» = m_aString рядок у Done відрізняється від відповідного
    // у Original (реальна правка користувача). Це точніше, ніж шукати
    // кирилицю — у DLC-пакетах гри є власні юнікод-рядки (імена в credits
    // тощо), які давали хибно-позитивний "переклад" без жодної дії юзера.
    let entries = 0, strings = 0, translated = 0;
    try {
      const [origRaw, doneRaw] = await Promise.all([
        fs.readFile(origPath, "utf8").catch(() => "[]"),
        fs.readFile(donePath, "utf8").catch(() => "[]"),
      ]);
      const origArr = JSON.parse(origRaw);
      const doneArr = JSON.parse(doneRaw);
      if (Array.isArray(doneArr)) {
        entries = doneArr.length;
        const origByName = new Map();
        if (Array.isArray(origArr)) {
          for (const e of origArr) if (e?.objectName) origByName.set(e.objectName, e);
        }
        for (const e of doneArr) {
          const s = Array.isArray(e?.m_aString) ? e.m_aString : [];
          strings += s.length;
          const orig = origByName.get(e?.objectName);
          const origStr = Array.isArray(orig?.m_aString) ? orig.m_aString : [];
          for (let i = 0; i < s.length; i++) {
            const v = s[i];
            const ov = origStr[i] ?? "";
            if (typeof v === "string" && v !== ov && v.trim() !== "") translated++;
          }
        }
      }
    } catch {}
    items.push({
      name, origPath, donePath,
      origSize, doneSize, doneMtime,
      entries, strings, translated,
    });
  }
  return { ok: true, items };
});

ipcMain.handle("dp2:d4-text-read", async (_e, fullPath) => {
  try {
    const raw = await fs.readFile(String(fullPath), "utf8");
    return { ok: true, content: raw };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:d4-text-write", async (_e, payload) => {
  const fullPath = String((payload && payload.fullPath) || "").trim();
  const content = String((payload && payload.content) ?? "");
  if (!fullPath) return { ok: false, error: "fullPath missing" };
  try {
    const safe = assertSafeWritePath(fullPath);
    return await withFileLock(safe, async () => {
      // Quick sanity: чи парситься JSON, щоб не зберігати ламаний файл.
      try { JSON.parse(content); }
      catch (e) { return { ok: false, error: "Invalid JSON: " + e.message }; }
      await fs.mkdir(path.dirname(safe), { recursive: true });
      // .bak — перший save за сесію (якщо ще нема .bak і файл існує).
      const bakPath = safe + ".bak";
      try {
        await fs.access(bakPath);
      } catch {
        try { await fs.copyFile(safe, bakPath); } catch {}
      }
      await fs.writeFile(safe, content, "utf8");
      return { ok: true };
    });
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// Повна статистика — для CorpusStatsModal. Делегуємо у heavy-worker
// (worker_threads), щоб не блокувати main під час парсингу cmn.json (~13 MB).
ipcMain.handle("dp2:d4-text-corpus-stats-full", async () => {
  try {
    const { originalDir, doneDir } = await d4TextDirs();
    const r = await callHeavy("d4-corpus-stats-full", { originalDir, doneDir });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// Глобальний пошук по всіх Done JSON — теж у worker.
ipcMain.handle("dp2:d4-text-search-all", async (_e, payload) => {
  const query = String((payload && payload.query) || "");
  const opts = (payload && payload.opts) || {};
  if (!query) return { ok: true, hits: [], truncated: false };
  try {
    const { doneDir } = await d4TextDirs();
    const r = await callHeavy("d4-search-all", { doneDir, query, opts });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// Batch replace cross-file. Йде по Done JSON всіх 14, робить заміну, пише.
ipcMain.handle("dp2:d4-text-batch-replace", async (_e, payload) => {
  const query = String((payload && payload.query) || "");
  const replacement = String((payload && payload.replacement) ?? "");
  const opts = (payload && payload.opts) || {};
  const dryRun = !!opts.dryRun;
  if (!query) return { ok: false, error: "query missing" };
  let rx;
  try {
    const flags = opts.caseSensitive ? "g" : "gi";
    if (opts.regex) rx = new RegExp(query, flags);
    else {
      let q = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (opts.wholeWord) q = `\\b${q}\\b`;
      rx = new RegExp(q, flags);
    }
  } catch (e) { return { ok: false, error: "bad-regex: " + e.message }; }
  const { doneDir } = await d4TextDirs();
  let names = [];
  try { names = (await fs.readdir(doneDir)).filter((n) => n.endsWith(".json")); } catch {}
  const results = [];
  let totalReplaced = 0;
  for (const name of names) {
    const donePath = path.join(doneDir, name);
    try {
      const raw = await fs.readFile(donePath, "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      let count = 0;
      for (const m of arr) {
        if (Array.isArray(m?.m_aString)) {
          for (let i = 0; i < m.m_aString.length; i++) {
            const v = m.m_aString[i] ?? "";
            const next = v.replace(rx, (m0) => { count++; return replacement; });
            if (next !== v) m.m_aString[i] = next;
          }
        }
      }
      if (count > 0) {
        totalReplaced += count;
        if (!dryRun) {
          const safe = assertSafeWritePath(donePath);
          const bak = safe + ".bak";
          try { await fs.access(bak); } catch { try { await fs.copyFile(safe, bak); } catch {} }
          await fs.writeFile(safe, JSON.stringify(arr, null, 2), "utf8");
        }
        results.push({ name, replaced: count });
      }
    } catch {}
  }
  return { ok: true, dryRun, totalReplaced, files: results };
});

// Per-entry meta: статус (draft/review/approved) + закладка + нотатка.
// Sidecar: <doneDir>/.d4-meta.json — { "<fileName>": { "<objectName>": {...} } }.
async function d4MetaFile() {
  const { doneDir } = await d4TextDirs();
  return path.join(doneDir, ".d4-meta.json");
}
ipcMain.handle("dp2:d4-meta-read", async (_e, donePath) => {
  try {
    const file = await d4MetaFile();
    const name = donePath ? path.basename(String(donePath)) : null;
    let all = {};
    try { all = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
    return { ok: true, all, perFile: name ? (all[name] ?? {}) : {} };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});
ipcMain.handle("dp2:d4-meta-write", async (_e, payload) => {
  const donePath = String((payload && payload.donePath) || "");
  const perFile = (payload && payload.perFile) || {};
  if (!donePath) return { ok: false, error: "donePath missing" };
  try {
    const file = await d4MetaFile();
    let all = {};
    try { all = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
    all[path.basename(donePath)] = perFile;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(all, null, 2), "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// Glossary: <doneDir>/.d4-glossary.json — масив { src, tgt, note? }.
async function d4GlossaryFile() {
  const { doneDir } = await d4TextDirs();
  return path.join(doneDir, ".d4-glossary.json");
}
ipcMain.handle("dp2:d4-glossary-read", async () => {
  try {
    const file = await d4GlossaryFile();
    let entries = [];
    try { entries = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
    if (!Array.isArray(entries)) entries = [];
    return { ok: true, entries };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});
ipcMain.handle("dp2:d4-glossary-write", async (_e, payload) => {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  try {
    const file = await d4GlossaryFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entries, null, 2), "utf8");
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// Translation Memory — у worker_threads (швидке для cmn).
ipcMain.handle("dp2:d4-tm-build", async () => {
  try {
    const { originalDir, doneDir } = await d4TextDirs();
    const r = await callHeavy("d4-tm-build", { originalDir, doneDir });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

// Швидка статистика для головного екрану (HomeV2): сума по всіх 14 JSON.
// Підраховує totalStrings (м_aString) + translated (Done != Original).
ipcMain.handle("dp2:d4-text-corpus-stats", async () => {
  try {
    const { originalDir, doneDir } = await d4TextDirs();
    let names = [];
    try { names = (await fs.readdir(originalDir)).filter((n) => n.endsWith(".json")); } catch {}
    let total = 0, translated = 0, files = 0;
    for (const name of names) {
      const origPath = path.join(originalDir, name);
      const donePath = path.join(doneDir, name);
      try {
        const [origRaw, doneRaw] = await Promise.all([
          fs.readFile(origPath, "utf8").catch(() => "[]"),
          fs.readFile(donePath, "utf8").catch(() => "[]"),
        ]);
        const origArr = JSON.parse(origRaw);
        const doneArr = JSON.parse(doneRaw);
        if (!Array.isArray(doneArr)) continue;
        files++;
        const origByName = new Map();
        if (Array.isArray(origArr)) for (const e of origArr) if (e?.objectName) origByName.set(e.objectName, e);
        for (const e of doneArr) {
          const arr = Array.isArray(e?.m_aString) ? e.m_aString : [];
          const origArrStr = origByName.get(e?.objectName)?.m_aString ?? [];
          total += arr.length;
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i], ov = origArrStr[i] ?? "";
            if (typeof v === "string" && v !== ov && v.trim() !== "") translated++;
          }
        }
      } catch {}
    }
    return { ok: true, files, total, translated, percent: total > 0 ? (translated / total) * 100 : 0, hasData: names.length > 0 };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// ── TXT round-trip: експорт m_aString у .txt + імпорт назад ──────
// Формат блоку:
//   ### N — <objectName>[strIdx] — <fileName>
//   <text>
//   <blank line>
// На відміну від JSON-структури, у .txt йде ОДИН рядок m_aString за блок
// (flatten), щоб людина-перекладач легко обробляла. Імпорт мапить назад
// за ключем "<objectName>[strIdx]".

function d4EscapeForTxt(s) {
  if (!s) return "";
  let leading = 0;
  while (s.startsWith("\n")) { leading++; s = s.slice(1); }
  let trailing = 0;
  while (s.endsWith("\n")) { trailing++; s = s.slice(0, -1); }
  return "\\n".repeat(leading) + s + "\\n".repeat(trailing);
}
function d4UnescapeFromTxt(s) {
  if (!s) return "";
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
          .replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

function d4BuildTxt(donePayload, fileNameHint) {
  const arr = Array.isArray(donePayload) ? donePayload : [];
  const lines = [];
  lines.push(`# D4 Text Export — ${fileNameHint}`);
  lines.push(`# Формат: «### N — <objectName>[strIdx] — <fileName>». Між блоками — порожній рядок.`);
  lines.push("");
  let idx = 0;
  for (const e of arr) {
    const arrStr = Array.isArray(e?.m_aString) ? e.m_aString : [];
    for (let i = 0; i < arrStr.length; i++) {
      idx++;
      const key = `${e.objectName}[${i}]`;
      const head = `### ${idx} — ${key}` + (e.fileName ? ` — ${e.fileName}` : "");
      lines.push(head);
      lines.push(d4EscapeForTxt(String(arrStr[i] ?? "")));
      lines.push("");
    }
  }
  return lines.join("\r\n");
}

function d4ParseTxt(text) {
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = norm.split("\n");
  const BLOCK_RE = /^\s*###\s*(\d+)\s*[—–-]\s*([^\s—–-]+)\[(\d+)\](?:\s*[—–-]\s*(.+?))?\s*$/;
  const blocks = [];
  let cur = null;
  for (const ln of rows) {
    const m = ln.match(BLOCK_RE);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { idx: parseInt(m[1], 10), objectName: m[2], strIdx: parseInt(m[3], 10),
              fileName: m[4] ?? null, lines: [] };
    } else if (cur) {
      cur.lines.push(ln);
    }
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) {
    while (b.lines.length && b.lines[b.lines.length - 1].trim() === "") b.lines.pop();
    while (b.lines.length && b.lines[0].trim() === "") b.lines.shift();
    b.text = d4UnescapeFromTxt(b.lines.join("\n"));
    delete b.lines;
  }
  return blocks;
}

ipcMain.handle("dp2:d4-text-export-txt", async (_e, payload) => {
  const donePath = String((payload && payload.donePath) || "").trim();
  const outPath  = String((payload && payload.outPath)  || "").trim();
  if (!donePath) return { ok: false, error: "donePath missing" };
  try {
    const raw = await fs.readFile(donePath, "utf8");
    const data = JSON.parse(raw);
    // Якщо renderer передав outPath (через pickSaveFile) — пишемо туди.
    // Інакше — поруч з .json.
    const txtPath = outPath || donePath.replace(/\.json$/i, ".txt");
    const safe = assertSafeWritePath(txtPath);
    const baseName = path.basename(donePath, path.extname(donePath));
    const content = d4BuildTxt(data, baseName);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, content, "utf8");
    const st = await fs.stat(safe);
    return { ok: true, txtPath: safe, bytes: st.size };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:d4-text-import-txt", async (_e, payload) => {
  const donePath = String((payload && payload.donePath) || "").trim();
  const txtPath  = String((payload && payload.txtPath)  || "").trim();
  if (!donePath || !txtPath) return { ok: false, error: "donePath/txtPath missing" };
  try {
    const [doneRaw, txtRaw] = await Promise.all([
      fs.readFile(donePath, "utf8"),
      fs.readFile(txtPath, "utf8"),
    ]);
    const arr = JSON.parse(doneRaw);
    if (!Array.isArray(arr)) return { ok: false, error: "Done JSON не масив" };
    const blocks = d4ParseTxt(txtRaw);
    const byName = new Map();
    for (const e of arr) if (e?.objectName) byName.set(e.objectName, e);
    let applied = 0, skipped = 0, missing = 0;
    for (const b of blocks) {
      const entry = byName.get(b.objectName);
      if (!entry || !Array.isArray(entry.m_aString)) { missing++; continue; }
      if (b.strIdx >= entry.m_aString.length) { missing++; continue; }
      if (entry.m_aString[b.strIdx] === b.text) { skipped++; continue; }
      entry.m_aString[b.strIdx] = b.text;
      applied++;
    }
    if (applied > 0) {
      const safe = assertSafeWritePath(donePath);
      const bakPath = safe + ".bak";
      try { await fs.access(bakPath); } catch { try { await fs.copyFile(safe, bakPath); } catch {} }
      await fs.writeFile(safe, JSON.stringify(arr, null, 2), "utf8");
    }
    return { ok: true, applied, skipped, missing, blocks: blocks.length };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});

ipcMain.handle("dp2:d4-text-pack", async () => {
  const settings = await readSettings();
  const d4Root = settings.d4Root;
  if (!d4Root) return { ok: false, error: "d4Root не задано" };
  const cooked = await d4ResolveCooked(d4Root);
  if (!cooked.ok) return { ok: false, error: cooked.error };
  const tools = await d4ResolveTools();
  if (!tools.uelibDll) return { ok: false, error: "UELib.dll не знайдено" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const { doneDir, decompressedDir } = await d4TextDirs();
  const importScript = resolveResource("scripts/d4-text-import.ps1");
  const win = BrowserWindow.getAllWindows()[0];
  function emit(line) {
    try { win?.webContents.send("dp2:d4-text-pack-progress", line); } catch {}
  }
  const results = [];
  for (const src of cooked.files) {
    const baseName = src.name.replace(/\.upk$/i, "");
    const jsonDone = path.join(doneDir, baseName + ".json");
    const decompressedPath = path.join(decompressedDir, src.name);
    try { await fs.access(jsonDone); }
    catch { emit(`[SKIP] ${src.name}: no Done/${baseName}.json`); continue; }
    try { await fs.access(decompressedPath); }
    catch { emit(`[SKIP] ${src.name}: no decompressed source (run Extract first)`); continue; }
    const outUpk = src.fullPath; // напряму у грі
    // Backup ВИХІДНОГО .upk у грі (одноразово).
    const bakPath = outUpk + ".bak";
    try { await fs.access(bakPath); }
    catch { try { await fs.copyFile(outUpk, bakPath); emit(`[BAK] ${src.name}.bak`); } catch (e) { emit(`[WARN] bak: ${e.message}`); } }
    emit(`[STEP] pack ${src.name}…`);
    const res = await new Promise((resolve) => {
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", importScript,
        "-SrcUpk", decompressedPath,
        "-JsonPath", jsonDone,
        "-OutUpk", outUpk,
        "-UelibDll", tools.uelibDll,
      ];
      const child = spawn(pwshLookup, args, { windowsHide: true });
      let leftover = "", all = "";
      const onData = (chunk) => {
        all += chunk;
        leftover += chunk;
        const lines = leftover.split(/\r?\n/);
        leftover = lines.pop() || "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          emit(`  ${ln}`);
        }
      };
      child.stdout.on("data", (d) => onData(d.toString()));
      child.stderr.on("data", (d) => onData(d.toString()));
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("exit", (code) => {
        if (code !== 0) {
          const tail = all.split("\n").slice(-15).join("\n").trim();
          resolve({ ok: false, error: tail || `exit ${code}` });
          return;
        }
        resolve({ ok: true });
      });
    });
    results.push({ name: src.name, ...res });
    if (!res.ok) emit(`[ERR] ${src.name}: ${res.error}`);
  }
  const ok = results.every((r) => r.ok);
  return { ok, results };
});

// ── D4 Fonts: розпакування, TTF mapping, preview ─────────────────
// Pipeline:
//   1. Розпакувати Ms01Utility_LOC_INT.upk (LZO) — лежить у Text/Decompressed
//      (спільна тека з текстом — той самий decompress.exe).
//   2. d4-fonts-extract.ps1 — UFont meta + Texture2D атласи у Fonts/Meta + Atlases/.
//   3. d4-fonts-preview.py — BC3/G8 декод у Fonts/Previews/<name>.png.
//   4. UI: TTF picker → ttf-mapping.json.
//   5. (Phase 2) make_paired_fonts.py / make_single_font.py + repack_*.py.

async function d4FontsDirs() {
  const settings = await readSettings();
  let toolsDir = settings.toolsDir;
  if (!toolsDir) toolsDir = path.join(app.getPath("documents"), "SWERY-Localization-Tool");
  const baseDir = path.join(toolsDir, "D4", "Fonts");
  return {
    baseDir,
    metaDir:     path.join(baseDir, "Meta"),
    atlasDir:    path.join(baseDir, "Atlases"),
    previewDir:  path.join(baseDir, "Previews"),
    generatedDir: path.join(baseDir, "Generated"),
    mappingFile: path.join(baseDir, "ttf-mapping.json"),
  };
}

// Дефолтний mapping (з recon: My.ttf для newcinema/talkfont, Consolas-Regular/Bold
// для consola/_b). Інші — порожньо, користувач сам обирає.
function d4DefaultTtfMapping() {
  return {
    "newcinema":    { ttfPath: "F:\\My.ttf", source: "recon" },
    "newcinema_s":  { ttfPath: "F:\\My.ttf", source: "recon" },
    "talkfont":     { ttfPath: "F:\\My.ttf", source: "recon" },
    "shadowfont":   { ttfPath: "F:\\My.ttf", source: "recon" },
    "consola":      { ttfPath: "F:\\Consolas-Regular.ttf", source: "recon" },
    "consola_b":    { ttfPath: "F:\\Consolas-Bold.ttf",    source: "recon" },
  };
}

async function d4ReadMapping() {
  const { mappingFile } = await d4FontsDirs();
  try {
    const raw = await fs.readFile(mappingFile, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch {}
  return {};
}

async function d4WriteMapping(map) {
  const { baseDir, mappingFile } = await d4FontsDirs();
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(mappingFile, JSON.stringify(map, null, 2), "utf8");
}

// Шлях до uncompressed Ms01Utility (його робить text-extract pipeline).
async function d4UtilityUncompressed() {
  const { decompressedDir } = await d4TextDirs();
  const p = path.join(decompressedDir, "Ms01Utility_LOC_INT.upk");
  try { await fs.access(p); return p; } catch { return null; }
}

ipcMain.handle("dp2:d4-fonts-status", async () => {
  const settings = await readSettings();
  const d4Root = settings.d4Root || null;
  const dirs = await d4FontsDirs();
  const tools = await d4ResolveTools();
  const utilityUncompressed = await d4UtilityUncompressed();
  // Скан Meta/ + Previews/.
  let metaFiles = [], previewFiles = [];
  try { metaFiles = (await fs.readdir(dirs.metaDir)).filter((n) => n.endsWith(".json")); } catch {}
  try { previewFiles = (await fs.readdir(dirs.previewDir)).filter((n) => n.endsWith(".png")); } catch {}
  const stored = await d4ReadMapping();
  const defaults = d4DefaultTtfMapping();
  // Об'єднуємо: stored перекриває defaults.
  const mapping = { ...defaults, ...stored };
  return {
    ok: true,
    d4Root,
    utilityCooked: d4Root ? path.join(d4Root, "Ms01Game", "CookedPCConsole", "Ms01Utility_LOC_INT.upk") : null,
    utilityUncompressed,
    dirs,
    extracted: metaFiles.length > 0,
    extractedCount: metaFiles.length,
    previewCount: previewFiles.length,
    mapping,
    tools: {
      decompressExe: tools.decompressExe,
      uelibDll: tools.uelibDll,
      ready: !!tools.decompressExe && !!tools.uelibDll,
    },
  };
});

ipcMain.handle("dp2:d4-fonts-extract", async () => {
  const settings = await readSettings();
  const d4Root = settings.d4Root;
  if (!d4Root) return { ok: false, error: "d4Root не задано" };
  const tools = await d4ResolveTools();
  if (!tools.uelibDll) return { ok: false, error: "Eliot.UELib.dll не знайдено" };
  if (!tools.decompressExe) return { ok: false, error: "decompress.exe не знайдено" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const utilityCooked = path.join(d4Root, "Ms01Game", "CookedPCConsole", "Ms01Utility_LOC_INT.upk");
  try { await fs.access(utilityCooked); }
  catch { return { ok: false, error: "Ms01Utility_LOC_INT.upk не знайдено у грі" }; }
  const { decompressedDir } = await d4TextDirs();
  await fs.mkdir(decompressedDir, { recursive: true });
  const dirs = await d4FontsDirs();
  for (const d of [dirs.baseDir, dirs.metaDir, dirs.atlasDir, dirs.previewDir]) {
    await fs.mkdir(d, { recursive: true });
  }
  const win = BrowserWindow.getAllWindows()[0];
  function emit(line) {
    try { win?.webContents.send("dp2:d4-fonts-progress", line); } catch {}
  }
  // 1. Decompress (якщо ще нема).
  const utilityUncompressed = path.join(decompressedDir, "Ms01Utility_LOC_INT.upk");
  let needDec = true;
  try { const st = await fs.stat(utilityUncompressed); if (st.size > 0) needDec = false; } catch {}
  if (needDec) {
    emit("[STEP] decompress Ms01Utility_LOC_INT.upk");
    const dec = await new Promise((resolve) => {
      const args = [`-out=${decompressedDir}`, utilityCooked];
      const child = spawn(tools.decompressExe, args, { windowsHide: true });
      let all = "";
      child.stdout.on("data", (d) => { all += d.toString(); });
      child.stderr.on("data", (d) => { all += d.toString(); });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("exit", async () => {
        try { const st = await fs.stat(utilityUncompressed); if (st.size > 0) return resolve({ ok: true }); } catch {}
        resolve({ ok: false, error: "decompress: no output" });
      });
    });
    if (!dec.ok) { emit("[ERR] decompress: " + dec.error); return { ok: false, error: dec.error }; }
  } else {
    emit("[SKIP] decompress (cached)");
  }
  // 2. Extract metadata (PowerShell).
  emit("[STEP] dump UFont metadata + atlases…");
  const extractScript = resolveResource("scripts/d4-fonts-extract.ps1");
  const dumpUfont = resolveResource("scripts/d4-tools/dump-ufont.ps1");
  const dumpTex = resolveResource("scripts/d4-tools/dump-texture2d.ps1");
  const exp = await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", extractScript,
      "-SrcUpk", utilityUncompressed,
      "-OutDir", dirs.baseDir,
      "-UelibDll", tools.uelibDll,
      "-DumpUfontScript", dumpUfont,
      "-DumpTextureScript", dumpTex,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let leftover = "", all = "";
    const onData = (chunk) => {
      all += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        emit("  " + ln);
      }
    };
    child.stdout.on("data", (d) => onData(d.toString()));
    child.stderr.on("data", (d) => onData(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = all.split("\n").slice(-15).join("\n").trim();
        resolve({ ok: false, error: tail || `exit ${code}` });
        return;
      }
      let summary = null;
      const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary });
    });
  });
  if (!exp.ok) { emit("[ERR] extract: " + exp.error); return { ok: false, error: exp.error }; }
  // 3. Preview PNG (Python).
  emit("[STEP] decode atlases → PNG previews…");
  const previewScript = resolveResource("scripts/d4-fonts-preview.py");
  const pythonExe = await new Promise((resolve) => {
    const w = spawn("where.exe", ["python.exe"], { windowsHide: true });
    let out = "";
    w.stdout.on("data", (d) => { out += d.toString(); });
    w.on("error", () => resolve(null));
    w.on("exit", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s);
        resolve(first || null);
      } else resolve(null);
    });
  });
  if (!pythonExe) {
    emit("[WARN] python.exe не знайдено — preview PNG не генерую (metadata вже готова)");
    return { ok: true, warning: "python not found; metadata extracted; preview skipped" };
  }
  const prev = await new Promise((resolve) => {
    const args = [previewScript, dirs.metaDir, dirs.atlasDir, dirs.previewDir];
    const child = spawn(pythonExe, args, { windowsHide: true });
    let leftover = "", all = "";
    const onData = (chunk) => {
      all += chunk;
      leftover += chunk;
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() || "";
      for (const ln of lines) {
        if (!ln.trim()) continue;
        emit("  " + ln);
      }
    };
    child.stdout.on("data", (d) => onData(d.toString()));
    child.stderr.on("data", (d) => onData(d.toString()));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = all.split("\n").slice(-10).join("\n").trim();
        resolve({ ok: false, error: tail || `python exit ${code}` });
        return;
      }
      let summary = null;
      const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary });
    });
  });
  if (!prev.ok) emit("[WARN] preview: " + prev.error);
  emit("[DONE] fonts extract complete");
  return { ok: true, metadata: exp.summary, previews: prev.summary };
});

// Конфігурація для генерації UA-шрифтів. Кожен шрифт — paired (main+shadow
// разом) або single. Дефолти fontSize визначаються емпірично за оригіналом
// (з recon). Для шрифтів без mapping — генерація пропускається.
// format: "BC3" (DXT5) або "G8" (PF_G8 — raw grayscale). За замовч. BC3.
// PF_G8 потрібен для: times_new_roman, observefont_eng, menufont, menufont_r
// (recon встановив що ці шрифти в грі — uncompressed grayscale).
// Розміри атласів — підкориговані за реальними значеннями orig (логи pack
// показали справжні Texture2D dimensions). 508×512 для talkfont — нестандарт,
// але саме такий розмір у грі. Pages count = кількість Texture2D refs у UFont.
const D4_GENERATE_CONFIG = {
  newcinema:   { type: "paired", shadow: "newcinema_s", size: 36, pageW: 512, pageH: 512, pages: 4 },
  talkfont:    { type: "paired", shadow: "shadowfont", size: 22, pageW: 508, pageH: 512, pages: 1 },
  dive:        { type: "paired", shadow: "dive_s", size: 16, pageW: 512, pageH: 512, pages: 3 },
  dive_en:     { type: "paired", shadow: "dive_en_s", size: 16, pageW: 512, pageH: 512, pages: 2 },
  observe_eng: { type: "paired", shadow: "observe_eng_s", size: 18, pageW: 512, pageH: 512, pages: 1 },
  observefont: { type: "paired", shadow: "observefont_s", size: 20, pageW: 512, pageH: 512, pages: 2 },
  menufont:    { type: "paired", shadow: "menufont_r", size: 22, pageW: 1024, pageH: 1024, pages: 1, format: "G8" },
  customfont:  { type: "paired", shadow: "customfont_s", size: 18, pageW: 512, pageH: 512, pages: 2 },
  consola:     { type: "single", size: 14, pageW: 512, pageH: 512 },
  consola_b:   { type: "single", size: 14, pageW: 512, pageH: 512 },
  observefont_eng: { type: "single", size: 18, pageW: 1024, pageH: 1024, format: "G8" },
  ms_mincho:        { type: "single", size: 16, pageW: 512, pageH: 512 },
  times_new_roman:  { type: "single", size: 14, pageW: 256, pageH: 256, format: "G8" },
  times_new_roman_storytitle: { type: "single", size: 20, pageW: 512, pageH: 512 },
};

// Знаходить python (системний або з PATH). Якщо нема — повертає null.
async function findPython() {
  return await new Promise((resolve) => {
    const w = spawn("where.exe", ["python.exe"], { windowsHide: true });
    let out = "";
    w.stdout.on("data", (d) => { out += d.toString(); });
    w.on("error", () => resolve(null));
    w.on("exit", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s);
        resolve(first || null);
      } else resolve(null);
    });
  });
}

ipcMain.handle("dp2:d4-fonts-generate", async () => {
  const pythonExe = await findPython();
  if (!pythonExe) return { ok: false, error: "Python не знайдено у PATH" };
  // Merge stored mapping з дефолтами (recon: My.ttf для newcinema/talkfont, Consolas для consola/_b).
  const stored = await d4ReadMapping();
  const mapping = { ...d4DefaultTtfMapping(), ...stored };
  const dirs = await d4FontsDirs();
  await fs.mkdir(dirs.generatedDir, { recursive: true });
  // ADDITIVE mode: зберігаємо orig latin/іконки/кнопки, домальовуємо лише
  // кириличні літери у вільні зони на atlas. Це критично для UI гри —
  // спецсимволи (стрілки, кнопки контролера, тощо) лишаються.
  const additiveScript = resolveResource("scripts/d4-fonts-additive.py");
  const win = BrowserWindow.getAllWindows()[0];
  function emit(line) {
    try { win?.webContents.send("dp2:d4-fonts-progress", line); } catch {}
  }
  // Збираємо список задач — для кожного шрифту з TTF mapping.
  const tasks = [];
  for (const [name, cfg] of Object.entries(D4_GENERATE_CONFIG)) {
    const ttf = mapping[name]?.ttfPath;
    if (!ttf) continue;
    tasks.push({ name, cfg, ttf });
  }
  if (tasks.length === 0) return { ok: false, error: "Жоден шрифт не має TTF mapping" };
  emit(`[INFO] Additive generation queue: ${tasks.length} fonts`);
  const results = [];
  for (const task of tasks) {
    const { name, cfg, ttf } = task;
    emit(`[STEP] ${name}`);
    try { await fs.access(ttf); }
    catch { emit(`[ERR] ${name}: TTF не знайдено: ${ttf}`); results.push({ name, ok: false, error: "ttf not found" }); continue; }
    // Перевіряємо що orig meta + atlases доступні.
    const origMeta = path.join(dirs.metaDir, `${name}.json`);
    try { await fs.access(origMeta); }
    catch { emit(`[ERR] ${name}: orig meta missing — спочатку Розпакувати`); results.push({ name, ok: false, error: "no orig meta" }); continue; }
    const origAtlasDir = path.join(dirs.atlasDir, name);
    const outDir = path.join(dirs.generatedDir, name);
    await fs.mkdir(outDir, { recursive: true });
    // Будуємо config для additive скрипта.
    const cfgObj = {
      name,
      type: cfg.type,
      shadow: cfg.shadow || null,
      ttf,
      fontSize: cfg.size,
      format: cfg.format || "BC3",
      origMetaJson: origMeta,
      origAtlasDir,
      outDir,
    };
    if (cfg.type === "paired") {
      cfgObj.origShadowMetaJson = path.join(dirs.metaDir, `${cfg.shadow}.json`);
      cfgObj.origShadowAtlasDir = path.join(dirs.atlasDir, cfg.shadow);
      try { await fs.access(cfgObj.origShadowMetaJson); }
      catch { emit(`[ERR] ${name}: shadow meta missing`); results.push({ name, ok: false, error: "no shadow meta" }); continue; }
    }
    const cfgPath = path.join(outDir, "additive-config.json");
    await fs.writeFile(cfgPath, JSON.stringify(cfgObj, null, 2), "utf8");
    const r = await new Promise((resolve) => {
      const child = spawn(pythonExe, [additiveScript, cfgPath], { windowsHide: true });
      let all = "";
      child.stdout.on("data", (d) => {
        const s = d.toString(); all += s;
        for (const ln of s.split(/\r?\n/)) if (ln.trim()) emit("  " + ln);
      });
      child.stderr.on("data", (d) => {
        const s = d.toString(); all += s;
        for (const ln of s.split(/\r?\n/)) if (ln.trim()) emit("  " + ln);
      });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("exit", (code) => {
        if (code !== 0) {
          const tail = all.split("\n").slice(-12).join(" ").trim();
          resolve({ ok: false, error: tail || `exit ${code}` });
          return;
        }
        resolve({ ok: true });
      });
    });
    if (!r.ok) emit(`[ERR] ${name}: ${r.error}`);
    else emit(`[DONE] ${name}`);
    results.push({ name, ...r, outDir });
  }
  const ok = results.every((r) => r.ok);
  emit(`[DONE] Generation finished: ${results.filter((r) => r.ok).length} / ${results.length}`);
  return { ok, results };
});

// Pack згенерованих UA-шрифтів у Ms01Utility_LOC_INT.upk + копія у гру.
// Pipeline:
//   1. probe-exports.ps1 — дамп export-таблиці + names у JSON (якщо ще нема)
//   2. Будуємо pack-config.json з усіх шрифтів, що мають Generated/<name>/atlas|main_page0
//   3. d4-fonts-pack.py — заміна Texture2D mip0 + UFont body, output uncompressed .upk
//   4. Копія результату у гру: <d4Root>/Ms01Game/CookedPCConsole/Ms01Utility_LOC_INT.upk (з .bak)
ipcMain.handle("dp2:d4-fonts-pack", async () => {
  const settings = await readSettings();
  const d4Root = settings.d4Root;
  if (!d4Root) return { ok: false, error: "d4Root не задано" };
  const tools = await d4ResolveTools();
  if (!tools.uelibDll) return { ok: false, error: "Eliot.UELib.dll не знайдено" };
  const pwshLookup = await findPwsh(settings);
  if (!pwshLookup) return { ok: false, error: "PowerShell 7 не знайдено" };
  const pythonExe = await findPython();
  if (!pythonExe) return { ok: false, error: "Python не знайдено у PATH" };
  const utilityUncompressed = await d4UtilityUncompressed();
  if (!utilityUncompressed) return { ok: false, error: "Uncompressed Ms01Utility немає — спочатку Розпакувати" };
  const dirs = await d4FontsDirs();
  await fs.mkdir(dirs.generatedDir, { recursive: true });
  const toolsDir = dirs.baseDir;
  const win = BrowserWindow.getAllWindows()[0];
  function emit(line) {
    try { win?.webContents.send("dp2:d4-fonts-progress", line); } catch {}
  }
  // 1. probe-exports → exports.json у Tools/
  const exportsJson = path.join(toolsDir, "exports.json");
  emit("[STEP] probe exports (UELib dump)…");
  const probeScript = resolveResource("scripts/d4-tools/probe-exports.ps1");
  const probe = await new Promise((resolve) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", probeScript,
      "-SrcUpk", utilityUncompressed,
      "-OutJson", exportsJson,
      "-UelibDll", tools.uelibDll,
    ];
    const child = spawn(pwshLookup, args, { windowsHide: true });
    let all = "";
    child.stdout.on("data", (d) => { all += d.toString(); });
    child.stderr.on("data", (d) => { all += d.toString(); });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = all.split("\n").slice(-10).join("\n").trim();
        resolve({ ok: false, error: tail || `probe exit ${code}` });
      } else resolve({ ok: true });
    });
  });
  if (!probe.ok) { emit(`[ERR] probe: ${probe.error}`); return { ok: false, error: probe.error }; }

  // 2. Будуємо config: лише шрифти у яких є Generated meta.json.
  const stored = await d4ReadMapping();
  const mapping = { ...d4DefaultTtfMapping(), ...stored };
  const fonts = [];
  for (const [name, cfg] of Object.entries(D4_GENERATE_CONFIG)) {
    if (!mapping[name]?.ttfPath) continue;
    const genDir = path.join(dirs.generatedDir, name);
    try { await fs.access(path.join(genDir, "meta.json")); } catch { continue; }
    const origMeta = path.join(dirs.metaDir, `${name}.json`);
    try { await fs.access(origMeta); } catch { emit(`[SKIP] ${name}: no original meta`); continue; }
    if (cfg.type === "paired") {
      const origShadow = path.join(dirs.metaDir, `${cfg.shadow}.json`);
      try { await fs.access(origShadow); } catch { emit(`[SKIP] ${name}: no shadow meta`); continue; }
      fonts.push({
        name, type: "paired", shadow: cfg.shadow,
        originalMetaJson: origMeta,
        originalShadowMetaJson: origShadow,
        generatedDir: genDir,
      });
    } else {
      fonts.push({
        name, type: "single",
        originalMetaJson: origMeta,
        generatedDir: genDir,
      });
    }
  }
  if (fonts.length === 0) return { ok: false, error: "Жоден шрифт ще не згенеровано (натисни «Згенерувати UA»)" };
  // 3. Запускаємо pack.
  const outUpk = path.join(toolsDir, "Ms01Utility_LOC_INT.packed.upk");
  const configJson = path.join(toolsDir, "pack-config.json");
  await fs.writeFile(configJson, JSON.stringify({
    srcUpk: utilityUncompressed,
    outUpk,
    exportsJson,
    fonts,
  }, null, 2), "utf8");
  emit(`[STEP] pack ${fonts.length} fonts…`);
  const packScript = resolveResource("scripts/d4-fonts-pack.py");
  const pack = await new Promise((resolve) => {
    const child = spawn(pythonExe, [packScript, configJson], { windowsHide: true });
    let all = "";
    const onData = (chunk) => {
      const s = chunk.toString();
      all += s;
      for (const ln of s.split(/\r?\n/)) if (ln.trim()) emit("  " + ln);
    };
    child.stdout.on("data", (d) => onData(d));
    child.stderr.on("data", (d) => onData(d));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = all.split("\n").slice(-15).join("\n").trim();
        resolve({ ok: false, error: tail || `pack exit ${code}` });
        return;
      }
      let summary = null;
      const m = all.match(/RESULT_JSON:\s*(.+)$/m);
      if (m) { try { summary = JSON.parse(m[1]); } catch {} }
      resolve({ ok: true, summary });
    });
  });
  if (!pack.ok) { emit(`[ERR] pack: ${pack.error}`); return { ok: false, error: pack.error }; }
  // 4. Копія у гру з .bak.
  const gameUpk = path.join(d4Root, "Ms01Game", "CookedPCConsole", "Ms01Utility_LOC_INT.upk");
  const bakPath = gameUpk + ".bak";
  try { await fs.access(bakPath); }
  catch { try { await fs.copyFile(gameUpk, bakPath); emit(`[BAK] ${path.basename(bakPath)}`); } catch (e) { emit(`[WARN] bak: ${e.message}`); } }
  try {
    await fs.copyFile(outUpk, gameUpk);
    emit(`[DONE] copied to game: ${path.basename(gameUpk)}`);
  } catch (e) {
    return { ok: false, error: "copy to game failed: " + e.message };
  }
  return { ok: true, outUpk, gameUpk, fonts: pack.summary?.results ?? [] };
});

ipcMain.handle("dp2:d4-fonts-pick-ttf", async (_e, payload) => {
  const fontName = String((payload && payload.fontName) || "").trim();
  if (!fontName) return { ok: false, error: "fontName missing" };
  const picked = await dialog.showOpenDialog({
    title: `TTF для ${fontName}`,
    properties: ["openFile"],
    filters: [{ name: "TrueType / OpenType", extensions: ["ttf", "otf"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: "canceled" };
  const ttfPath = picked.filePaths[0];
  const map = await d4ReadMapping();
  map[fontName] = { ttfPath, source: "user" };
  await d4WriteMapping(map);
  return { ok: true, fontName, ttfPath };
});

ipcMain.handle("dp2:d4-fonts-clear-ttf", async (_e, fontName) => {
  const name = String(fontName || "").trim();
  if (!name) return { ok: false, error: "fontName missing" };
  const map = await d4ReadMapping();
  delete map[name];
  await d4WriteMapping(map);
  return { ok: true };
});

ipcMain.handle("dp2:d4-fonts-read-preview", async (_e, fontName) => {
  const name = String(fontName || "").trim();
  if (!name) return { ok: false, error: "fontName missing" };
  const { previewDir } = await d4FontsDirs();
  const p = path.join(previewDir, `${name}.png`);
  try {
    const buf = await fs.readFile(p);
    return { ok: true, base64: buf.toString("base64") };
  } catch { return { ok: false, error: "preview not found" }; }
});

// Згенерований preview — читає PNG з Generated/<name>/. Може бути:
//  - single: atlas.png
//  - paired main: main_page0.png (перша сторінка main атласу)
//  - paired shadow: shadow_page0.png
ipcMain.handle("dp2:d4-fonts-read-generated", async (_e, fontName) => {
  const name = String(fontName || "").trim();
  if (!name) return { ok: false, error: "fontName missing" };
  const { generatedDir } = await d4FontsDirs();
  // Визначаємо чи shadow-варіант.
  const cfgShadow = Object.entries(D4_GENERATE_CONFIG).find(([_n, c]) => c.shadow === name);
  let pngPath;
  if (cfgShadow) {
    // shadow_page0.png у теці main-шрифту.
    pngPath = path.join(generatedDir, cfgShadow[0], "shadow_page0.png");
  } else {
    const cfg = D4_GENERATE_CONFIG[name];
    if (!cfg) {
      // невідомий шрифт — пробуємо обидва варіанти
      const cand = [
        path.join(generatedDir, name, "atlas.png"),
        path.join(generatedDir, name, "main_page0.png"),
      ];
      for (const c of cand) { try { await fs.access(c); pngPath = c; break; } catch {} }
    } else if (cfg.type === "single") {
      pngPath = path.join(generatedDir, name, "atlas.png");
    } else {
      pngPath = path.join(generatedDir, name, "main_page0.png");
    }
  }
  if (!pngPath) return { ok: false, error: "generated not found" };
  try {
    const buf = await fs.readFile(pngPath);
    return { ok: true, base64: buf.toString("base64") };
  } catch { return { ok: false, error: "generated not found" }; }
});

ipcMain.handle("dp2:steam-find-game", async (_event, folderName) => {
  if (typeof folderName !== "string" || !folderName.trim()) {
    return { ok: false, error: "folderName required" };
  }
  return await findSteamGame(folderName.trim());
});

// 5 останніх релізів GitHub для секції "Що нового" на Home. Той самий cache
// підхід що у check-update (settings.lastReleasesCache + TTL 6h).
const RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
ipcMain.handle("dp2:fetch-releases", async (_event, payload) => {
  const force = !!(payload && payload.force);
  const settings = await readSettings();
  const now = Date.now();
  if (!force && settings.lastReleasesCache && settings.lastReleasesCheck &&
      (now - settings.lastReleasesCheck) < RELEASES_TTL_MS) {
    return settings.lastReleasesCache;
  }
  const https = require("node:https");
  try {
    const data = await new Promise((resolve, reject) => {
      https.request({
        hostname: "api.github.com",
        path: `/repos/${UPDATE_REPO}/releases?per_page=5`,
        method: "GET",
        headers: {
          "User-Agent": `SWERY-Localization-Tool/${app.getVersion()}`,
          "Accept": "application/vnd.github+json",
        },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        let raw = ""; res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }).on("error", reject).end();
    });
    const items = (Array.isArray(data) ? data : []).slice(0, 5).map((r) => ({
      tag: String(r.tag_name || "").replace(/^v/i, ""),
      name: r.name || r.tag_name || "",
      htmlUrl: r.html_url,
      publishedAt: r.published_at,
      prerelease: !!r.prerelease,
    })).filter((r) => r.tag);
    const result = { ok: true, items };
    await writeSettings({ ...settings, lastReleasesCheck: now, lastReleasesCache: result });
    return result;
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle("dp2:dismiss-update-version", async (_event, version) => {
  const settings = await readSettings();
  await writeSettings({ ...settings, dismissedUpdateVersion: String(version || "") });
  return { ok: true };
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
