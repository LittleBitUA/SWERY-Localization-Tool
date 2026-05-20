// HBR text parser. MonoBehaviour-JSON має структуру:
//   { m_Name, _ListName, _List: { Array: [
//       { _TextId, _Id, _Texts: { Array: [{ _Text: "..." }, ...] } }
//   ]}}
// Зазвичай 5 варіантів _Text на запис (per-character або per-difficulty).
// Локалізуємо ВСІ — у редакторі покажемо як окремі рядки.

export interface HbrTextItem {
  textId: string;       // _TextId — стабільний ID запису
  variantIdx: number;   // індекс у _Texts.Array
  original: string;     // EN-оригінал (з Original/)
  current: string;      // поточне значення у Done/ (може бути перекладеним)
  listIdx: number;      // індекс у _List.Array
}

// «Системні» рядки — ті, що НЕ переводяться в принципі, бо в них нема тексту:
//   • тільки Unity-TMP теги типу `<space=0em>`, `<br/>`, `<color=red>…</color>`
//     (після видалення тегів лишається порожній рядок);
//   • placeholder-прочерк типу `-`, `--`, `---`.
// Такі ряди має зараховуватись як "translated" автоматично — інакше прогрес
// застрягає на 99% через сотні службових рядків, які перекладати нічим.
export function isHbrSystemRow(original: string): boolean {
  if (!original) return true;
  const stripped = original.replace(/<[^>]+>/g, "").trim();
  if (stripped.length === 0) return true;
  if (/^-+$/.test(stripped)) return true;
  return false;
}

// Витягуємо набір службових маркерів з тексту для valid-check.
// Формат: placeholders `{0}`, `{name}`, `${var}`; HTML/inline tags `<color=...>`,
// `</color>`; control sequences `\n`, `\r\n`; bracket-controls `[c="..."]`,
// `[/c]`, `[Job]`, тощо (типові для Unity-локалізацій).
const PLACEHOLDER_RES = [
  /\{[A-Za-z0-9_]+\}/g,         // {0}, {name}
  /\$\{[^}]+\}/g,               // ${var}
  /<\/?[A-Za-z][^>]*>/g,        // <color=red>, </color>
  /\[\/?[A-Za-z][^\] ]*\]/g,    // [c="..."], [/c], [Job] — БЕЗ пробілу
                                //  всередині, інакше ловило б "[RATED R]"
                                //  (це звичайний текст, а не Unity-тег).
  /\\n/g, /\\r\\n/g,            // \n, \r\n у літералах
];
export function extractPlaceholders(s: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const re of PLACEHOLDER_RES) {
    const m = s.match(re);
    if (m) out.push(...m);
  }
  return out.sort();
}

// Перевіряє чи переклад зберіг усі службові маркери з оригіналу.
// Повертає список різниць (теги які зникли або з'явилися зайві).
export function validatePlaceholders(original: string, translated: string): { missing: string[]; extra: string[] } {
  const o = extractPlaceholders(original);
  const tr = extractPlaceholders(translated);
  const oCount = new Map<string, number>();
  const trCount = new Map<string, number>();
  for (const x of o)  oCount.set(x,  (oCount.get(x)  ?? 0) + 1);
  for (const x of tr) trCount.set(x, (trCount.get(x) ?? 0) + 1);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, v] of oCount) {
    const d = v - (trCount.get(k) ?? 0);
    for (let i = 0; i < d; i++) missing.push(k);
  }
  for (const [k, v] of trCount) {
    const d = v - (oCount.get(k) ?? 0);
    for (let i = 0; i < d; i++) extra.push(k);
  }
  return { missing, extra };
}

export interface HbrParsedFile {
  fileName: string;     // basename, для відображення
  donePath: string;
  origPath: string;
  m_Name: string;
  _ListName: string;
  items: HbrTextItem[];
  totalItems: number;
  translatedItems: number;
}

interface RawNode {
  m_Name?: string;
  _ListName?: string;
  _List?: { Array?: Array<{ _TextId?: string; _Id?: number; _Texts?: { Array?: Array<{ _Text?: string }> } }> };
}

export function parseHbrJson(raw: string, origRaw: string | null, donePath: string, origPath: string): HbrParsedFile {
  const data = JSON.parse(raw) as RawNode;
  const origData = origRaw ? (JSON.parse(origRaw) as RawNode) : null;
  const list = data._List?.Array ?? [];
  const origList = origData?._List?.Array ?? [];
  const items: HbrTextItem[] = [];
  let translated = 0;
  list.forEach((entry, listIdx) => {
    const textId = entry._TextId ?? `#${listIdx}`;
    const texts = entry._Texts?.Array ?? [];
    const origTexts = origList[listIdx]?._Texts?.Array ?? [];
    texts.forEach((t, vi) => {
      const cur = t._Text ?? "";
      const orig = origTexts[vi]?._Text ?? cur;
      if (cur !== orig && cur.trim().length > 0) translated++;
      items.push({
        textId, variantIdx: vi, original: orig, current: cur, listIdx,
      });
    });
  });
  return {
    fileName: donePath.split(/[\\/]/).pop() ?? donePath,
    donePath,
    origPath,
    m_Name: data.m_Name ?? "",
    _ListName: data._ListName ?? "",
    items,
    totalItems: items.length,
    translatedItems: translated,
  };
}

