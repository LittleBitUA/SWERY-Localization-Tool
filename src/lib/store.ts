// Zustand store: керує станом теки, дерева файлів, записів.

import { create } from "zustand";
import type { FlatEntry } from "../types";
import { flatten, applyEdit, isTranslated } from "./parser";
import { invalidateTm } from "./tm";
import { recordTranslation } from "./metrics";
import { buildTxt, parseTxt, blockToStorage, type ExportEntry } from "./txtRoundtrip";
import { confirm as showConfirm } from "./dialogs";
import { t } from "./i18n";
import {
  emptyStatusFile,
  pruneEntry,
  readStatusFile,
  writeStatusFile,
  type StatusEntry,
  type StatusFile,
  type StatusKind,
} from "./status";

/** Стабільний ключ статусу для DP2 entry. */
export function dp2StatusKey(e: FlatEntry): string {
  const loc = e.locator;
  const tail = loc.kind === "sentence"
    ? `${loc.sheetIndex}:${loc.listIndex}:${loc.scenarioIndex}`
    : `${loc.sheetIndex}:${loc.listIndex}`;
  const base = loc.filePath.split(/[\\/]/).pop() ?? loc.filePath;
  return `${base}::${e.id || "_"}::${tail}`;
}

function statusFilePath(folder: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith(sep) ? folder + ".dp-status.json" : folder + sep + ".dp-status.json";
}

export interface TreeNode {
  type: "folder" | "file";
  name: string;
  path: string;
  children?: TreeNode[];
  totalEntries?: number;
  translatedCount?: number;
}

export type StatusFilter = "all" | "translated" | "untranslated" | "draft" | "review" | "approved" | "bookmarks";

interface State {
  folder: string | null;
  /** Дерево всієї кореневої теки (підпапки + файли). */
  tree: TreeNode | null;
  /** Шлях до поточно відкритого файла. */
  selectedFilePath: string | null;
  /** JSON-дерево поточного файла (для запису назад). */
  currentTree: any | null;
  entries: FlatEntry[];
  activeIndex: number | null;
  dirty: boolean;
  search: string;
  translatedFilter: StatusFilter;
  loading: boolean;
  error: string | null;
  /** Інкрементується при кожному збереженні — щоб TM-панель перебудувала кеш. */
  saveTick: number;
  /** ms unix-таймстамп останнього успішного autosave для поточного файла, або null. */
  lastAutosaveAt: number | null;
  /** Side-car статуси (підвантажуються разом з folder). */
  statuses: StatusFile;
  /** Undo-стек для масових операцій (імпорт .txt, bulk, find&replace). */
  undoStack: Array<{ label: string; filePath: string; entries: FlatEntry[]; currentTree: any }>;

