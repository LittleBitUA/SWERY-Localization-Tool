// One-shot: міграція HBR Original/Done/Meta зі старого bundle-hash на новий.
// Контекст: гра отримала патч → bundle перейменувався, але m_Name + PathID +
// _TextId стабільні. Цей скрипт переносить переклади з Done/ у новій структурі
// (на випадок, якщо у патчі додалися рядки), а Original/ заповнює свіжими
// англ. дампами з UABEA-екстракту.
//
// Запуск:
//   node scripts/hbr-migrate-bundle-hash.cjs <newDir> [newHash]
//
// newDir   — тека, куди користувач сам екстрактнув з нового bundle (e.g. E:\HB).
//            Файли там можуть мати будь-який суфікс — головне, щоб PathID
//            у назві (трейлінговий `-?\d+\.json`) збігався з твоїми.
// newHash  — нове ім'я bundle БЕЗ .bundle (e.g.
//            `_resources_assets_all_0d63e41486d027f2e31ca9d62cbfb661`).
//            Якщо не передано — береться з settings.json (hbrBundlePath).

const fs = require("fs");
const path = require("path");
const os = require("os");

const userDocs = path.join(os.homedir(), "Documents", "SWERY-Localization-Tool");
const baseDir = path.join(userDocs, "HBR", "Text");
const originalDir = path.join(baseDir, "Original");
const doneDir = path.join(baseDir, "Done");
const metaDir = path.join(baseDir, "Meta");
const metaPath = path.join(metaDir, "hbr-meta.json");

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  // Int64 — обгортка у string ДО parse (інакше Double truncate'ає >2^53).
  // Поля: m_PathID (PPtr), pathId/scriptPathId (meta), rid (managed-reference
  // RefId у _CommandInfos.Array[*]._Argument). Без обгортки rid стає до 17 цифр
  // → Unity бачить dangling-ref → краш на GC liveness scan.
  const safe = raw
    .replace(/"m_PathID"\s*:\s*(-?\d+)/g, '"m_PathID":"$1"')
    .replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"')
    .replace(/"rid"\s*:\s*(-?\d+)/g, '"rid":"$1"');
  return JSON.parse(safe);
}

function writeJsonInt64(p, obj) {
  // Зворотній шлях: серіалізуємо, а потім розгортаємо Int64-стрінги назад у
  // числа, щоб формат був бітово сумісний з UABEA-дампом.
  let raw = JSON.stringify(obj, null, 2);
  raw = raw.replace(/"m_PathID"\s*:\s*"(-?\d+)"/g, '"m_PathID": $1');
  raw = raw.replace(/"rid"\s*:\s*"(-?\d+)"/g, '"rid": $1');
  fs.writeFileSync(p, raw, "utf8");
}

function pidFromName(name) {
  const m = name.match(/-(-?\d+)\.json$/);
  return m ? m[1] : null;
}

function flatten(obj) {
  // m_Name → Map("textId|idx" → text)
  const m = new Map();
  const lst = obj?._List?.Array;
  if (!Array.isArray(lst)) return m;
  for (const row of lst) {
    const tid = row?._TextId ?? "";
    const arr = row?._Texts?.Array;
    if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j++) {
      m.set(`${tid}|${j}`, arr[j]?._Text ?? "");
    }
  }
  return m;
}

