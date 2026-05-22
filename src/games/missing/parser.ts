// THE MISSING — парсер бінарного формату Unity TextAsset (`msg????en`).
//
// Файл, який віддає UABEA (Edit Data → Save Bin), має таку структуру:
//
//   ┌─ Unity TextAsset wrap (0x14 байт) ──────────────────────────┐
//   │ uint32 LE  nameLen                                          │
//   │ char[nameLen]  m_Name  ("msg0613en")                        │
//   │ pad to 4-byte alignment (зазвичай 3 байти 0x00)             │
//   │ uint32 LE  scriptLen                                         │
//   └─────────────────────────────────────────────────────────────┘
//   ┌─ m_Script payload (custom MSG format) ──────────────────────┐
//   │ 0x00  "MSG." magic                                          │
//   │ 0x04  uint32 section[0]   (раніше я думав = 0xca0)          │
//   │ 0x08  uint32 section[1]                                     │
//   │ 0x0C  uint32 lengthTableOffset    (вказує на length-table)  │
//   │ 0x10  uint32 stringOffsetTable    (offset-table першої секції)│
//   │ 0x14  uint32 stringBase           (string blob)             │
//   │ 0x18  uint32 stringOffsetTable2   (для msg-файлів з 2 секц.)│
//   │ 0x1C  uint32 stringBase2 / EOF                              │
//   │ 0x20..0x2C  чотири int32 (службові, рівні 0x42 у msg0613)   │
//   │ 0x2C  uint32 lengthCount                                    │
//   │ 0x30  uint32 stringCount                                    │
//   │ 0x34  uint32 stringCount2                                   │
//   │ 0x38..  ще hex-параметри (msgEnum-база, прапори тощо)       │
//   │ ...                                                          │
//   │ lengthTable:   lengthCount × 16 байт                        │
//   │   {int32 id, int16 length, int16 pad, ... — 10 байт зайвого}│
//   │ stringOffsetTable: stringCount × int32 (offset відносно базу)│
//   │ stringBase: null-terminated UTF-8 рядки                     │
//   └─────────────────────────────────────────────────────────────┘
//
// Offset, який бачить користувач у TF2-експорті (колонка `OFFSET`), — це
// АБСОЛЮТНА позиція null-terminated string у m_Script payload (тобто
// stringBase + offsetTable[i]). Без Unity wrap.

export interface MissingMsgEntry {
  /** Абсолютна позиція у m_Script (= stringBase + offsetTable[i]). НЕстабільна після pack. */
  offset: number;
  /** Текст у UTF-8 (без кінцевого \0). */
  text: string;
  /** Індекс у stringOffsetTable (стабільний у межах файлу). */
  index: number;
  /**
   * Канонічний глобальний enum для UI/combined.txt. Стабільний між extract'ами
   * для того ж m_Script: довжина рядка не впливає на length-table, а msgBase
   * лежить у header. Обчислюється: `msgBase * 10000 + min(i: lengthTable[i].stringIndex == index)`.
   * Якщо рядок не згаданий у length-table (рідкісно — лише сирітські) — -1.
   */
  msgEnum: number;
  /** Скільки слотів length-table посилаються на цей рядок (1 для звичайних, >1 — placeholder типу "NO_TEXT_en"). */
  enumCount: number;
}

export interface MissingMsgFile {
  /** m_Name (наприклад "msg0613en"). */
  name: string;
  /** msgEnum-база (з header offset 0x4C; для msg0613en = 613). */
  msgBase: number;
  /** Сирий m_Script payload (без Unity wrap) — потрібен для re-pack. */
  script: Uint8Array;
  /** Розпарсені рядки першої секції. */
  entries: MissingMsgEntry[];
  /** Розпарсені рядки другої секції (часто порожня). */
  entries2: MissingMsgEntry[];
  /** Header-поля для діагностики. */
  header: {
    lengthTableOffset: number;
    stringOffsetTable: number;
    stringBase: number;
    stringOffsetTable2: number;
    stringBase2: number;
    lengthCount: number;
    stringCount: number;
    stringCount2: number;
  };
}

const UTF8 = new TextDecoder("utf-8");