  init: () => Promise<void>;
  pickFolder: () => Promise<void>;
  loadFile: (fullPath: string) => Promise<void>;
  setSearch: (s: string) => void;
  setTranslatedFilter: (f: StatusFilter) => void;
  setActive: (i: number | null) => void;
  /** Прочитати статус активного запису. */
  getActiveStatus: () => StatusEntry | undefined;
  /** Поставити/зняти стан для запису по індексу. */
  setEntryStatus: (i: number, status: StatusKind | undefined) => Promise<void>;
  toggleEntryBookmark: (i: number) => Promise<void>;
  /** Bulk-операції для масиву індексів. */
  bulkSetStatus: (indices: number[], status: StatusKind | undefined) => Promise<void>;
  bulkCopyOriginalToTranslation: (indices: number[]) => void;
  bulkTrim: (indices: number[]) => void;
  /** Експортувати поточний файл у .txt для зовнішнього перекладу. */
  exportTxt: () => { fileName: string; content: string } | null;
  /** Імпортувати раніше експортований .txt назад у поточний файл. */
  importTxtContent: (txt: string) => { applied: number; missing: number; mismatched: number };
  /**
   * Відновити вміст файла з .bak.json (оригінального бекапу). Якщо файл
   * відкритий — перезавантажить ентрі. Повертає true, якщо успіх.
   */
  restoreOriginal: (filePath: string) => Promise<boolean>;
  /** Зробити snapshot поточного entries+tree для майбутнього undo. */
  pushUndo: (label: string) => void;
  /** Чи є відкатуване — для UI Ctrl+Z indicator. */
  canUndo: () => boolean;
  /** Скасувати останню масову зміну. */
  undo: () => boolean;
  /** Перейти до сусіднього рядка (delta=+1/-1), циклічно по entries. */
  step: (delta: number) => void;
  /** Стрибок до наступного неперекладеного рядка (від поточної позиції). */
  jumpToNextUntranslated: () => boolean;
  /** Скопіювати оригінал (originalEn або jp) у поле перекладу. */
  copyOriginalToTranslation: () => void;
  updateActive: (charaName: string, text: string) => void;
  saveFile: () => Promise<void>;
  /** Запис sidecar `<file>.autosave.json` з поточним currentTree. */
  autosave: () => Promise<void>;
  refreshFileMeta: (fullPath: string) => void;
  /** Find/Replace по всіх записах поточного файла (charaName + текст). */
  findReplaceAll: (find: string, replace: string, opts: { caseSensitive: boolean; wholeWord: boolean }) =>
    { entries: number; replacements: number };
}

/** Walk дерева й оновити одне file-нодою stats (immutable update). */
function updateFileStats(
  node: TreeNode | null,
  filePath: string,
  total: number,
  translated: number
): TreeNode | null {
  if (!node) return node;
  if (node.type === "file") {
    if (node.path === filePath) {
      return { ...node, totalEntries: total, translatedCount: translated };
    }
    return node;
  }
  if (!node.children) return node;
  const nextChildren = node.children.map((c) => updateFileStats(c, filePath, total, translated)!);
  return { ...node, children: nextChildren };
}

