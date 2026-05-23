// Translation Memory для HBR.
//
// Ідея: HBR має багато повторів — той самий original-рядок ("Yes", "No",
// "Continue", "{0}'s room") зустрічається у різних *_EN.json. Якщо вже
// перекладено у одному файлі, ми можемо запропонувати ту саму українську
// у решті. Це економить години на типових рядках.
//
// Інтерфейс: build TM map → Map<original, { translation, sourceFile, count }>.
// Потім parent (HbrEditor) може:
//   - Підсвітити рядок у таблиці, якщо для нього є TM-hint
//   - Запропонувати auto-fill у sidepanel
//   - Auto-apply у всіх неперекладених рядках через cmd-palette

import type { HbrParsedFile } from "./parser";

export interface TmEntry {
  translation: string;
  sourceFile: string;
  /** Скільки разів цей original-text зустрічається у вже-перекладених рядках
   * (з тим самим перекладом). Якщо >1 — особливо надійно. */
  count: number;
  /** Чи усі переклади цього original-у згодні. Якщо false, є конфлікти —
   * не можна спокійно auto-apply. */
  consistent: boolean;
}

export type TranslationMemory = Map<string, TmEntry>;

interface BuildInput {
  /** Список усіх (parsed) файлів проєкту. Каже скільки разів original є + який переклад. */
  files: Array<{ name: string; parsed: HbrParsedFile }>;
  /** Функція щоб дізнатися чи цей рядок реально перекладений (не дорівнює original/empty/system). */
  isTranslated: (original: string, current: string) => boolean;
}

export function buildTranslationMemory({ files, isTranslated }: BuildInput): TranslationMemory {
  // 1) проходимо всі files, збираємо мапи original → { translation → count, files }
  const raw = new Map<string, Map<string, { count: number; sourceFile: string }>>();
  for (const f of files) {
    for (const it of f.parsed.items) {
      if (!isTranslated(it.original, it.current)) continue;
      const o = it.original;
      let bucket = raw.get(o);
      if (!bucket) { bucket = new Map(); raw.set(o, bucket); }
      const cur = bucket.get(it.current);
      if (cur) cur.count++;
      else bucket.set(it.current, { count: 1, sourceFile: f.name });
    }
  }
  // 2) для кожного original — обираємо найчастіший переклад. consistent=true
  //    якщо тільки один варіант.
  const out: TranslationMemory = new Map();
  for (const [original, bucket] of raw.entries()) {
    if (bucket.size === 0) continue;
    let best: { translation: string; count: number; sourceFile: string } | null = null;
    let total = 0;
    for (const [tr, info] of bucket.entries()) {
      total += info.count;
      if (!best || info.count > best.count) best = { translation: tr, count: info.count, sourceFile: info.sourceFile };
    }
    if (!best) continue;
    out.set(original, {
      translation: best.translation,
      sourceFile: best.sourceFile,
      count: total,
      consistent: bucket.size === 1,
    });
  }
  return out;
}

/** Скільки рядків у parsed-файлі мають TM-кандидата (тобто original є у TM,
 *  а current — порожній або === original). Допомагає сказати "у цьому файлі
 *  можна авто-перекласти X рядків з TM". */
export function countTmCandidates(parsed: HbrParsedFile, tm: TranslationMemory, isSystem: (s: string) => boolean): number {
  let n = 0;
  for (const it of parsed.items) {
    if (isSystem(it.original)) continue;
    const has = tm.has(it.original);
    if (!has) continue;
    const empty = !it.current || it.current.trim() === "";
    const sameAsOrig = it.current === it.original;
    if (empty || sameAsOrig) n++;
  }
  return n;
}
