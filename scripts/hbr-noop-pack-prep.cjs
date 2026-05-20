// No-op pack prep: копіює "чисті" англ. дампи з <newDir> у Done/, перейменовуючи
// під поточну схему imен (newHash + pathId). Існуючий Done/ зберігаємо у Done.translated/.
// Тоді Pack запише у bundle ТЕ Ж, що було в extract'і → якщо гра все одно крашиться,
// проблема в AssetsTools.NET, а не у нашому перекладі.
//
// Запуск: node scripts/hbr-noop-pack-prep.cjs <newDir>

const fs = require("fs");
const path = require("path");
const os = require("os");

const baseDir = path.join(os.homedir(), "Documents", "SWERY-Localization-Tool", "HBR", "Text");
const doneDir = path.join(baseDir, "Done");
const metaPath = path.join(baseDir, "Meta", "hbr-meta.json");

function pidFromName(name) { const m = name.match(/-(-?\d+)\.json$/); return m ? m[1] : null; }

function main() {
  const newDir = process.argv[2];
  if (!newDir) { console.error("usage: node hbr-noop-pack-prep.cjs <newDir>"); process.exit(1); }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8").replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));
  const newFiles = fs.readdirSync(newDir).filter((f) => f.endsWith(".json"));
  const newByPid = new Map();
  for (const f of newFiles) { const p = pidFromName(f); if (p) newByPid.set(p, f); }

  // Бекап існуючого Done/ → Done.translated/
  const bak = path.join(baseDir, "Done.translated-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  fs.mkdirSync(bak, { recursive: true });
  for (const f of fs.readdirSync(doneDir)) {
    fs.renameSync(path.join(doneDir, f), path.join(bak, f));
  }
  console.log("[BACKUP] Done/ → " + bak);

  // Копіюємо файли з newDir у Done/ під новими іменами з meta.
  let copied = 0, miss = 0;
  for (const item of meta.items) {
    const newFile = newByPid.get(String(item.pathId));
    if (!newFile) { console.warn("[MISS] no new file for pid " + item.pathId + " (" + item.name + ")"); miss++; continue; }
    const src = path.join(newDir, newFile);
    const dst = path.join(doneDir, item.file);
    // Раз файли з E:/HB мають той самий контент (включно з m_PathID-числами),
    // просто бінарно копіюємо. Можна було б нормалізувати — але не треба.
    fs.copyFileSync(src, dst);
    copied++;
  }
  console.log(`[DONE] copied=${copied} miss=${miss}`);
  console.log(`Тепер у тулзі натисни Pack — це буде no-op (англ. оригінал).`);
}

main();