export const useStore = create<State>((set, get) => ({
  folder: null,
  tree: null,
  selectedFilePath: null,
  currentTree: null,
  entries: [],
  activeIndex: null,
  dirty: false,
  search: "",
  translatedFilter: "all",
  loading: false,
  error: null,
  saveTick: 0,
  lastAutosaveAt: null,
  statuses: emptyStatusFile(),
  undoStack: [],

  async init() {
    try {
      const settings = await window.dp2.getSettings();
      const last = settings.lastFolder;
      if (!last) return;
      const tree = await window.dp2.listTree(last);
      if (!tree) return;
      const statuses = await readStatusFile(statusFilePath(last));
      set({ folder: last, tree, statuses });
    } catch {
      // Тека вже не існує — мовчки ігноруємо.
    }
  },

  async pickFolder() {
    set({ loading: true, error: null });
    try {
      const folder = await window.dp2.pickFolder();
      if (!folder) {
        set({ loading: false });
        return;
      }
      const tree = await window.dp2.listTree(folder);
      try { await window.dp2.saveSettings({ lastFolder: folder }); } catch {}
      const statuses = await readStatusFile(statusFilePath(folder));
      set({
        folder,
        tree,
        statuses,
        selectedFilePath: null,
        currentTree: null,
        entries: [],
        activeIndex: null,
        dirty: false,
        loading: false,
      });
    } catch (e: any) {
      set({ loading: false, error: String(e) });
    }
  },

  async loadFile(fullPath) {
    set({ loading: true, error: null });
    try {
      let rawForTree = await window.dp2.readFile(fullPath);
      let restoredFromAutosave = false;

      // Якщо є autosave свіжіший за файл — пропонуємо відновити. Це сценарій
      // крашу/закриття без Ctrl+S: незбережені правки сидять у sidecar.
      const auto = await window.dp2.readAutosave(fullPath);
      if (auto && auto.autosaveMtime > auto.originalMtime + 100) {
        const ago = Math.max(1, Math.round((Date.now() - auto.autosaveMtime) / 60000));
        const yes = await showConfirm(
          t("autosave.recover.title"),
          t("autosave.recover.body", { minutes: ago }),
        );
        if (yes) {
          rawForTree = auto.content;
          restoredFromAutosave = true;
        } else {
          // Користувач відмовився — autosave більше не потрібен.
          try { await window.dp2.deleteAutosave(fullPath); } catch {}
        }
      }

      const tree = JSON.parse(rawForTree);

      let originalTree: any = null;
      const bak = await window.dp2.readBackup(fullPath);
      if (bak) {
        try { originalTree = JSON.parse(bak); } catch { /* corrupted, ignore */ }
      }

      const entries = flatten(fullPath, tree, originalTree);
      set({
        selectedFilePath: fullPath,
        currentTree: tree,
        entries,
        activeIndex: entries.length ? 0 : null,
        // Якщо відновили з autosave — це і є незбережений стан, треба
        // показати кнопку Save як активну.
        dirty: restoredFromAutosave,
        lastAutosaveAt: null,
        loading: false,
      });
      get().refreshFileMeta(fullPath);
    } catch (e: any) {
      set({ loading: false, error: String(e) });
    }
  },

  setSearch(s) { set({ search: s }); },
  setTranslatedFilter(f) { set({ translatedFilter: f }); },
  setActive(i) { set({ activeIndex: i }); },

  getActiveStatus() {
    const { entries, activeIndex, statuses } = get();
    if (activeIndex === null) return undefined;
    const e = entries[activeIndex];
    if (!e) return undefined;
    return statuses.entries[dp2StatusKey(e)];
  },

  async setEntryStatus(i, status) {
    const { entries, statuses, folder } = get();
    const e = entries[i];
    if (!e || !folder) return;
    const key = dp2StatusKey(e);
    const cur = statuses.entries[key] ?? {};
    let next: StatusFile = {
      ...statuses,
      entries: { ...statuses.entries, [key]: { ...cur, status } },
    };
    next = pruneEntry(next, key);
    set({ statuses: next });
    try { await writeStatusFile(statusFilePath(folder), next); } catch {}
  },

  async toggleEntryBookmark(i) {
    const { entries, statuses, folder } = get();
    const e = entries[i];
    if (!e || !folder) return;
    const key = dp2StatusKey(e);
    const cur = statuses.entries[key] ?? {};
    let next: StatusFile = {
      ...statuses,
      entries: {
        ...statuses.entries,
        [key]: { ...cur, bookmark: cur.bookmark ? undefined : true },
      },
    };
    next = pruneEntry(next, key);
    set({ statuses: next });
    try { await writeStatusFile(statusFilePath(folder), next); } catch {}
  },

  async bulkSetStatus(indices, status) {
    const { entries, statuses, folder } = get();
    if (!folder || !indices.length) return;
    const map = { ...statuses.entries };
    for (const i of indices) {
      const e = entries[i];
      if (!e) continue;
      const key = dp2StatusKey(e);
      map[key] = { ...(map[key] ?? {}), status };
    }
    let next: StatusFile = { ...statuses, entries: map };
    for (const i of indices) {
      const e = entries[i];
      if (!e) continue;
      next = pruneEntry(next, dp2StatusKey(e));
    }
    set({ statuses: next });
    try { await writeStatusFile(statusFilePath(folder), next); } catch {}
  },

  bulkCopyOriginalToTranslation(indices) {
    const { entries, currentTree, selectedFilePath } = get();
    if (!currentTree || !indices.length) return;
    const next = entries.slice();
    let changed = 0;
    for (const i of indices) {
      const e = entries[i];
      if (!e) continue;
      const src = (e.originalEn ?? e.jp ?? "").trim();
      if (!src) continue;
      const ok = applyEdit(currentTree, e.locator, e.charaName ?? "", src);
      if (!ok) continue;
      next[i] = { ...e, en: src };
      changed++;
    }
    if (changed > 0) {
      set({ entries: next, dirty: true });
      if (selectedFilePath) get().refreshFileMeta(selectedFilePath);
    }
  },

  bulkTrim(indices) {
    const { entries, currentTree, selectedFilePath } = get();
    if (!currentTree || !indices.length) return;
    const next = entries.slice();
    let changed = 0;
    for (const i of indices) {
      const e = entries[i];
      if (!e) continue;
      const trimmed = e.en.replace(/^\s+|\s+$/g, "").replace(/[ \t]+\n/g, "\n");
      if (trimmed === e.en) continue;
      const ok = applyEdit(currentTree, e.locator, e.charaName ?? "", trimmed);
      if (!ok) continue;
      next[i] = { ...e, en: trimmed };
      changed++;
    }
    if (changed > 0) {
      set({ entries: next, dirty: true });
      if (selectedFilePath) get().refreshFileMeta(selectedFilePath);
    }
  },

  exportTxt() {
    const { entries, selectedFilePath } = get();
    if (!entries.length || !selectedFilePath) return null;
    const fileName = (selectedFilePath.split(/[\\/]/).pop() ?? "export").replace(/\.json$/i, "");
    const HAS_CYR = /[Ѐ-ӿ]/;
    const exportEntries: ExportEntry[] = entries.map((e, i) => {
      const isSentence = e.kind === "sentence";
      const speaker = isSentence ? (e.charaName || e.charaNameJp || undefined) : undefined;
      const hintParts: string[] = [];
      if (e.id) hintParts.push(e.id);
      if (!isSentence && e.itemName) hintParts.push(e.itemName);
      // Якщо рядок уже перекладений (en має кирилицю і відрізняється від .bak)
      // — експортуємо ПЕРЕКЛАД, щоб людина продовжила. Інакше — англ-оригінал.
      const isAlreadyTranslated =
        !!e.originalEn && e.en !== e.originalEn && HAS_CYR.test(e.en);
      const text = isAlreadyTranslated
        ? e.en
        : (e.originalEn ?? e.en ?? "");
      return {
        index: i + 1,
        speaker,
        text,
        hint: hintParts.length ? hintParts.join(" · ") : undefined,
      };
    });
    const content = buildTxt(`DP2: ${fileName}`, exportEntries);
    return { fileName, content };
  },

  pushUndo(label) {
    const { undoStack, entries, currentTree, selectedFilePath } = get();
    if (!selectedFilePath || !currentTree) return;
    // Тримаємо до 10 рівнів. Глибокий клон через JSON — простіше, ніж
    // структурне копіювання великих дерев, і робиться раз на bulk-операцію.
    const snapshot = {
      label,
      filePath: selectedFilePath,
      entries: entries.slice(),
      currentTree: JSON.parse(JSON.stringify(currentTree)),
    };
    const nextStack = [...undoStack, snapshot];
    while (nextStack.length > 10) nextStack.shift();
    set({ undoStack: nextStack });
  },

  canUndo() {
    const { undoStack, selectedFilePath } = get();
    if (!selectedFilePath) return false;
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].filePath === selectedFilePath) return true;
    }
    return false;
  },

  undo() {
    const { undoStack, selectedFilePath } = get();
    if (!selectedFilePath) return false;
    // Знаходимо ОСТАННІЙ snapshot для поточного файла.
    let idx = -1;
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].filePath === selectedFilePath) { idx = i; break; }
    }
    if (idx < 0) return false;
    const snap = undoStack[idx];
    const nextStack = [...undoStack.slice(0, idx), ...undoStack.slice(idx + 1)];
    invalidateTm();
    set({
      entries: snap.entries,
      currentTree: snap.currentTree,
      undoStack: nextStack,
      dirty: true,
    });
    get().refreshFileMeta(selectedFilePath);
    return true;
  },

  async restoreOriginal(filePath) {
    const bak = await window.dp2.readBackup(filePath);
    if (!bak) return false;
    // Перезаписуємо JSON-файл вмістом бекапу. writeFile не створить новий .bak,
    // бо .bak вже існує — лишається недоторканим.
    await window.dp2.writeFile(filePath, bak);
    invalidateTm();
    // Якщо саме цей файл зараз відкритий — перезавантажити entries.
    if (get().selectedFilePath === filePath) {
      await get().loadFile(filePath);
    }
    get().refreshFileMeta(filePath);
    return true;
  },

  importTxtContent(txt) {
    const { entries, currentTree, selectedFilePath } = get();
    if (!currentTree) return { applied: 0, missing: 0, mismatched: 0 };

    // Snapshot для Ctrl+Z.
    get().pushUndo("import-txt");

    // Будуємо мапу id → positional index. ID унікальний у межах файла
    // (m_messageId у sentence, m_enumName у item) — то надійніше за позицію.
    const byId = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i].id;
      if (id) byId.set(id, i);
    }

    const blocks = parseTxt(txt);
    let applied = 0;
    let missing = 0;
    let mismatched = 0; // блоки, що змаплено за позицією через відсутність ID
    const next = entries.slice();
    for (const b of blocks) {
      // 1) Спершу шукаємо за ID, якщо він був у маркері.
      let i = -1;
      if (b.id) {
        const byIdHit = byId.get(b.id);
        if (byIdHit !== undefined) i = byIdHit;
      }
      // 2) Fallback — позиційно. Перевіряємо що ID збігається з тим, що в entries.
      if (i < 0) {
        const pos = b.index - 1;
        if (entries[pos]) {
          if (!b.id || !entries[pos].id || entries[pos].id === b.id) {
            i = pos;
          } else {
            mismatched++;
          }
        }
      }
      if (i < 0) { missing++; continue; }

      const e = entries[i];
      const { speaker, text } = blockToStorage(b);
      const newSpeaker = e.kind === "sentence"
        ? (speaker !== undefined ? speaker : (e.charaName ?? ""))
        : "";
      const ok = applyEdit(currentTree, e.locator, newSpeaker, text);
      if (!ok) { missing++; continue; }
      next[i] = {
        ...e,
        en: text,
        // Якщо .bak.json не існував, originalEn був undefined і колонка
        // «Оригінал» рендерила те, що тепер замінюємо. Перед перезаписом —
        // зберігаємо попередній EN як originalEn, щоб референс не загубився.
        ...(e.originalEn === undefined ? { originalEn: e.en } : {}),
        ...(e.kind === "sentence" ? { charaName: newSpeaker } : {}),
      };
      applied++;
    }
    if (applied > 0) {
      set({ entries: next, dirty: true });
      if (selectedFilePath) get().refreshFileMeta(selectedFilePath);
    }
    return { applied, missing, mismatched };
  },

  step(delta) {
    const { entries, activeIndex } = get();
    if (entries.length === 0) return;
    const cur = activeIndex ?? 0;
    const n = entries.length;
    const next = ((cur + delta) % n + n) % n;
    set({ activeIndex: next });
  },

  jumpToNextUntranslated() {
    const { entries, activeIndex } = get();
    if (entries.length === 0) return false;
    const start = (activeIndex ?? -1) + 1;
    const n = entries.length;
    for (let off = 0; off < n; off++) {
      const i = (start + off) % n;
      if (!isTranslated(entries[i])) {
        set({ activeIndex: i });
        return true;
      }
    }
    return false;
  },

  copyOriginalToTranslation() {
    const { entries, activeIndex } = get();
    if (activeIndex === null) return;
    const e = entries[activeIndex];
    if (!e) return;
    // Пріоритет: originalEn (з .bak) > jp.
    const src = (e.originalEn ?? e.jp ?? "").trim();
    if (!src) return;
    get().updateActive(e.charaName ?? "", src);
  },

  updateActive(charaName, text) {
    const { activeIndex, entries, currentTree, selectedFilePath } = get();
    if (activeIndex === null || !currentTree) return;
    const e = entries[activeIndex];
    if (!e) return;
    const ok = applyEdit(currentTree, e.locator, charaName, text);
    if (!ok) return;
    const next = entries.slice();
    next[activeIndex] = {
      ...e,
      en: text,
      ...(e.kind === "sentence" ? { charaName } : {}),
    };
    set({ entries: next, dirty: true });
    const wasTranslated = isTranslated(e);
    const becameTranslated = isTranslated(next[activeIndex]);
    if (becameTranslated && !wasTranslated) {
      recordTranslation(text, e.en);
    }
    // Live-update лічильника у дереві файлів. Оновлюємо лише при зміні
    // is-translated стану, щоб не пере-малювати дерево на кожен символ.
    if (selectedFilePath && becameTranslated !== wasTranslated) {
      get().refreshFileMeta(selectedFilePath);
    }
  },

  async saveFile() {
    const { selectedFilePath, currentTree } = get();
    if (!selectedFilePath || !currentTree) return;
    const json = JSON.stringify(currentTree, null, 2);
    await window.dp2.writeFile(selectedFilePath, json);
    invalidateTm();
    // Стерти autosave: реальний файл актуальний, sidecar більше не потрібен.
    try { await window.dp2.deleteAutosave(selectedFilePath); } catch {}
    set({ dirty: false, saveTick: get().saveTick + 1, lastAutosaveAt: null });
    get().refreshFileMeta(selectedFilePath);
  },

  async autosave() {
    const { selectedFilePath, currentTree, dirty } = get();
    if (!selectedFilePath || !currentTree || !dirty) return;
    try {
      const json = JSON.stringify(currentTree, null, 2);
      await window.dp2.writeAutosave(selectedFilePath, json);
      set({ lastAutosaveAt: Date.now() });
    } catch {
      // Не критично: при наступному debounce-tick спробуємо знову.
    }
  },

  refreshFileMeta(fullPath) {
    const { entries, tree } = get();
    const total = entries.length;
    const translated = entries.filter((e) => isTranslated(e)).length;
    const nextTree = updateFileStats(tree, fullPath, total, translated);
    set({ tree: nextTree });
  },

  findReplaceAll(find, replace, opts) {
    const { entries, currentTree, selectedFilePath } = get();
    if (!find || !currentTree) return { entries: 0, replacements: 0 };

    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = opts.wholeWord ? `\\b${escaped}\\b` : escaped;
    const flags = opts.caseSensitive ? "g" : "gi";
    const re = new RegExp(pattern, flags);

    let entriesChanged = 0;
    let replacements = 0;

    const replaceCount = (s: string): { v: string; n: number } => {
      if (!s) return { v: s, n: 0 };
      let n = 0;
      const v = s.replace(re, () => { n++; return replace; });
      return { v, n };
    };

    const next = entries.map((e) => {
      let touched = false;
      let newEn = e.en;
      let newCharaName = e.charaName;

      const en = replaceCount(e.en);
      if (en.n > 0) {
        newEn = en.v;
        replacements += en.n;
        touched = true;
      }

      if (e.kind === "sentence" && e.charaName) {
        const nm = replaceCount(e.charaName);
        if (nm.n > 0) {
          newCharaName = nm.v;
          replacements += nm.n;
          touched = true;
        }
      }

      if (!touched) return e;
      entriesChanged++;
      // Записуємо в currentTree теж — щоб при saveFile зміни вилетіли в JSON.
      applyEdit(currentTree, e.locator, newCharaName ?? "", newEn);
      return {
        ...e,
        en: newEn,
        ...(e.kind === "sentence" ? { charaName: newCharaName ?? "" } : {}),
      };
    });

    if (entriesChanged > 0) {
      set({ entries: next, dirty: true });
      if (selectedFilePath) get().refreshFileMeta(selectedFilePath);
    }

    return { entries: entriesChanged, replacements };
  },
}));
