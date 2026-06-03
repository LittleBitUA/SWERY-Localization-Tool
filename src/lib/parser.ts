// Парсер DP2 sharedassets JSON-дампів.
// Підтримує дві схеми (див. types.ts): SCENARIO (sentence) і DISPLAY (item).
// Якщо зустрінеться нова — розширювати тут, не в UI.

import type { FlatEntry, Locator } from "../types";
import { LANG_INDEX } from "../types";

interface AnyArr<T> { Array?: T[] }
interface SentenceObj { m_charaName?: string; m_serif?: string }
interface Scenario {
  m_messageId?: string;
  m_sentences?: AnyArr<SentenceObj>;
  m_isVoiceOnlyList?: AnyArr<number>;
}
interface ListItem {
  // sentence-form
  m_demoId?: string;
  m_scenarioList?: AnyArr<Scenario>;
  // item-form
  m_uniqueId?: number;
  m_enumName?: string;
  m_name?: string;
  m_text?: AnyArr<string>;
}
interface Sheet {
  m_sheetName?: string;
  m_list?: AnyArr<ListItem>;
}
interface UiLabelRoot {
  // UILabel — плоский MonoBehaviour. Поле `mText` стрінг, без масиву мов.
  // Розпізнаємо по наявності `mText` на корені.
  mText?: string;
  mFontSize?: number;
}
interface Root extends UiLabelRoot {
  m_Name?: string;
  m_sheets?: AnyArr<Sheet>;
}

export function flatten(filePath: string, root: Root, originalRoot?: Root): FlatEntry[] {
  // ── UILabel form ────────────────────────────────────────────────
  // Якщо корінь має поле `mText` і немає `m_sheets` — це UILabel-asset з
  // Others/Done/. Один файл → один рядок (поле для редагування — `mText`).
  if (root.mText !== undefined && !root.m_sheets) {
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    return [{
      locator: { kind: "uilabel", filePath },
      kind: "uilabel",
      id: fileName.replace(/^UILabel-/, "").replace(/\.json$/i, ""),
      category: "Others",
      context: "mText",
      jp: "",
      en: root.mText ?? "",
      originalEn: originalRoot?.mText,
    }];
  }

  const out: FlatEntry[] = [];
  const sheets = root.m_sheets?.Array ?? [];
  const origSheets = originalRoot?.m_sheets?.Array ?? [];

  sheets.forEach((sheet, sheetIndex) => {
    const list = sheet.m_list?.Array ?? [];
    list.forEach((item, listIndex) => {
      // ── SCENARIO form ────────────────────────────────────────
      if (item.m_scenarioList) {
        const scenarios = item.m_scenarioList.Array ?? [];
        scenarios.forEach((scen, scenarioIndex) => {
          const sentences = scen.m_sentences?.Array ?? [];
          const jp = sentences[LANG_INDEX.JP];
          const en = sentences[LANG_INDEX.EN];
          if (!jp && !en) return;

          const origScen =
            origSheets[sheetIndex]?.m_list?.Array?.[listIndex]?.m_scenarioList?.Array?.[scenarioIndex];
          const origEn = origScen?.m_sentences?.Array?.[LANG_INDEX.EN];

          out.push({
            locator: {
              kind: "sentence",
              filePath,
              sheetIndex,
              listIndex,
              scenarioIndex,
              sentenceIndex: LANG_INDEX.EN,
            },
            kind: "sentence",
            id: scen.m_messageId ?? "",
            category: sheet.m_sheetName ?? "",
            context: item.m_demoId ?? "",
            jp: jp?.m_serif ?? "",
            en: en?.m_serif ?? "",
            originalEn: origEn?.m_serif,
            charaName: en?.m_charaName ?? "",
            charaNameJp: jp?.m_charaName ?? "",
            isVoiceOnly: scen.m_isVoiceOnlyList?.Array?.[LANG_INDEX.EN],
          });
        });
        return;
      }

      // ── DISPLAY (item) form ──────────────────────────────────
      if (item.m_text) {
        const arr = item.m_text.Array ?? [];
        if (arr.length < 2) return;
        const origItem = origSheets[sheetIndex]?.m_list?.Array?.[listIndex];
        const origText = origItem?.m_text?.Array?.[LANG_INDEX.EN];

        out.push({
          locator: {
            kind: "item",
            filePath,
            sheetIndex,
            listIndex,
            textIndex: LANG_INDEX.EN,
          },
          kind: "item",
          id: item.m_enumName ?? `id_${item.m_uniqueId ?? listIndex}`,
          category: sheet.m_sheetName ?? "",
          context: item.m_uniqueId !== undefined ? `#${item.m_uniqueId}` : "",
          jp: arr[LANG_INDEX.JP] ?? "",
          en: arr[LANG_INDEX.EN] ?? "",
          originalEn: origText,
          itemName: item.m_name ?? "",
        });
      }
    });
  });

  return out;
}

/**
 * Записати оновлений запис у дерево JSON in-place.
 * Для sentence записуємо charaName + serif. Для item — лише текст.
 */
export function applyEdit(
  root: Root,
  locator: Locator,
  newCharaName: string,
  newText: string
): boolean {
  if (locator.kind === "uilabel") {
    root.mText = newText;
    return true;
  }

  if (locator.kind === "sentence") {
    const scen =
      root.m_sheets?.Array?.[locator.sheetIndex]?.m_list?.Array?.[locator.listIndex]?.m_scenarioList
        ?.Array?.[locator.scenarioIndex];
    const sent = scen?.m_sentences?.Array?.[locator.sentenceIndex];
    if (!sent) return false;
    sent.m_charaName = newCharaName;
    sent.m_serif = newText;
    return true;
  }

  if (locator.kind === "item") {
    const item = root.m_sheets?.Array?.[locator.sheetIndex]?.m_list?.Array?.[locator.listIndex];
    const arr = item?.m_text?.Array;
    if (!arr) return false;
    arr[locator.textIndex] = newText;
    return true;
  }

  return false;
}

const HAS_CYR_RE = /[Ѐ-ӿ]/;

/**
 * "Перекладеним" вважаємо запис, у якому EN-слот:
 *   1. відрізняється від оригіналу з .bak.json;
 *   2. реально містить кириличні символи.
 * Друга умова прибирає false-positives через невидимі різниці у бекапі
 * (пробіли, регістр, escape-послідовності) — інакше рахунок задирається.
 */
export function isTranslated(s: FlatEntry): boolean {
  if (!s.originalEn) return false;
  if (s.en === s.originalEn) return false;
  return HAS_CYR_RE.test(s.en);
}

const HAS_LATIN_RE = /[A-Za-z]/;

/**
 * Запис потребує перекладу лише якщо в оригіналі є латинські літери
 * (людський англійський текст). Числа на кшталт "2005", дефіси "—" і
 * порожні рядки не вимагають перекладу — відсікаємо їх із фільтра
 * "не перекладені", щоб counter не задирався.
 */
export function needsTranslation(s: FlatEntry): boolean {
  if (!s.originalEn) return false;
  return HAS_LATIN_RE.test(s.originalEn);
}
