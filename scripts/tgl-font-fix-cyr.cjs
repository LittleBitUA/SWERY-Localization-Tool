// TGL font JSON repair: усуває моноширинне advance=30 для кирилиці,
// яке створює видимі стрибки між літерами. Для тих літер, що мають візуальний
// латинський аналог (А↔A, Н↔H, О↔O, …) — копіюємо advance з нього. Для решти
// підраховуємо вузький fit: advance = max(8, vw + vx + 1).
//
// Записує оновлений JSON; оригінал зберігає у <file>.bak (один раз).

const fs = require("node:fs");

const TARGET = process.argv[2];
const OUT = process.argv[3] ?? TARGET;
const DRY = process.argv.includes("--dry");
if (!TARGET) {
  console.error("Usage: node tgl-font-fix-cyr.cjs <font.json> [out.json] [--dry]");
  process.exit(2);
}

// Кирилиця → візуальний латинський аналог (де є). Якщо нема — буде fit-fallback.
const PAIRS = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O",
  "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I", "Ї": "Ï",
  "Є": "E", "Ё": "E", "З": "3",
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o",
  "р": "p", "с": "c", "т": "t", "х": "x", "у": "y", "і": "i", "ї": "ï",
  "є": "e", "ё": "e",
};

const raw = fs.readFileSync(TARGET, "utf8");
const data = JSON.parse(raw);
const arr = data?.m_CharacterRects?.Array;
if (!Array.isArray(arr)) throw new Error("No m_CharacterRects.Array");

const byIndex = new Map();
for (const it of arr) {
  if (it && typeof it.index === "number") byIndex.set(it.index, it);
}

const CYR_RANGES = [
  [0x0400, 0x04FF], // Cyrillic + Cyrillic Supplement
  [0x0500, 0x052F], // Cyrillic Supplement
  [0x2DE0, 0x2DFF],
  [0xA640, 0xA69F],
];
function isCyrCp(cp) {
  for (const [a, b] of CYR_RANGES) if (cp >= a && cp <= b) return true;
  return false;
}

let touched = 0;
let pairedFix = 0;
let fitFix = 0;
let untouched = 0;
const samples = [];

for (const [ch, latin] of Object.entries(PAIRS)) {
  const cyrCp = ch.codePointAt(0);
  const latCp = latin.codePointAt(0);
  // sanity: pair entries existed.
  if (!byIndex.has(cyrCp) || !byIndex.has(latCp)) continue;
}

for (const it of arr) {
  const cp = it.index;
  if (typeof cp !== "number") continue;
  if (!isCyrCp(cp)) continue;

  const ch = String.fromCodePoint(cp);
  const latin = PAIRS[ch];
  const before = it.advance;

  let newAdv = before;
  let how = "skip";
  if (latin) {
    const lat = byIndex.get(latin.codePointAt(0));
    if (lat && typeof lat.advance === "number") {
      newAdv = lat.advance;
      how = `pair←${latin}`;
    }
  }
  if (how === "skip") {
    // Tight-fit fallback. vert.width — рендерна ширина гліфа на cell.
    const vw = it.vert?.width ?? 0;
    const vx = it.vert?.x ?? 0;
    const fit = Math.max(8, Math.round(vw + vx + 1));
    if (fit > 0 && fit < before) {
      newAdv = fit;
      how = "fit";
    }
  }

  if (newAdv !== before) {
    it.advance = newAdv;
    touched++;
    if (how.startsWith("pair")) pairedFix++; else if (how === "fit") fitFix++;
    if (samples.length < 25) samples.push({ ch, cp, before, after: newAdv, how });
  } else {
    untouched++;
  }
}

console.log(`Total m_CharacterRects entries: ${arr.length}`);
console.log(`Cyrillic touched:  ${touched}  (paired=${pairedFix}, fit=${fitFix})`);
console.log(`Cyrillic untouched: ${untouched}`);
console.log("Sample (first 25):");
for (const s of samples) {
  console.log(`  ${s.ch}  U+${s.cp.toString(16).padStart(4, "0")}  ${s.before} → ${s.after}  [${s.how}]`);
}

if (DRY) {
  console.log("\n--dry: not writing file.");
  process.exit(0);
}

// .bak один раз.
if (OUT === TARGET) {
  const bak = TARGET + ".bak";
  if (!fs.existsSync(bak)) {
    fs.copyFileSync(TARGET, bak);
    console.log(`\nBackup → ${bak}`);
  } else {
    console.log(`\nBackup exists, keeping → ${bak}`);
  }
}

fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`Wrote ${OUT}`);
