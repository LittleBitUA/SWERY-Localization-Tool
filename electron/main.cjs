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
    },
  });

  win.once("ready-to-show", () => win.show());
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

// ── IPC: list JSON files ─────────────────────────────────────────
ipcMain.handle("dp2:list-files", async (_event, folder) => {
  if (!folder) return [];
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
    .filter((e) => !e.name.endsWith(".bak.json"))
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
      !e.name.endsWith(".bak.json")
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
      !e.name.endsWith(".bak.json")
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

// Heavy-worker задачі: всю важку роботу робить worker_threads — main залишається responsive.
ipcMain.handle("dp2:scan-all", async (_event, folder) => callHeavy("scan-all", folder));
ipcMain.handle("dp2:build-tm-worker", async (_event, payload) => callHeavy("build-tm", payload));
ipcMain.handle("dp2:search-all-worker", async (_event, payload) => callHeavy("search-all", payload));

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

  sendSetupProgress({ phase: "check", message: "Перевірка..." });

  try {
    await fs.mkdir(toolsDir, { recursive: true });
  } catch (e) {
    const msg = "Не вдалося створити tools-теку: " + (e.message || e);
    sendSetupProgress({ phase: "error", message: msg });
    return { error: msg };
  }

  let uabeaPath = payload.uabeaPath || null;
  let pwshPath = payload.pwshPath || null;

  // ----- UABEA Next -----
  if (payload.downloadUabea) {
    try {
      sendSetupProgress({ phase: "fetch", tool: "uabea", message: "Шукаю останній реліз UABEA Next..." });
      const rel = await setupTools.fetchLatestRelease("nesrak1", "UABEA");
      const asset = setupTools.pickAsset(
        rel.assets,
        (a) => /\.zip$/i.test(a.name) && /(uabea|win|windows)/i.test(a.name)
      ) || rel.assets.find((a) => /\.zip$/i.test(a.name));
      if (!asset) throw new Error("У релізі " + rel.tag + " немає .zip");

      const destZip = path.join(toolsDir, asset.name);
      sendSetupProgress({
        phase: "download", tool: "uabea",
        message: `Завантажую ${asset.name} (${rel.tag})...`,
        total: asset.size, downloaded: 0, percent: 0,
      });
      const res = await setupTools.downloadFile(asset.url, destZip, (p) => {
        sendSetupProgress({
          phase: "download", tool: "uabea",
          message: `Завантажую ${asset.name}...`,
          total: p.total, downloaded: p.downloaded, percent: p.percent,
        });
      });

      const extractDir = path.join(toolsDir, "uabea");
      sendSetupProgress({ phase: "extract", tool: "uabea", message: "Розпакую UABEA..." });
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
      if (!exe) throw new Error("Не знайшов UABEA*.exe у " + extractDir);
      uabeaPath = exe;
      sendSetupProgress({ phase: "done", tool: "uabea", message: "UABEA готовий: " + exe });
    } catch (e) {
      const msg = "UABEA: " + (e.message || e);
      sendSetupProgress({ phase: "error", tool: "uabea", message: msg });
      return { error: msg };
    }
  }

  // ----- PowerShell 7 portable -----
  if (payload.downloadPwsh) {
    try {
      sendSetupProgress({ phase: "fetch", tool: "pwsh", message: "Шукаю останній реліз PowerShell 7..." });
      const rel = await setupTools.fetchLatestRelease("PowerShell", "PowerShell");
      // Шукаємо portable win-x64 .zip. Уникаємо MSI/preview/lts-only.
      const asset = setupTools.pickAsset(
        rel.assets,
        (a) =>
          /\.zip$/i.test(a.name) &&
          /win-x64/i.test(a.name) &&
          !/preview|lts/i.test(a.name)
      ) || setupTools.pickAsset(rel.assets, (a) => /\.zip$/i.test(a.name) && /win-x64/i.test(a.name));
      if (!asset) throw new Error("У релізі " + rel.tag + " немає win-x64 .zip");

      const destZip = path.join(toolsDir, asset.name);
      sendSetupProgress({
        phase: "download", tool: "pwsh",
        message: `Завантажую ${asset.name} (${rel.tag})...`,
        total: asset.size, downloaded: 0, percent: 0,
      });
      const res = await setupTools.downloadFile(asset.url, destZip, (p) => {
        sendSetupProgress({
          phase: "download", tool: "pwsh",
          message: `Завантажую ${asset.name}...`,
          total: p.total, downloaded: p.downloaded, percent: p.percent,
        });
      });

      const extractDir = path.join(toolsDir, "pwsh");
      sendSetupProgress({ phase: "extract", tool: "pwsh", message: "Розпакую PowerShell..." });
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
      if (!exe) throw new Error("Не знайшов pwsh.exe у " + extractDir);
      pwshPath = exe;
      sendSetupProgress({ phase: "done", tool: "pwsh", message: "PowerShell готовий: " + exe });
    } catch (e) {
      const msg = "PowerShell: " + (e.message || e);
      sendSetupProgress({ phase: "error", tool: "pwsh", message: msg });
      return { error: msg };
    }
  }

  // ----- Persist settings -----
  sendSetupProgress({ phase: "persist", message: "Зберігаю налаштування..." });
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

  sendSetupProgress({ phase: "done", message: "Готово!" });
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

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
