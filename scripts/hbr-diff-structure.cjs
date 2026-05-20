// Глибока структурна різниця між старим (Original/) і новим (E:/HB) extract'ом.
// Шукає: нові/видалені ключі на будь-якій глибині, різниці у scalar-полях
// (крім _Text — їх ігноруємо, бо лоc-зміни вже відомі).
//
// Запуск: node scripts/hbr-diff-structure.cjs <newDir> <oldDir>

const fs = require("fs");
const path = require("path");

function readJsonInt64Safe(p) {
  const raw = fs.readFileSync(p, "utf8");
  const safe = raw
    .replace(/"m_PathID"\s*:\s*(-?\d+)/g, '"m_PathID":"$1"')
    .replace(/"pathId"\s*:\s*(-?\d+)/g, '"pathId":"$1"');
  return JSON.parse(safe);
}

function pidFromName(name) {
  const m = name.match(/-(-?\d+)\.json$/);
  return m ? m[1] : null;
}

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// Структурний підпис: проходимо обидва дерева, відмічаємо різниці у:
//  - keys (одна сторона має ключ, інша ні)
//  - типах (string vs number vs object)
//  - довжинах масивів
//  - значеннях scalar-полів, які НЕ є _Text (бо _Text — це власне переклад)
function diff(a, b, prefix, out, opts) {
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) { out.push(`TYPE ${prefix}: ${ta} vs ${tb}`); return; }
  if (ta === "object" && a !== null) {
    const ka = new Set(Object.keys(a));
    const kb = new Set(Object.keys(b));
    for (const k of ka) if (!kb.has(k)) out.push(`ADDED-IN-NEW ${prefix}.${k} = ${JSON.stringify(a[k]).slice(0,80)}`);
    for (const k of kb) if (!ka.has(k)) out.push(`REMOVED-IN-NEW ${prefix}.${k} (had ${JSON.stringify(b[k]).slice(0,80)})`);
    for (const k of ka) if (kb.has(k)) diff(a[k], b[k], `${prefix}.${k}`, out, opts);
    return;
  }
  if (ta === "array") {
    if (a.length !== b.length) { out.push(`ARR-LEN ${prefix}: ${a.length} vs ${b.length}`); }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${prefix}[${i}]`, out, opts);
    return;
  }
  // scalar
  if (a !== b) {
    // _Text різниці ігноруємо — їх вже знаємо.
    if (/\._Text$/.test(prefix)) return;
    // m_PathID — Int64-стрінги; іноді можуть бути нулями. Покажемо.
    const sample = JSON.stringify(b).slice(0,60) + " → " + JSON.stringify(a).slice(0,60);
    out.push(`VAL ${prefix}: ${sample}`);
  }
}

function main() {
  const newDir = process.argv[2];
  const oldDir = process.argv[3];
  const newFiles = fs.readdirSync(newDir).filter((f) => f.endsWith(".json"));
  const oldFiles = fs.readdirSync(oldDir).filter((f) => f.endsWith(".json"));
  const oldByPid = new Map();
  for (const f of oldFiles) { const p = pidFromName(f); if (p) oldByPid.set(p, f); }

  let totalDiffs = 0;
  for (const nf of newFiles) {
    const pid = pidFromName(nf);
    const of = oldByPid.get(pid);
    if (!of) continue;
    const a = readJsonInt64Safe(path.join(newDir, nf));
    const b = readJsonInt64Safe(path.join(oldDir, of));
    const out = [];
    diff(a, b, "", out, {});
    if (out.length) {
      totalDiffs += out.length;
      console.log(`\n=== ${a.m_Name || nf} (pid ${pid}) — ${out.length} differences ===`);
      for (const line of out.slice(0, 50)) console.log("  " + line);
      if (out.length > 50) console.log(`  ... +${out.length-50} more`);
    }
  }
  console.log(`\nTOTAL DIFFERENCES: ${totalDiffs}`);
}

main();
