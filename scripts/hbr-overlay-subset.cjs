// Overlay subset: бере Done.translated-* як джерело перекладів, ставить у Done/
// (поверх no-op-англ.) тільки ті файли, чий m_Name є у списку.
// Решта в Done/ лишається англ. → pack буде гібридним.
//
// Запуск:
//   node scripts/hbr-overlay-subset.cjs <translatedBackupDir> <mName1,mName2,...>
//   node scripts/hbr-overlay-subset.cjs <translatedBackupDir> --first-half | --second-half

const fs = require("fs");
const path = require("path");
const os = require("os");

const baseDir = path.join(os.homedir(), "Documents", "SWERY-Localization-Tool", "HBR", "Text");
const doneDir = path.join(baseDir, "Done");
const metaPath = path.join(baseDir, "Meta", "hbr-meta.json");

function main() {
  const argv = process.argv.slice(2);
  const srcDir = argv[0];
  const sel = argv[1];
  if (!srcDir || !sel) {
    console.error("usage: node hbr-overlay-subset.cjs <translatedBackupDir> <names | --first-half | --second-half>");
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8").replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));
  const items = meta.items.slice().sort((a, b) => a.name.localeCompare(b.name));
  let names;
  if (sel === "--first-half") {
    names = new Set(items.slice(0, Math.ceil(items.length / 2)).map((i) => i.name));
  } else if (sel === "--second-half") {
    names = new Set(items.slice(Math.ceil(items.length / 2)).map((i) => i.name));
  } else {
    names = new Set(sel.split(",").map((s) => s.trim()).filter(Boolean));
  }
  console.log("[OVERLAY] applying translated version for:", [...names].join(", "));

  let copied = 0, miss = 0;
  for (const item of meta.items) {
    if (!names.has(item.name)) continue;
    const src = path.join(srcDir, item.file);
    const dst = path.join(doneDir, item.file);
    if (!fs.existsSync(src)) { console.warn("[MISS] no source for", item.name, "at", src); miss++; continue; }
    fs.copyFileSync(src, dst);
    copied++;
  }
  console.log(`[DONE] overlaid=${copied} missing=${miss}`);
}

main();