// Експорт у .txt — формат для зовнішнього редагування (CAT-tools / Notepad).
// Кожен запис відокремлений `### N — <textId> [vi]`, далі сам текст до
// наступного `###` або кінця файлу. Multiline текст підтримується.
export function formatHbrTxt(parsed: HbrParsedFile): string {
  const lines: string[] = [];
  lines.push(`# Hotel Barcelona TXT — ${parsed.fileName}`);
  lines.push(`# m_Name: ${parsed.m_Name}`);
  lines.push(`# Не міняй "### N — ..." рядки. Редагуй текст під ними.`);
  lines.push("");
  parsed.items.forEach((it, idx) => {
    lines.push(`### ${idx + 1}  —  ${it.textId}  [v${it.variantIdx}]`);
    lines.push(it.current);
    lines.push("");
  });
  return lines.join("\n");
}

// Парсимо .txt назад у map (idx → text). Не модифікуємо parsed напряму —
// caller сам обʼєднає й викличе applyHbrEdits.
export function parseHbrTxt(txt: string): Map<number, string> {
  const out = new Map<number, string>();
  // Розбиваємо за заголовками `### N ...`. Перший fragment — header
  // коментарі — пропускаємо.
  const re = /^###\s+(\d+)\s*[—–-].*$/gm;
  const matches: Array<{ idx: number; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) != null) {
    matches.push({ idx: parseInt(m[1], 10) - 1, start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : txt.length;
    let body = txt.slice(cur.end, nextStart);
    // Прибираємо leading-newlines одразу після header.
    body = body.replace(/^\r?\n/, "");
    // Прибираємо trailing blank lines перед наступним header.
    body = body.replace(/\r?\n\s*$/, "");
    out.set(cur.idx, body);
  }
  return out;
}

// Об'єднаний експорт усього проєкту у один великий TXT-файл.
//
// Формат:
//   # Заголовок-коментар проєкту
//
//   [<fileName>.json]
//
//   # <textId> [vN]
//   <text>
//
//   # <textId> [vN]
//   <text>
//   …
//
//   [<наступний файл>]
//   …
//
// `# textId [vN]` має бути СТАБІЛЬНИМ — парсер шукає рівно цей формат.
export function formatHbrCombinedTxt(files: HbrParsedFile[]): string {
  const lines: string[] = [];
  lines.push("# Hotel Barcelona — combined TXT export");
  lines.push("# Не міняй заголовки [...] і \"# ID [vN]\". Редагуй лише сам текст під ними.");
  lines.push("");
  for (const f of files) {
    lines.push(`[${f.fileName}]`);
    lines.push("");
    for (const it of f.items) {
      lines.push(`# ${it.textId} [v${it.variantIdx}]`);
      lines.push(it.current);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export interface CombinedTxtBlock {
  fileName: string;
  records: Map<string, string>; // key = "<textId>::<variantIdx>" → text
}
export interface CombinedTxtParseResult {
  blocks: CombinedTxtBlock[];
  warnings: string[];
}

// Парсимо combined-txt назад у блоки-перелік. Не аплікуємо нічого до файлів —
// caller сам викликає applyHbrEdits + IPC write для кожного DONE-файла.
export function parseHbrCombinedTxt(txt: string): CombinedTxtParseResult {
  const warnings: string[] = [];
  // Нормалізуємо CRLF → LF — інакше Windows writeFile додає \r, і порівняння
  // строк у applyCombinedToParsed дає false-positive «оновлено» на однаковому.
  txt = txt.replace(/\r\n/g, "\n");
  // Заголовок файлу: рядок `[<щось>.json]` без іншого вмісту. Без `.json`-
  // вимоги попередня версія ловила inline-теги `[Carnival Awakening]`,
  // `[Job]`, `[Dodge]` як ніби-заголовки → 50% записів пропадало.
  const headerRe = /^\[([^\]\r\n]+\.json)\]\s*$/gm;
  const headers: Array<{ name: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(txt)) != null) {
    headers.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  if (headers.length === 0) {
    warnings.push("У файлі не знайдено жодного заголовка [Filename]");
    return { blocks: [], warnings };
  }
  const blocks: CombinedTxtBlock[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const nextStart = i + 1 < headers.length ? headers[i + 1].start : txt.length;
    const body = txt.slice(cur.end, nextStart);
    const records = new Map<string, string>();
    // Розбиваємо тіло на записи за маркерами `# <id> [vN]`.
    const recRe = /^#\s+(.+?)\s+\[v(\d+)\]\s*$/gm;
    const recMatches: Array<{ id: string; vi: number; start: number; end: number }> = [];
    let rm: RegExpExecArray | null;
    while ((rm = recRe.exec(body)) != null) {
      recMatches.push({
        id: rm[1].trim(),
        vi: parseInt(rm[2], 10),
        start: rm.index,
        end: rm.index + rm[0].length,
      });
    }
    for (let j = 0; j < recMatches.length; j++) {
      const r = recMatches[j];
      const rNextStart = j + 1 < recMatches.length ? recMatches[j + 1].start : body.length;
      let text = body.slice(r.end, rNextStart);
      // Видаляємо рівно ОДИН leading newline (роздільник header→текст) та
      // ВСІ trailing newlines (sentinel між записами або кінець блоку).
      // Раніше regex `\r?\n\s*$` зрізав trailing whitespace ВСЕРЕДИНІ тексту,
      // що ламало round-trip — текст ставав «перекладеним» без редагування.
      text = text.replace(/^\r?\n/, "").replace(/\n+$/, "");
      const key = `${r.id}::${r.vi}`;
      if (records.has(key)) {
        warnings.push(`[${cur.name}] дубль запису ${key}`);
      }
      records.set(key, text);
    }
    blocks.push({ fileName: cur.name, records });
  }
  return { blocks, warnings };
}

// Накладає combined-txt-записи на parsed-файл (заміняє current у items за
// id+variantIdx). Повертає кількість оновлених + список незнайдених.
export function applyCombinedToParsed(
  parsed: HbrParsedFile,
  records: Map<string, string>,
): { updated: number; missing: string[] } {
  let updated = 0;
  const missing: string[] = [];
  // Нормалізатор для порівняння — максимально стійкий до round-trip
  // форматування (CRLF, standalone CR, BOM, trailing whitespace на рядках,
  // кінцеві newlines). Користувача цікавить ЗМІСТ перекладу, не форматування;
  // якщо різниця лише у whitespace — не записуємо як «оновлено».
  const norm = (s: string) => (s ?? "")
    .replace(/^﻿/, "")        // BOM
    .replace(/\r\n/g, "\n")         // CRLF → LF
    .replace(/\r/g, "\n")           // одиночні CR → LF
    .replace(/[ \t]+\n/g, "\n")     // trailing spaces у кожному рядку
    .replace(/[ \t]+$/, "")         // trailing spaces у кінці файлу
    .replace(/\n+$/, "");           // trailing newlines
  for (const it of parsed.items) {
    const key = `${it.textId}::${it.variantIdx}`;
    if (records.has(key)) {
      const v = records.get(key)!;
      if (norm(v) !== norm(it.current)) { it.current = v; updated++; }
    }
  }
  for (const key of records.keys()) {
    const found = parsed.items.some((it) => `${it.textId}::${it.variantIdx}` === key);
    if (!found) missing.push(key);
  }
  return { updated, missing };
}

// Серіалізує редаговані items назад у JSON.
//
// КРИТИЧНО: НЕ використовуємо JSON.parse + JSON.stringify, бо JS Number
// має лише 15-17 значущих цифр precision, а Unity PathID (m_Script тощо)
// можуть бути int64 з 19 цифрами — round-trip через JSON.parse округляє
// `-2774078311433900551` до `-2774078311433900500`. Це 2-байтова різниця
// у serialized bundle, через яку Unity не може завантажити MonoScript
// reference і вся гра зависає на завантаженні.
//
// Натомість — regex-replace _Text-значень у raw-стрінгу. Все інше (PathID,
// Hash, GUID, число-цілі) залишається байт-у-байт як у вихідному дампі.
export function applyHbrEdits(raw: string, items: HbrTextItem[]): string {
  // Порядок items відповідає порядку _Text у raw JSON: ми обходили
  // _List.Array у parseHbrJson послідовно, для кожного listIdx — всі
  // variantIdx по порядку. Така ж послідовність буде, коли проходитимем
  // raw regex'ом — _Text з'являються у тому ж порядку.
  //
  // КРИТИЧНО: цей контракт ламається, якщо після парсингу гра отримала патч
  // і кількість _Text у новому raw НЕ дорівнює items.length. Без цієї
  // перевірки запис мовчки зміщувався у "чужі" записи (i-й item писався
  // у (i+k)-й _Text). Тепер — explicit error до UI, користувач знає що
  // треба перевстановити extract.
  const re = /("_Text"\s*:\s*")((?:\\.|[^"\\])*)(")/g;
  const rawMatchCount = (raw.match(re) || []).length;
  if (rawMatchCount !== items.length) {
    throw new Error(
      `HBR _Text count mismatch: raw has ${rawMatchCount} _Text entries, ` +
      `but editor has ${items.length} items. Bundle likely changed since extract — ` +
      `re-run extract before saving.`
    );
  }
  const newTexts = items.map((it) => it.current);
  let idx = 0;
  return raw.replace(re, (full, prefix: string, _oldText: string, suffix: string) => {
    if (idx >= newTexts.length) return full;
    const escaped = JSON.stringify(newTexts[idx]).slice(1, -1); // прибираємо обрамлюючі лапки
    idx++;
    return prefix + escaped + suffix;
  });
}
