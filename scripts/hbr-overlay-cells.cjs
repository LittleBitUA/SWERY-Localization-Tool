// Hybrid overlay для ОДНОГО файла: бере English-version та копіює `_Text` з UA
// тільки для рядків у заданому діапазоні. Решта лишається англ.
//
// Використовуємо для бінарного пошуку винного _Text всередині файла.
//
// Запуск:
//   node scripts/hbr-overlay-cells.cjs <mName> <fromRow> <toRow>
//
// fromRow/toRow — це _List.Array-індекси, інклюзивно (0-based).
// Всі _Texts у вибраних рядках беруться з перекладу, поза діапазоном — англ.

const fs = require("fs");
const path = require("path");
const os = require("os");

const baseDir = path.join(os.homedir(), "Documents", "SWERY-Localization-Tool", "HBR", "Text");
const doneDir = path.join(baseDir, "Done");
const metaPath = path.join(baseDir, "Meta", "hbr-meta.json");
const newDir = "E:/HB";
const translatedBak = path.join(baseDir, "Done.translated-2026-05-19T13-49-12");

function readInt64Safe(p) {
  const raw = fs.readFileSync(p, "utf8");
  const safe = raw
    .replace(/"m_PathID"\s*:\s*(-?\d+)/g, '"m_PathID":"$1"')
    .replace(/"rid"\s*:\s*(-?\d+)/g, '"rid":"$1"');
  return JSON.parse(safe);
}

function writeInt64(p, obj) {
  let raw = JSON.stringify(obj, null, 2);
  raw = raw.replace(/"m_PathID"\s*:\s*"(-?\d+)"/g, '"m_PathID": $1');
  raw = raw.replace(/"rid"\s*:\s*"(-?\d+)"/g, '"rid": $1');
  fs.writeFileSync(p, raw, "utf8");
}

function main() {
  const [mName, fromS, toS] = process.argv.slice(2);
  if (!mName || fromS === undefined || toS === undefined) {
    console.error("usage: node hbr-overlay-cells.cjs <mName> <fromRow> <toRow>");
    process.exit(1);
  }
  const from = parseInt(fromS, 10), to = parseInt(toS, 10);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8").replace(/"(pathId|scriptPathId)"\s*:\s*(-?\d+)/g, '"$1":"$2"'));
  const item = meta.items.find((i) => i.name === mName);
  if (!item) { console.error("not in meta: " + mName); process.exit(1); }

  // Знаходимо EN-source у newDir за PathID.
  const pidStr = String(item.pathId);
  const enFile = fs.readdirSync(newDir).find((f) => {
    const m = f.match(/-(-?\d+)\.json$/); return m && m[1] === pidStr;
  });
  if (!enFile) { console.error("no EN source for " + mName); process.exit(1); }
  const enObj = readInt64Safe(path.join(newDir, enFile));
  const trObj = readInt64Safe(path.join(translatedBak, item.file));

  // Будуємо hybrid: enObj як основа, _Text з trObj для рядків [from..to].
  const out = JSON.parse(JSON.stringify(enObj));
  const lst = out._List.Array;
  let touched = 0;
  for (let i = from; i <= to && i < lst.length; i++) {
    const trRow = trObj._List.Array[i];
    if (!trRow) continue;
    for (let j = 0; j < lst[i]._Texts.Array.length; j++) {
      const trText = trRow._Texts.Array[j]?._Text;
      if (trText === undefined) continue;
      if (trText !== lst[i]._Texts.Array[j]._Text) {
        lst[i]._Texts.Array[j]._Text = trText;
        touched++;
      }
    }
  }
  const dst = path.join(doneDir, item.file);
  writeInt64(dst, out);
  console.log(`[HYBRID] ${mName} rows ${from}-${to}: replaced ${touched} _Text values → ${dst}`);
}

main();
