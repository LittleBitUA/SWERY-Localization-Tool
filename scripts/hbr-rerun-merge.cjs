// Повторна міграція з виправленою Int64-обгорткою для `rid`. Бере:
//   - new English structure з E:/HB (correct new-bundle rids)
//   - original UA translations з _backup-2026-05-19T13-11-55/Done/ (user's переклад)
//   - original EN з _backup-2026-05-19T13-11-55/Original/ (для diff: який рядок було перекладено)
// Пише оновлені Done/Original/Meta з ПРАВИЛЬНИМИ rids.
//
// Запуск: node scripts/hbr-rerun-merge.cjs

const fs = require("fs");
const path = require("path");
const os = require("os");

const userDocs = path.join(os.homedir(), "Documents", "SWERY-Localization-Tool");
const baseDir = path.join(userDocs, "HBR", "Text");
const originalDir = path.join(baseDir, "Original");
const doneDir = path.join(baseDir, "Done");
const metaDir = path.join(baseDir, "Meta");
const metaPath = path.join(metaDir, "hbr-meta.json");

const newDir = "E:/HB";
const newHash = "_resources_assets_all_0d63e41486d027f2e31ca9d62cbfb661";
// Original UA-translated source (з самого першого backup'у, до того як ми ламали rid'и)
const origBackup = path.join(baseDir, "_backup-2026-05-19T13-11-55");
const srcOrigDir = path.join(origBackup, "Original");
const srcDoneDir = path.join(origBackup, "Done");

function readInt64Safe(p) {
  const raw = fs.readFileSync(p, "utf8");
  const safe = raw
    .replace(/"m_PathID"\s*:\s*(-?\d+)/g, '"m_PathID":"$1"')
    .replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"')
    .replace(/"rid"\s*:\s*(-?\d+)/g, '"rid":"$1"');
  return JSON.parse(safe);
}

function writeInt64(p, obj) {
  let raw = JSON.stringify(obj, null, 2);
  raw = raw.replace(/"m_PathID"\s*:\s*"(-?\d+)"/g, '"m_PathID": $1');
  raw = raw.replace(/"rid"\s*:\s*"(-?\d+)"/g, '"rid": $1');
  fs.writeFileSync(p, raw, "utf8");
}

function pidFromName(name) { const m = name.match(/-(-?\d+)\.json$/); return m ? m[1] : null; }

function flatten(obj) {
  const m = new Map();
  const lst = obj?._List?.Array; if (!Array.isArray(lst)) return m;
  for (const row of lst) {
    const tid = row?._TextId ?? "";
    const arr = row?._Texts?.Array; if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j++) m.set(`${tid}|${j}`, arr[j]?._Text ?? "");
  }
  return m;
}

function merge(newObj, oldOrig, oldDone) {
  const oOrig = flatten(oldOrig);
  const oDone = flatten(oldDone);
  const out = JSON.parse(JSON.stringify(newObj));
  let touched = 0, kept = 0, newCells = 0;
  for (const row of (out._List?.Array || [])) {
    const tid = row?._TextId ?? "";
    const arr = row?._Texts?.Array; if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j++) {
      const key = `${tid}|${j}`;
      const origText = oOrig.get(key);
      const doneText = oDone.get(key);
      if (doneText !== undefined && origText !== undefined && doneText !== origText) {
        arr[j]._Text = doneText; touched++;
      } else if (origText === undefined) newCells++;
      else kept++;
    }
  }
  return { obj: out, stats: { touched, kept, newCells } };
}

function main() {
  // Карта new-files за pathId
  const newFiles = fs.readdirSync(newDir).filter((f) => f.endsWith(".json"));
  const srcOrigFiles = fs.readdirSync(srcOrigDir).filter((f) => f.endsWith(".json"));
  const srcDoneFiles = fs.readdirSync(srcDoneDir).filter((f) => f.endsWith(".json"));
  const newByPid = new Map();
  const srcOrigByPid = new Map();
  const srcDoneByPid = new Map();
  for (const f of newFiles)     { const p = pidFromName(f); if (p) newByPid.set(p, f); }
  for (const f of srcOrigFiles) { const p = pidFromName(f); if (p) srcOrigByPid.set(p, f); }
  for (const f of srcDoneFiles) { const p = pidFromName(f); if (p) srcDoneByPid.set(p, f); }
  console.log(`files: new=${newByPid.size} oldOrig=${srcOrigByPid.size} oldDone=${srcDoneByPid.size}`);

  // Re-build Original/ та Done/ та meta — повністю.
  // Видаляємо поточні Original/ та Done/ (поточні не валідні).
  for (const f of fs.readdirSync(originalDir)) {
    try { fs.unlinkSync(path.join(originalDir, f)); } catch {}
  }
  for (const f of fs.readdirSync(doneDir)) {
    try { fs.unlinkSync(path.join(doneDir, f)); } catch {}
  }

  const newMetaItems = [];
  let processed = 0, totalTouched = 0, totalKept = 0, totalNew = 0;
  for (const [pid, newName] of newByPid) {
    const srcOrigName = srcOrigByPid.get(pid);
    const srcDoneName = srcDoneByPid.get(pid);
    const newObj = readInt64Safe(path.join(newDir, newName));
    const srcOrigObj = srcOrigName ? readInt64Safe(path.join(srcOrigDir, srcOrigName)) : null;
    const srcDoneObj = srcDoneName ? readInt64Safe(path.join(srcDoneDir, srcDoneName)) : null;

    const mName = newObj.m_Name || newName.replace(/\.json$/, "");
    const newFileName = `${mName}-${newHash}-${pid}.json`;

    // Original = свіжий дамп з нового bundle.
    writeInt64(path.join(originalDir, newFileName), newObj);

    // Done = newObj з накладеним перекладом (де було перекладено в old).
    let doneObj;
    if (srcDoneObj && srcOrigObj) {
      const m = merge(newObj, srcOrigObj, srcDoneObj);
      doneObj = m.obj;
      totalTouched += m.stats.touched;
      totalKept += m.stats.kept;
      totalNew += m.stats.newCells;
    } else {
      doneObj = newObj;
    }
    writeInt64(path.join(doneDir, newFileName), doneObj);

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

  // Записуємо новий meta. Зберігаємо pathId/scriptPathId як number (PowerShell
  // у pack-скрипті сам обгортає Int64 у string перед parse).
  const meta = {
    bundles: [`${newHash}.bundle`],
    items: newMetaItems,
    exportedAt: new Date().toISOString(),
    migratedFrom: "_backup-2026-05-19T13-11-55 (rerun with rid-fix)",
  };
  let metaRaw = JSON.stringify(meta, null, 2);
  metaRaw = metaRaw.replace(/"(pathId|scriptPathId)"\s*:\s*"(-?\d+)"/g, '"$1": $2');
  fs.writeFileSync(metaPath, metaRaw, "utf8");

  console.log("────────────────────────────────────");
  console.log(`processed:     ${processed}`);
  console.log(`translated:    ${totalTouched}`);
  console.log(`kept-english:  ${totalKept}`);
  console.log(`new-in-patch:  ${totalNew}`);
  console.log(`meta:          ${metaPath}`);
}

main();