function mergeTranslations(newObj, oldOrig, oldDone) {
  // Повертає клон newObj, де кожний _Text замінений на переклад з oldDone,
  // якщо oldDone[key] !== oldOrig[key] (тобто рядок був перекладений).
  const oOrig = flatten(oldOrig);
  const oDone = flatten(oldDone);
  const clone = JSON.parse(JSON.stringify(newObj));
  const lst = clone?._List?.Array;
  let touched = 0, kept = 0, newCells = 0;
  if (Array.isArray(lst)) {
    for (const row of lst) {
      const tid = row?._TextId ?? "";
      const arr = row?._Texts?.Array;
      if (!Array.isArray(arr)) continue;
      for (let j = 0; j < arr.length; j++) {
        const key = `${tid}|${j}`;
        const origText = oOrig.get(key);
        const doneText = oDone.get(key);
        if (doneText !== undefined && origText !== undefined && doneText !== origText) {
          arr[j]._Text = doneText;
          touched++;
        } else if (origText === undefined) {
          newCells++; // новий рядок у патчі — лишаємо англ.
        } else {
          kept++;     // нічого не перекладали — лишаємо англ.
        }
      }
    }
  }
  return { obj: clone, stats: { touched, kept, newCells } };
}

function main() {
  const argv = process.argv.slice(2);
  const newDir = argv[0];
  if (!newDir) { console.error("usage: node hbr-migrate-bundle-hash.cjs <newDir> [newHash]"); process.exit(1); }
  if (!fs.existsSync(newDir)) { console.error("newDir not found: " + newDir); process.exit(1); }
  let newHash = argv[1];
  if (!newHash) {
    // Дістаємо з settings.json (Electron userData).
    const settingsPath = path.join(process.env.APPDATA, "deadly-premonition-localization-tool", "settings.json");
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const bp = s.hbrBundlePath;
      if (bp) newHash = path.basename(bp, ".bundle");
    } catch {}
  }
  if (!newHash) { console.error("newHash not provided and not deducible from settings.json"); process.exit(1); }
  console.log("[INFO] newHash =", newHash);

  // ── Сканування ─────────────────────────────────────────────
  const newFiles = fs.readdirSync(newDir).filter((f) => f.endsWith(".json"));
  const oldOrigFiles = fs.readdirSync(originalDir).filter((f) => f.endsWith(".json"));
  const oldDoneFiles = fs.readdirSync(doneDir).filter((f) => f.endsWith(".json"));
  const newByPid = new Map();
  const oldOrigByPid = new Map();
  const oldDoneByPid = new Map();
  for (const f of newFiles)    { const p = pidFromName(f); if (p) newByPid.set(p, f); }
  for (const f of oldOrigFiles){ const p = pidFromName(f); if (p) oldOrigByPid.set(p, f); }
  for (const f of oldDoneFiles){ const p = pidFromName(f); if (p) oldDoneByPid.set(p, f); }
  console.log(`[INFO] files: new=${newByPid.size}  oldOrig=${oldOrigByPid.size}  oldDone=${oldDoneByPid.size}`);

  // ── Backup ─────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bakDir = path.join(baseDir, `_backup-${ts}`);
  fs.mkdirSync(bakDir, { recursive: true });
  // Копіюємо ВСЕ Original/Done/Meta під backup. Швидше через rename, але тоді
  // ми втрачаємо доступ до читання old-Done у мерджі. Краще copy.
  const copyTree = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      const sp = path.join(src, f), dp = path.join(dst, f);
      const st = fs.statSync(sp);
      if (st.isDirectory()) copyTree(sp, dp);
      else fs.copyFileSync(sp, dp);
    }
  };
  copyTree(originalDir, path.join(bakDir, "Original"));
  copyTree(doneDir, path.join(bakDir, "Done"));
  copyTree(metaDir, path.join(bakDir, "Meta"));
  console.log("[BACKUP]", bakDir);

  // ── Будуємо новий Original/ + новий Done/ + новий meta ──────
  const newMetaItems = [];
  let processed = 0, totalTouched = 0, totalKept = 0, totalNewCells = 0;
  for (const [pid, newName] of newByPid) {
    const oldOrigName = oldOrigByPid.get(pid);
    const oldDoneName = oldDoneByPid.get(pid);
    if (!oldOrigName) { console.warn(`[WARN] no old Original for pid ${pid} (file ${newName}) — using new as-is`); }
    if (!oldDoneName) { console.warn(`[WARN] no old Done for pid ${pid} (file ${newName}) — Done = new English`); }

    const newObj = readJson(path.join(newDir, newName));
    const oldOrigObj = oldOrigName ? readJson(path.join(originalDir, oldOrigName)) : null;
    const oldDoneObj = oldDoneName ? readJson(path.join(doneDir, oldDoneName)) : null;

    const mName = newObj.m_Name || newName.replace(/\.json$/, "");
    const newFileName = `${mName}-${newHash}-${pid}.json`;
    const newOrigPath = path.join(originalDir, newFileName);
    const newDonePath = path.join(doneDir, newFileName);

    // Original — це свіжий дамп з нового bundle, без жодних змін.
    writeJsonInt64(newOrigPath, newObj);

    // Done — структура нового + перенесені переклади.
    let doneObj;
    if (oldDoneObj && oldOrigObj) {
      const merged = mergeTranslations(newObj, oldOrigObj, oldDoneObj);
      doneObj = merged.obj;
      totalTouched += merged.stats.touched;
      totalKept += merged.stats.kept;
      totalNewCells += merged.stats.newCells;
    } else {
      doneObj = newObj;
    }
    writeJsonInt64(newDonePath, doneObj);

    // Дізнаємось scriptPathId з m_Script.m_PathID (Int64) — у нашому JSON-кодувані як string-обгортка після readJson.
    const scriptPid = (newObj?.m_Script?.m_PathID ?? "0").toString();
    newMetaItems.push({
      name: mName,
      file: newFileName,
      pathId: pid,
      afiIndex: 0,
      typeId: 114,
      bundle: newHash,
      scriptPathId: scriptPid,
      unityVersion: "2022.3.62f2",
    });
    processed++;
  }

  // Видаляємо старі файли (зі старим хешем у назві). Залишається тільки новий
  // набір. Якщо хочеться — _backup лежить поруч.
  for (const f of oldOrigFiles) {
    if (!f.includes(newHash)) {
      try { fs.unlinkSync(path.join(originalDir, f)); } catch {}
    }
  }
  for (const f of oldDoneFiles) {
    if (!f.includes(newHash)) {
      try { fs.unlinkSync(path.join(doneDir, f)); } catch {}
    }
  }
  // .json.bak у Done/ — це autosave-backup'и редактора, прив'язані до СТАРИХ
  // назв. Прибираємо, щоб не плутали.
  for (const f of fs.readdirSync(doneDir)) {
    if (f.endsWith(".json.bak")) {
      try { fs.unlinkSync(path.join(doneDir, f)); } catch {}
    }
  }

  // ── Записуємо новий meta ──────────────────────────────────
  const newMeta = {
    bundles: [`${newHash}.bundle`],
    items: newMetaItems,
    exportedAt: new Date().toISOString(),
    migratedFrom: `_backup-${ts}`,
  };
  // pathId/scriptPathId — лишаємо як числа у JSON (бо main.cjs все одно
  // обертає їх перед parse). Інакше PowerShell-скрипт буде бачити string і
  // правильно парсить як Int64.
  let metaRaw = JSON.stringify(newMeta, null, 2);
  // Розгортаємо string→number назад, щоб формат збігся з оригінальним export'ом.
  // (PowerShell-import все одно регексом обгортає Int64 у string перед parse.)
  metaRaw = metaRaw.replace(/"(pathId|scriptPathId)"\s*:\s*"(-?\d+)"/g, '"$1": $2');
  fs.writeFileSync(metaPath, metaRaw, "utf8");

  console.log("──────────────────────────────────────────");
  console.log(`processed:     ${processed}`);
  console.log(`translated:    ${totalTouched}  (рядків з перекладом перенесено)`);
  console.log(`kept-english:  ${totalKept}`);
  console.log(`new-in-patch:  ${totalNewCells}  (новий контент з патчу — англійською)`);
  console.log(`backup:        ${bakDir}`);
  console.log(`meta:          ${metaPath}`);
}

main();
