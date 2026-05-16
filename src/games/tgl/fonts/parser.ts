// Типи для TGL Font asset JSON (експортується UABEA / AssetRipper).
// Координати в Unity bitmap-font: uv нормалізовані (0..1), vert у px відносно
// baseline. Y у Unity йде ВНИЗ — m_LineSpacing px між рядками.

export interface UvRect { x: number; y: number; width: number; height: number }
export interface VertRect { x: number; y: number; width: number; height: number }

export interface FontGlyph {
  index: number;
  uv: UvRect;
  vert: VertRect;
  advance: number;
  flipped?: boolean;
}

// Спрощений Unity Font dump. Зберігаємо всі поля для round-trip, але типізуємо
// тільки те, що читаємо в UI.
export interface FontDump {
  m_Name: string;
  m_FontSize?: number;
  m_LineSpacing?: number;
  m_AtlasWidth?: number;
  m_AtlasHeight?: number;
  m_Texture?: { m_FileID?: number; m_PathID?: number | string };
  m_CharacterRects: { Array: FontGlyph[] };
  m_FallbackFonts?: { Array: unknown[] };
  [k: string]: unknown;
}

const CYR_RANGES: Array<[number, number]> = [
  [0x0400, 0x04FF],
  [0x0500, 0x052F],
];
export function isCyrCp(cp: number): boolean {
  for (const [a, b] of CYR_RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
export function isLatinCp(cp: number): boolean {
  return (cp >= 0x0020 && cp <= 0x007E) || (cp >= 0x00A0 && cp <= 0x024F);
}
export function isCjkCp(cp: number): boolean {
  return (cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFF00 && cp <= 0xFFEF);
}

export interface ParsedFont {
  raw: string;          // оригінальний RAW текст JSON (PathID-safe)
  data: FontDump;       // typed view (m_PathID > 2^53 буде втрачено — це OK,
                        // бо ми НЕ серіалізуємо `data` цілком, а патчимо raw).
  glyphsByIndex: Map<number, FontGlyph>;
  atlasWidth: number;   // безпечні дефолти, якщо у dump'і не вказано
  atlasHeight: number;
  /** Зміщення секції m_CharacterRects у raw: [start, end] (для patch-save). */
  charsSection: { start: number; end: number } | null;
}

/** Знайти {…}-блок у raw, починаючи з позиції відкриваючої дужки. */
function findBalancedBlock(raw: string, openAt: number): number {
  if (raw.charCodeAt(openAt) !== 0x7B /* { */) return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openAt; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === 0x5C /* \\ */) { esc = true; continue; }
      if (ch === 0x22 /* " */) { inStr = false; }
      continue;
    }
    if (ch === 0x22) { inStr = true; continue; }
    if (ch === 0x7B) depth++;
    else if (ch === 0x7D /* } */) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseFontJson(raw: string): ParsedFont {
  const data = JSON.parse(raw) as FontDump;
  return wrapParsedFont(raw, data, null);
}

/**
 * Альтернатива parseFontJson: коли raw + data вже зпarseно у worker thread
 * (через дешевий main.cjs handler), будуємо ParsedFont без повторного JSON.parse
 * на стороні renderer'а.
 */
export function wrapParsedFont(
  raw: string,
  data: FontDump,
  charsSectionFromWorker: { start: number; end: number } | null,
): ParsedFont {
  const arr = data?.m_CharacterRects?.Array ?? [];
  const glyphsByIndex = new Map<number, FontGlyph>();
  for (const g of arr) {
    if (g && typeof g.index === "number") glyphsByIndex.set(g.index, g);
  }
  const aw = (data.m_AtlasWidth as number) || 2048;
  const ah = (data.m_AtlasHeight as number) || 2048;

  let charsSection = charsSectionFromWorker;
  if (!charsSection) {
    const keyRe = /"m_CharacterRects"\s*:\s*\{/g;
    const m = keyRe.exec(raw);
    if (m) {
      const openAt = m.index + m[0].length - 1;
      const closeAt = findBalancedBlock(raw, openAt);
      if (closeAt > 0) charsSection = { start: openAt, end: closeAt };
    }
  }
  return { raw, data, glyphsByIndex, atlasWidth: aw, atlasHeight: ah, charsSection };
}

/**
 * Безпечний save: serialize ТІЛЬКИ m_CharacterRects і вшити її назад у raw.
 * Всі інші Int64 (m_PathID посилання) пишуться 1-в-1 як були. Якщо секцію
 * не знайшли — fallback на повний stringify (з ризиком втрати точності).
 */
export function serializeFontJson(parsed: ParsedFont): string {
  const newSection = JSON.stringify(
    { Array: parsed.data.m_CharacterRects.Array },
    null,
    2,
  );
  if (parsed.charsSection) {
    const { start, end } = parsed.charsSection;
    // Зберігаємо leading whitespace, не псуємо JSON-структуру.
    return parsed.raw.slice(0, start) + newSection + parsed.raw.slice(end + 1);
  }
  return JSON.stringify(parsed.data, null, 2);
}

export function charLabel(cp: number): string {
  if (cp < 0x20) return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  return String.fromCodePoint(cp);
}

// Латинський аналог для копіювання advance. Важливо: cyr lowercase
// часто виглядає як latin CAPITAL (м→M, н→H, т→T, в→B). Мапуємо за
// візуальною подібністю, інакше advance виходить занадто вузьким.
export const CYR_LATIN_PAIRS: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O",
  "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I", "Ї": "Ï",
  "Є": "E", "Ё": "E", "З": "3",
  // lowercase cyrillic ↔ latin "look-alike" (часто це capital):
  "а": "a", "в": "B", "е": "e", "к": "k", "м": "M", "н": "H", "о": "o",
  "р": "p", "с": "c", "т": "T", "х": "x", "у": "y", "і": "i", "ї": "ï",
  "є": "e", "ё": "e",
};

export interface NormalizeStats {
  touched: number;
  paired: number;
  fit: number;
  details: Array<{ cp: number; ch: string; before: number; after: number; how: string }>;
}

/**
 * Кирилиця → uniform proportional advance: `vw + 1` для кожної літери,
 * без жодних pair-copy. Pair-логіка раніше копіювала з latin "k"=18,
 * "m"=25, "e"=17 — гліфи однакової візуальної ширини отримували різні
 * advance і текст виглядав нерівно. `vw + 1` дає консистентний ритм
 * (1px проміжку справа кожної літери).
 */
export function normalizeCyrillic(parsed: ParsedFont): NormalizeStats {
  const stats: NormalizeStats = { touched: 0, paired: 0, fit: 0, details: [] };
  for (const g of parsed.data.m_CharacterRects.Array) {
    const cp = g.index;
    if (!isCyrCp(cp)) continue;
    const ch = String.fromCodePoint(cp);
    const before = g.advance;
    const vw = Math.abs(g.vert?.width ?? 0);
    const after = Math.max(8, Math.round(vw + 1));
    const how = "fit";
    if (after !== before) {
      g.advance = after;
      stats.touched++;
      if (how.startsWith("pair")) stats.paired++; else stats.fit++;
      if (stats.details.length < 100) stats.details.push({ cp, ch, before, after, how });
    }
  }
  return stats;
}

/** Скопіювати усі поля гліфа (uv/vert/advance) з іншого. Для add-glyph. */
export function cloneGlyphAttributes(src: FontGlyph): Omit<FontGlyph, "index"> {
  return {
    uv: { ...src.uv },
    vert: { ...src.vert },
    advance: src.advance,
    flipped: src.flipped,
  };
}
