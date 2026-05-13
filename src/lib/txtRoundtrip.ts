// Експорт/імпорт текстів у .txt для зовнішнього перекладу і повернення.
//
// Формат блоку:
//   ### N          ← маркер з порядковим номером запису у поточному файлі
//   Speaker:        ← опційний (для sentence з charaName або item з itemName)
//   Текст рядок 1
//   Текст рядок 2
//   <blank line>    ← розділювач блоків
//
// Літеральні `\n` у JSON-записах перетворюються на справжні переноси у .txt
// (зручніше для людини). При імпорті — навпаки.

// Маркер: рядок починається з `###`, далі (опційно через пробіл) число.
// Дозволяємо хвіст на кшталт " — line_001" — він іде як коментар і не використовується.
const BLOCK_RE = /^\s*###\s*(\d+)\b/;

export interface ParsedBlock {
  index: number;       // 1-based номер з маркера
  speaker?: string;    // те, що до двокрапки у першому рядку (опційно)
  text: string;        // багаторядковий текст з реальними \n
}

/**
 * Round-trip safe escape для .txt.
 *
 * Текст у store вже містить РЕАЛЬНІ переноси рядків (бо JSON.parse розгортає
 * `\n`-escape з ігрового JSON). При експорті:
 *   • leading/trailing real `\n` → залишаємо як ЛІТЕРАЛЬНИЙ `\n` (2 символи),
 *     щоб порожні рядки на краях не сплуталися з cosmetic-розділювачами .txt;
 *   • внутрішні real `\n` — пишемо як справжні переноси, щоб людині було
 *     читабельно (текст займає кілька рядків у .txt).
 *
 * Приклад: оригінал у JSON `"\nThompsonville\nA suburb of Boston, MA"` стає
 *   \nThompsonville
 *   A suburb of Boston, MA
 */
function escapeForTxt(s: string): string {
  if (!s) return "";
  let leading = 0;
  while (s.startsWith("\n")) { leading++; s = s.slice(1); }
  let trailing = 0;
  while (s.endsWith("\n")) { trailing++; s = s.slice(0, -1); }
  return "\\n".repeat(leading) + s + "\\n".repeat(trailing);
}

function unescapeFromTxt(s: string): string {
  if (!s) return "";
  // 1) Нормалізуємо CRLF/CR → LF (справжні переноси з редактора).
  // 2) `\n` (2 символи) → real `\n`.  Аналогічно `\r`.
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
          .replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

export interface ExportEntry {
  /** 1-based позиція у файлі. */
  index: number;
  speaker?: string;
  text: string;
  /** Опційний коментар у заголовку блока (id/category). */
  hint?: string;
}

export function buildTxt(header: string, entries: ExportEntry[]): string {
  const out: string[] = [];
  if (header) {
    out.push(`# ${header}`);
    out.push(
      "# Format: blocks separated by blank line; '### N' = entry index (don't change!);",
      "# 'Speaker:' line is optional. Real line breaks inside text are preserved."
    );
    out.push("");
  }
  for (const e of entries) {
    out.push(`### ${e.index}${e.hint ? "  — " + e.hint : ""}`);
    if (e.speaker !== undefined && e.speaker !== null && e.speaker !== "") {
      out.push(`${e.speaker}:`);
    }
    out.push(escapeForTxt(e.text || ""));
    out.push("");
  }
  return out.join("\n");
}

export function parseTxt(raw: string): ParsedBlock[] {
  // Прибираємо BOM на початку файла, якщо він є.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const lines = raw.split(/\r?\n/);
  const blocks: ParsedBlock[] = [];
  let cur: ParsedBlock | null = null;
  let curTextLines: string[] = [];

  // FSM-фази в межах блока:
  //   "header"       — щойно зустрівся `### N`, чекаємо speaker або початок тексту
  //   "afterSpeaker" — speaker уже зчитано, чекаємо першого непорожнього рядка тексту
  //   "text"         — пишемо текст; порожні рядки всередині зберігаються
  type Phase = "header" | "afterSpeaker" | "text";
  let phase: Phase = "header";

  function flushBlock() {
    if (!cur) return;
    // Trim leading + trailing blank lines у тексті — вони службові, не вмісту.
    while (curTextLines.length && curTextLines[0] === "") curTextLines.shift();
    while (curTextLines.length && curTextLines[curTextLines.length - 1] === "") curTextLines.pop();
    cur.text = curTextLines.join("\n");
    blocks.push(cur);
    cur = null;
    curTextLines = [];
  }

  for (const ln of lines) {
    const m = ln.match(BLOCK_RE);
    if (m) {
      flushBlock();
      cur = { index: parseInt(m[1], 10), text: "" };
      curTextLines = [];
      phase = "header";
      continue;
    }
    if (!cur) {
      // Преамбула до першого блока — ігноруємо.
      continue;
    }

    if (phase === "header") {
      if (ln.trim() === "") continue; // leading blanks між маркером і вмістом
      const speakerMatch = ln.match(/^([^:\n]{1,80}):\s*$/);
      if (speakerMatch) {
        cur.speaker = speakerMatch[1].trim();
        phase = "afterSpeaker";
        continue;
      }
      // Нема speaker — це вже частина тексту.
      curTextLines.push(ln);
      phase = "text";
      continue;
    }

    if (phase === "afterSpeaker") {
      if (ln.trim() === "") continue; // blank lines між speaker і текстом
      curTextLines.push(ln);
      phase = "text";
      continue;
    }

    // phase === "text"
    curTextLines.push(ln);
  }
  flushBlock();
  return blocks;
}

/** Перетворити parsed-блок у storage-форму JSON-запису. */
export function blockToStorage(block: ParsedBlock): { speaker?: string; text: string } {
  return {
    speaker: block.speaker,
    text: unescapeFromTxt(block.text),
  };
}
