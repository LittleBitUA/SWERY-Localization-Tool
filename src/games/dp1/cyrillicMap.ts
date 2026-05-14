// Мапа підміни кирилиці на латинські/розширені гліфи — портовано з rename.py
// (E:\Localization\DP1\DPMsgTool\rename.py).
// Гра малює спецшрифт у fontwide.xpc, де ці гліфи перевизначено на українські букви.

export const CYRILLIC_REPLACEMENTS: Record<string, string> = {
  // Англ-подібні
  "О": "O", "о": "o", "А": "A", "а": "a", "Р": "P", "р": "p",
  "С": "C", "с": "c", "М": "M", "В": "B", "Е": "E", "е": "e",
  "Н": "H", "Т": "T", "І": "I", "і": "i", "Ї": "Í", "ї": "ï",
  "Х": "X", "х": "x", "у": "y",
  // Спец-маппінг (переадресовано на акцентовані латинські)
  "Б": "Ô", "Г": "¿", "Ґ": "Ù", "Д": "Á", "Є": "Â", "Ж": "Ã",
  "З": "Ä", "И": "Å", "Й": "Æ", "К": "Ç", "Л": "È", "П": "É",
  "У": "Ê", "Ф": "Ë", "Ц": "Ì", "Ч": "Î", "Ш": "Ï", "Щ": "Ð",
  "Ь": "Ñ", "Ю": "Ò", "Я": "Ó",
  "б": "à", "в": "á", "г": "â", "ґ": "ã", "д": "ä", "є": "å",
  "ж": "æ", "з": "ç", "и": "è", "й": "é", "к": "ê", "л": "ë",
  "м": "ì", "н": "í", "п": "î", "т": "ú", "ф": "ñ", "ц": "ò",
  "ч": "ó", "ш": "ô", "щ": "õ", "я": "ù", "ю": "ø", "ь": "û",
  // Пунктуація
  "—": "Ú", "’": "'",
};

/** Застосувати правила підміни. Симетрично перекладному рядку перед pack. */
export function applyCyrillicSubstitution(text: string): string {
  if (!text) return text;
  let out = "";
  for (const ch of text) {
    out += CYRILLIC_REPLACEMENTS[ch] ?? ch;
  }
  return out;
}

export interface UnsupportedChar {
  ch: string;
  /** Зміщення (UTF-16 code units) у вхідному рядку. */
  index: number;
  /** Кодпойнт (Unicode). */
  codepoint: number;
}

/**
 * Знайти символи, які DP1-шрифт НЕ намалює:
 *   • не ASCII (0x20..0x7E),
 *   • не whitespace (TAB/LF/CR),
 *   • не входять у CYRILLIC_REPLACEMENTS.
 *
 * У грі такий символ буде як пустий квадрат або інший латинський глиф —
 * чиста production-помилка локалізатора.
 */
export function findUnsupportedChars(text: string): UnsupportedChar[] {
  if (!text) return [];
  const out: UnsupportedChar[] = [];
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isAsciiPrintable = cp >= 0x20 && cp <= 0x7E;
    const isWhitespace = cp === 0x09 || cp === 0x0A || cp === 0x0D;
    const isMapped = Object.prototype.hasOwnProperty.call(CYRILLIC_REPLACEMENTS, ch);
    if (!isAsciiPrintable && !isWhitespace && !isMapped) {
      out.push({ ch, index: i, codepoint: cp });
    }
    i += ch.length; // surrogate-pair safe
  }
  return out;
}

/** Switch-friendly зведення (true якщо нема жодного непідтриманого символу). */
export function isFullyMapped(text: string): boolean {
  return findUnsupportedChars(text).length === 0;
}

/** Виставити Monaco-маркери для непідтриманих символів. Окремий "owner" — щоб
 *  не накладалися з setTagDiagnostics (теги). */
export function setGlyphDiagnostics(monaco: any, editor: any, text: string) {
  const model = editor.getModel?.();
  if (!model) return;
  const bad = findUnsupportedChars(text);
  const markers = bad.map(({ ch, index, codepoint }) => {
    const startPos = model.getPositionAt(index);
    const endPos = model.getPositionAt(index + ch.length);
    return {
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
      message:
        `Символ '${ch}' (U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}) ` +
        `не входить у DP1-мапу гліфів — у грі не намалюється.`,
    };
  });
  monaco.editor.setModelMarkers(model, "dp1-glyph", markers);
}
