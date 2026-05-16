// Реєстрація мови "dp-text" у Monaco з підсвічуванням плейсхолдерів
// {NEXT_SEGMENT}, <color=...>, [icon], {0}, \n тощо. Викликається один раз
// при першому mount будь-якого редактора через registerDpTextLanguage(monaco).

let registered = false;

export function registerDpTextLanguage(monaco: any) {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: "dp-text" });

  monaco.languages.setMonarchTokensProvider("dp-text", {
    tokenizer: {
      root: [
        // TGL: \control{08}, \something{value} — підсвічуємо як bracket-control.
        [/\\[a-zA-Z]+\{[^}]*\}/, "dp.control"],
        // {NEXT_SEGMENT}, {NEXT_FRAME id=0, letters=0}, {NO_OP:0xFFF5}, {ICON id=0}, {0}, {color=red}
        [/\{[^{}]*\}/, "dp.curly"],
        // <i>, </i>, <color=red>, </color>, <br>, etc.
        [/<\/?[a-zA-Z][^<>]*>/, "dp.angle"],
        // [icon], [pad], [c="..."]...[/c], [shop="..."/] тощо.
        [/\[[^\[\]\n]+\]/, "dp.bracket"],
        // \n, \r, \t, \\
        [/\\[nrt\\]/, "dp.escape"],
      ],
    },
  });
}

/** Кольори токенів. Реєструємо разом з темою dp2-dark у editor.defineTheme. */
export const DP_TOKEN_RULES = [
  { token: "dp.curly", foreground: "f0b429", fontStyle: "bold" },    // burnt amber
  { token: "dp.angle", foreground: "ff7b72" },                       // soft red
  { token: "dp.bracket", foreground: "79c0ff" },                     // light blue
  { token: "dp.escape", foreground: "d2a8ff", fontStyle: "bold" },   // purple
  { token: "dp.control", foreground: "7ee787", fontStyle: "bold" },  // green — для \control{NN}
];

// Порядок важливий: \control{...} матчиться раніше, ніж самостійні {...} та \n.
const TAG_RE = /\\[a-zA-Z]+\{[^}]*\}|\{[^{}]*\}|<\/?[a-zA-Z][^<>]*>|\[[^\[\]\n]+\]|\\[nrt\\]/g;

export function extractTags(text: string): string[] {
  if (!text) return [];
  const m = text.match(TAG_RE);
  return m ? [...m] : [];
}

export interface TagDiff {
  /** Теги, які є в оригіналі, але втрачені у перекладі. */
  missing: string[];
  /** Теги, які додав перекладач, а в оригіналі їх не було. */
  extra: string[];
}

export function diffTags(original: string, translation: string): TagDiff {
  const o = extractTags(original);
  const t = extractTags(translation);
  const oCount: Record<string, number> = {};
  for (const tag of o) oCount[tag] = (oCount[tag] ?? 0) + 1;
  const tCount: Record<string, number> = {};
  for (const tag of t) tCount[tag] = (tCount[tag] ?? 0) + 1;
  const missing: string[] = [];
  const extra: string[] = [];
  for (const tag of Object.keys(oCount)) {
    const diff = (oCount[tag] ?? 0) - (tCount[tag] ?? 0);
    for (let i = 0; i < diff; i++) missing.push(tag);
  }
  for (const tag of Object.keys(tCount)) {
    const diff = (tCount[tag] ?? 0) - (oCount[tag] ?? 0);
    for (let i = 0; i < diff; i++) extra.push(tag);
  }
  return { missing, extra };
}

/**
 * Поставити Monaco markers (squiggles) для діагностики тегів.
 * Підкреслюємо позиції extra-тегів (червоним) і додаємо warning у заголовок
 * перших рядків, якщо є missing.
 */
export function setTagDiagnostics(
  monaco: any,
  editor: any,
  original: string,
  translation: string
) {
  const model = editor.getModel?.();
  if (!model) return;
  const { missing, extra } = diffTags(original, translation);
  const markers: any[] = [];

  // Підкреслюємо extra-теги в тексті як warning.
  if (extra.length) {
    for (const tag of extra) {
      const idx = translation.indexOf(tag);
      if (idx < 0) continue;
      const startPos = model.getPositionAt(idx);
      const endPos = model.getPositionAt(idx + tag.length);
      markers.push({
        severity: monaco.MarkerSeverity.Warning,
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
        message: `Тег '${tag}' відсутній у оригіналі`,
      });
    }
  }

  // Для missing — додаємо маркер на 1-й рядок.
  if (missing.length) {
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: Math.max(2, model.getLineMaxColumn(1)),
      message: `Втрачено теги з оригіналу: ${missing.join(", ")}`,
    });
  }

  monaco.editor.setModelMarkers(model, "dp-text", markers);
}
