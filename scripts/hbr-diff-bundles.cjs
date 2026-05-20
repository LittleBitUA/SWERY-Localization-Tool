// One-shot util: порівнює старий Original/ із новим extract (E:/HB або іншим).
// Запуск: node scripts/hbr-diff-bundles.cjs <newDir> <oldDir>
// Виводить по кожному файлу: changed/added/removed _Text-поля + _TextId.

const fs = require("fs");
const path = require("path");

function readJsonInt64Safe(p) {
  // m_PathID / pathId — Int64; JSON.parse труне Double. Обгортка в string.
  const raw = fs.readFileSync(p, "utf8");
  const safe = raw.replace(/"m_PathID"\s*:\s*(-?\d+)/g, '"m_PathID":"$1"');
  return JSON.parse(safe);
}

function pidFromName(name) {
  const m = name.match(/-(-?\d+)\.json$/);
  return m ? m[1] : null;
}

function flatten(obj) {
  // Виймаємо все: m_Name → масив { textId, idx, text } по всіх _List.Array[*]._Texts.Array[*]
  const out = [];
  const lst = obj?._List?.Array;
  if (!Array.isArray(lst)) return out;
  for (let i = 0; i < lst.length; i++) {
    const row = lst[i];
    const tid = row?._TextId ?? "";
    const id = row?._Id ?? 0;
    const arr = row?._Texts?.Array;
    if (!Array.isArray(arr)) continue;
    for (let j = 0; j < arr.length; j++) {
      out.push({ textId: tid, id, idx: j, text: arr[j]?._Text ?? "" });
    }
  }
  return out;
}

function diffFiles(newPath, oldPath) {
  const a = readJsonInt64Safe(newPath);
  const b = readJsonInt64Safe(oldPath);
  const aRows = flatten(a);
  const bRows = flatten(b);
  const aIdx = new Map(); // textId|idx → text
  const bIdx = new Map();
  for (const r of aRows) aIdx.set(`${r.textId}|${r.idx}`, r.text);
  for (const r of bRows) bIdx.set(`${r.textId}|${r.idx}`, r.text);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, t] of aIdx) {
    if (!bIdx.has(k)) added.push({ key: k, newText: t });
    else if (bIdx.get(k) !== t) changed.push({ key: k, oldText: bIdx.get(k), newText: t });
  }
  for (const [k, t] of bIdx) if (!aIdx.has(k)) removed.push({ key: k, oldText: t });
  return { mName: a?.m_Name ?? "?", added, removed, changed, totalA: aRows.length, totalB: bRows.length };
}

function main() {
  const newDir = process.argv[2];
  const oldDir = process.argv[3];
  if (!newDir || !oldDir) {
    console.error("usage: node hbr-diff-bundles.cjs <newDir> <oldDir>");
    process.exit(1);
  }
  const newFiles = fs.readdirSync(newDir).filter((f) => f.endsWith(".json"));
  const oldFiles = fs.readdirSync(oldDir).filter((f) => f.endsWith(".json"));
  // map pathId → fileName
  const oldByPid = new Map();
  for (const f of oldFiles) { const p = pidFromName(f); if (p) oldByPid.set(p, f); }

  let filesChanged = 0, filesIdentical = 0, filesOrphan = 0;
  const summary = [];
  for (const nf of newFiles) {
    const pid = pidFromName(nf);
    if (!pid) continue;
    const of = oldByPid.get(pid);
    if (!of) { filesOrphan++; summary.push({ file: nf, status: "ORPHAN-NEW (no old match)" }); continue; }
    oldByPid.delete(pid);
    const d = diffFiles(path.join(newDir, nf), path.join(oldDir, of));
    if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) {
      filesIdentical++;
    } else {
      filesChanged++;
      summary.push({
        mName: d.mName,
        pid,
        totals: `${d.totalB} → ${d.totalA}`,
        added: d.added.length,
        removed: d.removed.length,
        changed: d.changed.length,
        sample: { added: d.added.slice(0, 3), removed: d.removed.slice(0, 3), changed: d.changed.slice(0, 3) },
      });
    }
  }
  for (const [pid, f] of oldByPid) {
    filesOrphan++;
    summary.push({ file: f, pid, status: "ORPHAN-OLD (removed in new)" });
  }
  console.log(JSON.stringify({
    filesNew: newFiles.length, filesOld: oldFiles.length,
    filesIdentical, filesChanged, filesOrphan,
    detail: summary,
  }, null, 2));
}

main();
