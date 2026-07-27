#!/usr/bin/env node
// i18n-гард: перевіряє src/lib/i18n.ts та всі літеральні t("...") виклики.
//  1) Паритет UK↔EN (кожен ключ має існувати в обох словниках)
//  2) Немає дублікатів ключів усередині словника
//  3) Кожен літеральний t("key")/tStatic("key") у коді існує у словнику
//     (інакше в UI показався б сирий ключ замість перекладу)
// Виходить з кодом 1 при будь-якій проблемі — придатне для CI.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const I18N = path.join(ROOT, "src", "lib", "i18n.ts");

// Ключі, що навмисно живуть лише в UK-блоці (перемикач мови показує назву
// цільової мови незалежно від поточної; t() падає на UK для обох).
const CROSS_LANG_ONLY = new Set(["lang.switchToEn", "lang.switchToUk"]);

const src = fs.readFileSync(I18N, "utf8").split(/\r?\n/);
const ukStart = src.findIndex((l) => /^const UK: Dict = \{/.test(l));
const enStart = src.findIndex((l) => /^const EN: Dict = \{/.test(l));
if (ukStart < 0 || enStart < 0) { console.error("i18n-check: не знайдено блоки UK/EN"); process.exit(2); }
const ukEnd = src.findIndex((l, i) => i > ukStart && /^\};/.test(l));
const enEnd = src.findIndex((l, i) => i > enStart && /^\};/.test(l));

function collect(a, b, label) {
  const set = new Set();
  const dups = [];
  for (let i = a + 1; i < b; i++) {
    const m = src[i].match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/);
    if (!m) continue;
    if (set.has(m[1])) dups.push({ key: m[1], line: i + 1 });
    set.add(m[1]);
  }
  return { set, dups, label };
}
const uk = collect(ukStart, enStart, "UK");
const en = collect(enStart, enEnd, "EN");

let problems = 0;

// 1) паритет
const missingEn = [...uk.set].filter((k) => !en.set.has(k) && !CROSS_LANG_ONLY.has(k));
const missingUk = [...en.set].filter((k) => !uk.set.has(k));
if (missingEn.length) { problems++; console.error(`✗ ${missingEn.length} ключів є в UK, але відсутні в EN:\n  ` + missingEn.join("\n  ")); }
if (missingUk.length) { problems++; console.error(`✗ ${missingUk.length} ключів є в EN, але відсутні в UK:\n  ` + missingUk.join("\n  ")); }

// 2) дублікати
for (const d of [uk, en]) {
  if (d.dups.length) { problems++; console.error(`✗ ${d.label} має дублікати ключів:\n  ` + d.dups.map((x) => `${x.key} (рядок ${x.line})`).join("\n  ")); }
}

// 3) keycheck: усі літеральні t("...") існують у словнику
let files = [];
try {
  files = cp.execSync('git -C "' + ROOT + '" ls-files "src/**/*.tsx" "src/**/*.ts"', { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
} catch { files = []; }
const RE = /\bt(?:Static)?\(\s*"((?:[^"\\]|\\.)*)"/g;
const missingKeys = {};
for (const f of files) {
  let txt; try { txt = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
  let m;
  while ((m = RE.exec(txt))) {
    const key = m[1];
    if (key.endsWith(".")) continue;         // динамічний префікс: t("status." + x)
    if (uk.set.has(key)) continue;
    (missingKeys[f] ||= new Set()).add(key);
  }
}
const missFiles = Object.keys(missingKeys);
if (missFiles.length) {
  problems++;
  console.error("✗ літеральні t()-ключі, яких немає у словнику (покажуть сирий ключ):");
  for (const f of missFiles) console.error(`  ${f} -> ${[...missingKeys[f]].join(", ")}`);
}

if (problems === 0) {
  console.log(`✓ i18n OK — UK: ${uk.set.size}, EN: ${en.set.size}, паритет повний, дублікатів немає, усі літеральні ключі резолвляться.`);
  process.exit(0);
}
console.error(`\ni18n-check провалено: ${problems} проблем(и).`);
process.exit(1);
