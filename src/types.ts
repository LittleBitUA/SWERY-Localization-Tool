// Schema-friendly types for DP2 sharedassets JSON dumps.
//
// Зустрічається 2 шаблони:
//   1. SCENARIO (SideQuest, Cutscene): m_sheets→m_list→m_scenarioList→m_sentences[6]
//      кожне речення = { m_charaName, m_serif }, 6 мов поспіль.
//   2. DISPLAY (Item names, UI strings): m_sheets→m_list→m_text[6 strings].
//      6 рядків відповідають мовам.
//
// EN-слот завжди індекс [1] (після японського).

export const LANG_NAMES = ["JP", "EN", "FR", "IT", "DE", "ES"] as const;
export const LANG_INDEX = { JP: 0, EN: 1, FR: 2, IT: 3, DE: 4, ES: 5 } as const;
export type LangIndex = typeof LANG_INDEX[keyof typeof LANG_INDEX];

export type EntryKind = "sentence" | "item" | "uilabel";

export interface SentenceLocator {
  kind: "sentence";
  filePath: string;
  sheetIndex: number;
  listIndex: number;
  scenarioIndex: number;
  sentenceIndex: number; // 1 = EN
}

export interface ItemLocator {
  kind: "item";
  filePath: string;
  sheetIndex: number;
  listIndex: number;
  textIndex: number; // 1 = EN
}

// UILabel — окремий MonoBehaviour з плоским полем `mText`. Один файл = один
// рядок перекладу (немає множинного списку чи мовних слотів).
export interface UiLabelLocator {
  kind: "uilabel";
  filePath: string;
}

export type Locator = SentenceLocator | ItemLocator | UiLabelLocator;

export interface FileEntry {
  name: string;
  path: string;
  totalEntries: number;
  translatedCount: number;
}

export interface FlatEntry {
  locator: Locator;
  kind: EntryKind;
  /** Первинний ID для пошуку (m_messageId або m_enumName) */
  id: string;
  /** Категорія / лист (Item, ルイス・サイドクエスト01 тощо) */
  category: string;
  /** Доп. контекст: demoId (sentence) або #uniqueId (item) */
  context: string;
  /** Японський оригінал (текст репліки або назви) */
  jp: string;
  /** EN-слот (зараз ред.) */
  en: string;
  /** Оригінальний EN з .bak (якщо є) */
  originalEn?: string;
  // sentence-specific
  charaName?: string;
  charaNameJp?: string;
  isVoiceOnly?: number;
  // item-specific
  itemName?: string;
}