/**
 * Скидає Unity TextAsset wrap і повертає m_Name + m_Script payload.
 * Якщо `raw` уже починається з "MSG." — вважаємо що wrap'а нема, m_Name=??.
 */
export function stripUnityTextAssetWrap(raw: Uint8Array): { name: string; script: Uint8Array } {
  // Перевірка чи raw починається з магіка "MSG." (0x4D 0x53 0x47 0x2E).
  if (raw.length >= 4 && raw[0] === 0x4D && raw[1] === 0x53 && raw[2] === 0x47 && raw[3] === 0x2E) {
    return { name: "", script: raw };
  }
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const nameLen = v.getUint32(0, true);
  if (nameLen <= 0 || nameLen > 256) throw new Error(`Invalid TextAsset wrap: bad nameLen=${nameLen}`);
  const name = UTF8.decode(raw.subarray(4, 4 + nameLen));
  // 4-byte alignment після рядка.
  const afterName = 4 + nameLen;
  const padded = (afterName + 3) & ~3;
  const scriptLen = v.getUint32(padded, true);
  const scriptStart = padded + 4;
  if (scriptStart + scriptLen > raw.length) {
    throw new Error(`Invalid TextAsset wrap: scriptLen=${scriptLen} doesn't fit`);
  }
  const script = raw.subarray(scriptStart, scriptStart + scriptLen);
  if (script.length < 4 || script[0] !== 0x4D || script[1] !== 0x53 || script[2] !== 0x47 || script[3] !== 0x2E) {
    throw new Error(`m_Script does not start with "MSG." magic`);
  }
  return { name, script };
}

/** Читаємо null-terminated UTF-8 рядок із buf починаючи з position `pos`. */
function readCString(script: Uint8Array, pos: number): string {
  let end = pos;
  while (end < script.length && script[end] !== 0) end++;
  return UTF8.decode(script.subarray(pos, end));
}

// In-memory cache for parseMissingMsg. Ключ — path; signature — byteLength +
// перші/останні 8 байт (швидкий fingerprint, нульова ймовірність false-hit
// для випадкової зміни файла). refreshProjectStats / computeMissingCorpusStats
// тригеряться на КОЖНУ зміну rowMeta (bookmark/status toggle); без кешу гра
// перепарсувала всі 100 файлів за ~500ms × 100 = ~50s. З кешем — ~50ms на
// signature checks.
const msgCache = new Map<string, { sig: string; parsed: MissingMsgFile }>();

function fingerprintBytes(bytes: Uint8Array): string {
  const len = bytes.byteLength;
  // Перші 8 байт магії (MSG.) і header + останні 8 байт (зазвичай у null-block).
  const headLen = Math.min(8, len);
  const tailLen = Math.min(8, len);
  let head = ""; for (let i = 0; i < headLen; i++) head += bytes[i].toString(16).padStart(2, "0");
  let tail = ""; for (let i = len - tailLen; i < len; i++) tail += bytes[i].toString(16).padStart(2, "0");
  return `${len.toString(36)}:${head}:${tail}`;
}

/**
 * Закешований варіант parseMissingMsg. Викликати замість прямого parseMissingMsg
 * у місцях, які перепарсюють ОДИН І ТОЙ САМИЙ файл багато разів — stats refresh,
 * corpus stats, search modals. Інвалідація: автоматична через signature (size +
 * перші/останні 8 байт); якщо файл реально змінився — sig інший, cache miss.
 *
 * `path` — лише ключ; не зчитується. Caller відповідає за унікальність.
 */
export function parseMissingMsgCached(path: string, raw: Uint8Array): MissingMsgFile {
  const sig = fingerprintBytes(raw);
  const entry = msgCache.get(path);
  if (entry && entry.sig === sig) return entry.parsed;
  const parsed = parseMissingMsg(raw);
  msgCache.set(path, { sig, parsed });
  return parsed;
}

/** Очистити запис у кеші (викликати після save конкретного файла). */
export function invalidateMissingMsgCache(path: string): void {
  msgCache.delete(path);
}

/**
 * Парсимо MSG payload у плоский список entries. Не модифікуємо `script` —
 * caller може зберігати його для re-pack.
 */
