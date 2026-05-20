// Парсер бінарного формату The Good Life (StreamingAssets/loc/English).
//
// Формат: uint32 LE count, потім N разів:
//   uint64 LE key, 7-bit-encoded UTF-8 byte length, UTF-8 bytes.
//
// Енкод/декод тут — для UI; реальна робота з диском відбувається в
// electron/main.cjs (handlers dp2:tgl-load / tgl-pack), бо бінарка живе на
// файловій системі, а Renderer'у бінарні шляхи прокидати не треба.

export interface TglRecord {
  i: number;
  key: string; // hex 16-char
  en: string;
}

export interface TglEntry {
  /** Стабільна позиція у файлі (= ключ для статусів/закладок). */
  index: number;
  /** 16-hex key з бінарки — для діагностики. */
  key: string;
  original: string;
  ua: string;
}

const HAS_CYR = /[Ѐ-ӿ]/;
const HAS_LAT = /[A-Za-z]/;
const HAS_LETTERS = /[A-Za-zЀ-ӿ]/;

export function flattenTgl(records: TglRecord[], uaTexts?: string[]): TglEntry[] {
  return records.map((r, i) => ({
    index: i,
    key: r.key,
    original: r.en,
    ua: uaTexts && i < uaTexts.length ? uaTexts[i] : r.en,
  }));
}

// «Системний» рядок — placeholder-прочерк (`-`, `--`, `---` тощо) або
// тільки Unity-теги. Гра ставить такі як no-op-розділювачі — їх неможливо
// перекласти, тому рахуємо як готові одразу.
export function isTglSystemRow(original: string): boolean {
  if (!original) return true;
  const stripped = original.replace(/<[^>]+>/g, "").trim();
  if (stripped.length === 0) return true;
  if (/^-+$/.test(stripped)) return true;
  return false;
}

export function isTglTranslated(e: TglEntry): boolean {
  if (isTglSystemRow(e.original)) return true;
  if (!e.ua || e.ua === e.original) return false;
  return HAS_CYR.test(e.ua);
}

const TAG_PATTERNS: RegExp[] = [
  /\[c="[^"]*"\]/g, /\[\/c\]/g,
  /\[shop="[^"]*"\/\]/g, /\[fragrance="[^"]*"\/\]/g, /\[control="[^"]*"\/\]/g,
  /\\control\{[^}]*\}/g, /\{\d+\}/g,
  /\[\/?(?:b|i|f1|f2|f3|f4|f5|randx|randy|hop|distort|stretch|fade|wavex|blink)\]/g,
  /\[Job\]/g,
];
function stripTags(s: string): string {
  let cur = s;
  for (const re of TAG_PATTERNS) cur = cur.replace(re, "");
  return cur;
}

export interface TglStats {
  totalLines: number;
  uaLines: number;
  enLines: number;
  uaWords: number;
  enWords: number;
  uaPercent: number;
}
export function tglStats(entries: TglEntry[]): TglStats {
  let total = 0, uaL = 0, enL = 0, uaW = 0, enW = 0;
  for (const e of entries) {
    const raw = e.ua || e.original || "";
    const clean = stripTags(raw).replace(/\s+/g, " ").trim();
    if (!clean || !HAS_LETTERS.test(clean)) continue;
    const isUa = HAS_CYR.test(clean);
    const isEn = !isUa && HAS_LAT.test(clean);
    if (!isUa && !isEn) continue;
    total++;
    const tokens = clean.split(" ").filter((w) => HAS_LETTERS.test(w));
    if (isUa) { uaL++; uaW += tokens.length; }
    else { enL++; enW += tokens.length; }
  }
  const pct = total ? +(uaL / total * 100).toFixed(2) : 0;
  return { totalLines: total, uaLines: uaL, enLines: enL, uaWords: uaW, enWords: enW, uaPercent: pct };
}

// Розбіжності парних тегів у перекладі — для діагностики у редакторі.
const PAIRED_TAGS = [
  "c", "b", "i", "f1", "f2", "f3", "f4", "f5",
  "randx", "randy", "hop", "distort", "stretch", "fade", "wavex", "blink",
];

// ───── TXT codec (1 рядок = 1 запис, сумісний з Parser_loc_GoodLife.exe) ─────
// Усередині рядка ескейпимо: "\\" → "\\\\", CR → "\\r", LF → "\\n".

export function tglEscapeForTxt(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") out += "\\\\";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\n") out += "\\n";
    else out += ch;
  }
  return out;
}
export function tglUnescapeFromTxt(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const nxt = s[i + 1];
      if (nxt === "\\") { out += "\\"; i++; }
      else if (nxt === "r") { out += "\r"; i++; }
      else if (nxt === "n") { out += "\n"; i++; }
      else { out += ch; }
    } else {
      out += ch;
    }
  }
  return out;
}
export function tglTxtToLines(txt: string): string[] {
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  if (txt.endsWith("\r\n")) txt = txt.slice(0, -2);
  else if (txt.endsWith("\n")) txt = txt.slice(0, -1);
  return txt.split(/\r\n|\r|\n/);
}

export function tagBalance(text: string): Array<{ tag: string; opens: number; closes: number }> {
  const out: Array<{ tag: string; opens: number; closes: number }> = [];
  for (const t of PAIRED_TAGS) {
    // [c="..."] — є аргумент; рахуємо всі відкриваючі (з атрибутами теж).
    const openRe = t === "c"
      ? /\[c="[^"]*"\]/g
      : new RegExp(`\\[${t}\\]`, "g");
    const closeRe = new RegExp(`\\[\\/${t}\\]`, "g");
    const opens = (text.match(openRe) || []).length;
    const closes = (text.match(closeRe) || []).length;
    if (opens || closes) out.push({ tag: t, opens, closes });
  }
  return out;
}
