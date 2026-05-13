// Парсер DP1 .mes JSON-дампів від DPMsgTool by MrIkso.
// Формат: плоский масив записів з полями Id1/Id2/Flag1/Flag2/FirstSegmentLenght/Text/EmptyRecord.

export interface Dp1Record {
  Id1: number;
  Id2: number;
  Flag1: number;
  Flag2: number;
  FirstSegmentLenght: number;
  Text: string;
  EmptyRecord: boolean;
  // Інші поля невідомого формату пропускаємо без втрат через явні copy.
  [k: string]: unknown;
}

export interface Dp1Entry {
  /** Індекс у масиві records (= ключ для збереження). */
  index: number;
  id: string; // "Id1/Id2" — короткий показ
  flags: string; // "Flag1/Flag2"
  /** Оригінальний англійський (з eng.json). */
  original: string;
  /** Поточний переклад (storage form з \n). */
  ua: string;
  /** Чи EmptyRecord (службовий, не показуємо). */
  empty: boolean;
}

const RE_CURLY = /\{[^{}]*\}/g;
const HAS_CYR = /[Ѐ-ӿ]/;
const HAS_LAT = /[A-Za-z]/;
const HAS_LETTERS = /[A-Za-zЀ-ӿ]/;

export function flattenDp1(records: Dp1Record[], uaTexts?: string[]): Dp1Entry[] {
  return records.map((r, i) => ({
    index: i,
    id: `${r.Id1}/${r.Id2}`,
    flags: `${r.Flag1}/${r.Flag2}`,
    original: String(r.Text ?? ""),
    ua: uaTexts && i < uaTexts.length ? uaTexts[i] : String(r.Text ?? ""),
    empty: !!r.EmptyRecord,
  }));
}

/** Запис вважається перекладеним, якщо UA-текст НЕ збігається з оригіналом і містить кирилицю. */
export function isDp1Translated(e: Dp1Entry): boolean {
  if (e.empty) return false;
  if (!e.ua || e.ua === e.original) return false;
  return HAS_CYR.test(e.ua);
}

function stripBracesRecursive(s: string): string {
  let prev: string | null = null;
  let cur = s;
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(RE_CURLY, "");
  }
  return cur;
}

/** Метрики готовності (порт логіки з EDITOR.py: readiness_from_current). */
export interface Dp1Stats {
  totalLines: number;
  uaLines: number;
  enLines: number;
  uaWords: number;
  enWords: number;
  uaPercent: number;
}

export function dp1Stats(entries: Dp1Entry[]): Dp1Stats {
  let total = 0;
  let uaL = 0;
  let enL = 0;
  let uaW = 0;
  let enW = 0;
  for (const e of entries) {
    if (e.empty) continue;
    const raw = e.ua || e.original || "";
    const clean = stripBracesRecursive(raw).replace(/\s+/g, " ").trim();
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

/**
 * Згенерувати _ua_done.json (масив records з підміненим Text на UA, якщо є).
 * Інші поля копіюються 1:1.
 */
export function buildDoneRecords(records: Dp1Record[], uaTexts: string[]): Dp1Record[] {
  return records.map((r, i) => {
    const ua = i < uaTexts.length ? uaTexts[i] : "";
    if (ua && ua.trim()) return { ...r, Text: ua };
    return r;
  });
}

/** Прості перетворення відображення \n ↔ зберігання. */
export function displayToStorage(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n");
}

export function storageToDisplay(s: string, showNewlines: boolean): string {
  if (!showNewlines) return s;
  return s.replace(/\\r\\n/g, "\r\n").replace(/\\n/g, "\n");
}

export function bracesBalanced(s: string): boolean {
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  return opens === closes;
}