export function parseMissingMsg(raw: Uint8Array): MissingMsgFile {
  const { name, script } = stripUnityTextAssetWrap(raw);
  if (script.length < 0x40) throw new Error(`m_Script too short: ${script.length}`);
  const v = new DataView(script.buffer, script.byteOffset, script.byteLength);

  const header = {
    lengthTableOffset: v.getUint32(0x0C, true),
    stringOffsetTable: v.getUint32(0x10, true),
    stringBase: v.getUint32(0x14, true),
    stringOffsetTable2: v.getUint32(0x18, true),
    stringBase2: v.getUint32(0x1C, true),
    lengthCount: v.getUint32(0x2C, true),
    stringCount: v.getUint32(0x30, true),
    stringCount2: v.getUint32(0x34, true),
  };

  // msgEnum-база. Спостереження для msg0613en: vec[0x38] = 0x265 = 613.
  const msgBase = v.getUint32(0x38, true);

  // Спочатку проходимо length-table і будуємо мапу index → [enumOffsets].
  // Length-table — це `enum → stringIndex` мапа: позиція i у таблиці = local
  // enum offset, поле +0 = stringIndex, що показувати. Один рядок може мати
  // кілька enum'ів (placeholder NO_TEXT_en — N посилань на одну string).
  const enumsByIndex = new Map<number, number[]>();
  for (let i = 0; i < header.lengthCount; i++) {
    const stringIndex = v.getInt32(header.lengthTableOffset + i * 16, true);
    if (stringIndex < 0) continue;
    const list = enumsByIndex.get(stringIndex);
    if (list) list.push(i);
    else enumsByIndex.set(stringIndex, [i]);
  }

  function readSection(offsetTable: number, base: number, count: number, useLengthTable: boolean): MissingMsgEntry[] {
    const out: MissingMsgEntry[] = [];
    for (let i = 0; i < count; i++) {
      const localOffset = v.getInt32(offsetTable + 4 * i, true);
      const absOffset = base + localOffset;
      const text = absOffset < 0 || absOffset >= script.length
        ? ""
        : readCString(script, absOffset);
      let msgEnum = -1;
      let enumCount = 0;
      if (useLengthTable) {
        const list = enumsByIndex.get(i);
        if (list && list.length > 0) {
          msgEnum = msgBase * 10000 + list[0];
          enumCount = list.length;
        }
      }
      out.push({ offset: absOffset, text, index: i, msgEnum, enumCount });
    }
    return out;
  }

  // Length-table описує лише першу секцію (offsetTable1/stringBase1). Друга
  // секція (V_EM_* у msg0101en) — це окремий enum-простір без length-table-
  // запису, тож msgEnum для них лишаємо -1.
  const entries = readSection(header.stringOffsetTable, header.stringBase, header.stringCount, true);
  const entries2 = header.stringCount2 > 0
    ? readSection(header.stringOffsetTable2, header.stringBase2, header.stringCount2, false)
    : [];

  return { name, msgBase, script, entries, entries2, header };
}

/**
 * Збирає новий m_Script payload із оновленими рядками.
 *
 * Контракт: викликач передає мапу `<index> → newText` для першої секції
 * (друга секція поки що НЕ редагується — використовуємо `entries2` без змін).
 * Решта файлу копіюється з оригіналу. Length-table (`int16 length` у кожному
 * 16-байт-записі) перераховується автоматично, бо TF2-формат вимагає її
 * синхронізації з реальною довжиною рядків.
 */
