// Quick inspector for The Good Life font JSON. Shows vert.y/height for
// Latin "N O V A G R" and Cyrillic "Н О В А Г Р" so we can see the skew.

const fs = require("node:fs");
const path = require("node:path");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tgl-font-inspect.cjs <font.json>");
  process.exit(2);
}
const raw = fs.readFileSync(file, "utf8");
const data = JSON.parse(raw);

const arr = data?.m_CharacterRects?.Array;
if (!Array.isArray(arr)) {
  console.error("No m_CharacterRects.Array");
  process.exit(2);
}

const byIndex = new Map();
for (const it of arr) {
  if (it && typeof it.index === "number") byIndex.set(it.index, it);
}
console.log(`Font: ${data.m_Name}, m_FontSize=${data.m_FontSize}, m_LineSpacing=${data.m_LineSpacing}`);
console.log(`Total characters: ${arr.length}`);
console.log();

function row(ch) {
  const it = byIndex.get(ch.codePointAt(0));
  if (!it) return `${ch}  ${String(ch.codePointAt(0)).padStart(5)}  —  (missing)`;
  const v = it.vert ?? {};
  const u = it.uv ?? {};
  const fmt = (n) => (typeof n === "number" ? n.toFixed(6).padStart(11) : "?");
  return `${ch}  ${String(it.index).padStart(5)}  ` +
    `vx=${fmt(v.x)} vy=${fmt(v.y)} vw=${fmt(v.width)} vh=${fmt(v.height)}  ` +
    `ux=${fmt(u.x)} uy=${fmt(u.y)} uw=${fmt(u.width)} uh=${fmt(u.height)}  ` +
    `adv=${fmt(it.advance)}`;
}

console.log("LATIN reference:");
for (const ch of "NOVA GRA HOBA fra") console.log("  " + row(ch));
console.log();
console.log("CYRILLIC tested (uppercase used in 'НОВА ГРА'):");
for (const ch of "НОВАГРА Ёёі Ії Єє Ґґ’") console.log("  " + row(ch));
console.log();

// Detect baseline skew: for каждого кирилiчного букви look at its visually
// matched Latin counterpart vert.y. Find offset.
const pairs = [
  ["Н", "N"], ["О", "O"], ["В", "B"], ["А", "A"], ["Г", "G"], ["Р", "P"],
  ["Е", "E"], ["М", "M"], ["Т", "T"], ["К", "K"], ["С", "C"], ["Х", "X"],
  ["о", "o"], ["а", "a"], ["е", "e"], ["р", "p"], ["с", "c"], ["в", "b"],
  ["т", "t"], ["х", "x"], ["к", "k"], ["м", "m"], ["н", "h"], ["у", "y"],
];
console.log("Pairwise CYR vs LATIN vert.y delta (vert.y_cyr - vert.y_lat):");
for (const [c, l] of pairs) {
  const ci = byIndex.get(c.codePointAt(0));
  const li = byIndex.get(l.codePointAt(0));
  if (!ci || !li) continue;
  const dy = (ci.vert?.y ?? 0) - (li.vert?.y ?? 0);
  const dh = (ci.vert?.height ?? 0) - (li.vert?.height ?? 0);
  console.log(`  ${c}↔${l}  Δy=${dy.toFixed(6)}  Δh=${dh.toFixed(6)}  cyr.y=${ci.vert?.y?.toFixed(3)}  lat.y=${li.vert?.y?.toFixed(3)}`);
}

// Group all cyrillics by their vert.y so we see if it's one homogeneous shift
// or multiple inconsistent values.
const cyrUpper = [];
for (let cp = 0x0410; cp <= 0x044F; cp++) {
  const it = byIndex.get(cp);
  if (it) cyrUpper.push({ ch: String.fromCodePoint(cp), y: it.vert?.y, h: it.vert?.height });
}
console.log();
console.log(`Unique vert.y in U+0410..U+044F:`);
const yMap = new Map();
for (const x of cyrUpper) {
  const k = (x.y ?? 0).toFixed(6);
  if (!yMap.has(k)) yMap.set(k, []);
  yMap.get(k).push(x.ch);
}
for (const [k, chs] of yMap.entries()) {
  console.log(`  y=${k}  ×${chs.length}  ${chs.join(" ")}`);
}

// And latin uppercase basic vert.y for compare:
console.log();
console.log(`Unique vert.y in U+0041..U+005A (Latin upper):`);
const latMap = new Map();
for (let cp = 0x0041; cp <= 0x005A; cp++) {
  const it = byIndex.get(cp);
  if (!it) continue;
  const k = (it.vert?.y ?? 0).toFixed(6);
  if (!latMap.has(k)) latMap.set(k, []);
  latMap.get(k).push(String.fromCodePoint(cp));
}
for (const [k, chs] of latMap.entries()) {
  console.log(`  y=${k}  ×${chs.length}  ${chs.join(" ")}`);
}