export function buildMissingMsg(
  original: MissingMsgFile,
  edits: Map<number, string>,
): Uint8Array {
  const enc = new TextEncoder();
  const src = original.script;
  const { stringOffsetTable, stringBase, lengthTableOffset, lengthCount, stringCount, stringOffsetTable2, stringBase2 } = original.header;

  // Готуємо нові рядки (з null-terminator на кінці).
  const newStrings: Uint8Array[] = original.entries.map((e, i) => {
    const txt = edits.has(i) ? (edits.get(i) ?? "") : e.text;
    const utf8 = enc.encode(txt);
    const out = new Uint8Array(utf8.length + 1);
    out.set(utf8, 0);
    out[utf8.length] = 0;
    return out;
  });

  // Розраховуємо нові offset'и у блок string blob (відносно stringBase).
  const newLocalOffsets: number[] = [];
  let cursor = 0;
  for (const s of newStrings) {
    newLocalOffsets.push(cursor);
    cursor += s.length;
  }
  const newStringBlobLen = cursor;

  // Розмір першої секції після string blob — те, що раніше було від stringBase
  // до stringOffsetTable2 (тобто включно з blob'ом + можливим padding'ом).
  // Тримаємо padding до 16 байт, як це робив TF2.
  const padded = (newStringBlobLen + 0xF) & ~0xF;
  const padding = padded - newStringBlobLen;
  const newStringBase2 = stringBase + padded;
  const oldStringBase2 = stringBase2;
  const tail = src.subarray(oldStringBase2); // друга секція + EOF як було

  const finalSize = stringBase + padded + tail.length;
  const out = new Uint8Array(finalSize);

  // 1. Копіюємо ВСЕ до stringBase з оригіналу (header + length-table + offset-table).
  out.set(src.subarray(0, stringBase), 0);
  const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // 2. Записуємо нові локальні offset'и в stringOffsetTable.
  for (let i = 0; i < stringCount; i++) {
    ov.setInt32(stringOffsetTable + 4 * i, newLocalOffsets[i], true);
  }

  // 3. Записуємо нові рядки у stringBase…
  let pos = stringBase;
  for (const s of newStrings) {
    out.set(s, pos);
    pos += s.length;
  }
  // padding до 16 (вже виділено finalSize'ом, лишаємо нулі)
  pos += padding;

  // 4. Копіюємо tail (друга секція + EOF) у нову позицію.
  out.set(tail, newStringBase2);

  // 5. Оновлюємо header.stringBase2 (зрушився, якщо blob змінив розмір).
  ov.setUint32(0x1C, newStringBase2, true);
  // Якщо була друга секція з offset-table, всі її offset'и відносні до
  // newStringBase2 — формат TF2 не зміщує їх, бо вони LOCAL. OK.

  // 6. Перераховуємо length-table (int16 length у кожному 16-байт-записі).
  //    TF2-формула: length = (newOutputOffset - outputOffset - 1).
  //    Тобто length = байт_рядка - 1 (без null-термінатора). Працює як для UTF-8.
  //
  //    КРИТИЧНО: формат тримає довжину у int16. Українські переклади у UTF-8
  //    займають ~2 байти на літеру, тож вже на ~16K символів int16 переповнюється.
  //    Раніше було console.warn + (len & 0xFFFF) — тиха корупція бінарника.
  //    Тепер кидаємо помилку до UI, щоб користувач побачив проблему перед паком.
  for (let li = 0; li < lengthCount; li++) {
    const recOff = lengthTableOffset + li * 16;
    const id = ov.getInt32(recOff, true);
    if (id >= 0 && id < stringCount) {
      const len = newStrings[id].length - 1; // без null
      if (len > 0x7fff) {
        const txt = original.entries[id]?.text ?? "";
        const preview = txt.slice(0, 60) + (txt.length > 60 ? "…" : "");
        throw new Error(
          `MISSING length-table overflow: рядок #${id} займає ${len} байтів у UTF-8, ` +
          `але формат тримає довжину у int16 (макс. 32767). Скоротіть переклад. ` +
          `Превʼю: "${preview}"`
        );
      }
      ov.setInt16(recOff + 4, len, true);
    }
  }

  return out;
}

/** Збирає Unity TextAsset wrap навколо MSG payload (для запису у .assets). */
export function wrapUnityTextAsset(name: string, script: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const afterName = 4 + nameBytes.length;
  const padded = (afterName + 3) & ~3;
  const totalLen = padded + 4 + script.length;
  const out = new Uint8Array(totalLen);
  const v = new DataView(out.buffer);
  v.setUint32(0, nameBytes.length, true);
  out.set(nameBytes, 4);
  v.setUint32(padded, script.length, true);
  out.set(script, padded + 4);
  return out;
}
