// Zustand store: керує станом теки, дерева файлів, записів.

import { create } from "zustand";
import type { FlatEntry } from "../types";
import { flatten, applyEdit, isTranslated } from "./parser";
import { invalidateTm } from "./tm";
import { recordTranslation } from "./metrics";
import { buildTxt, parseTxt, blockToStorage, type ExportEntry } from "./txtRoundtrip";
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
  /** Side-car статуси (підвантажуються разом з folder). */
  statuses: StatusFile;

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
  importTxtContent: (txt: string) => { applied: number; missing: number };
  /**
   * Відновити вміст файла з .bak.json (оригінального бекапу). Якщо файл
   * відкритий — перезавантажить ентрі. Повертає true, якщо успіх.
   */
  restoreOriginal: (filePath: string) => Promise<boolean>;
  /** Перейти до сусіднього рядка (delta=+1/-1), циклічно по entries. */
  step: (delta: number) => void;
  /** Стрибок до наступного неперекладеного рядка (від поточної позиції). */
  jumpToNextUntranslated: () => boolean;
  /** Скопіювати оригінал (originalEn або jp) у поле перекладу. */
  copyOriginalToTranslation: () => void;
  updateActive: (charaName: string, text: string) => void;
  saveFile: () => Promise<void>;
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
  statuses: emptyStatusFile(),

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
      const raw = await window.dp2.readFile(fullPath);
      const tree = JSON.parse(raw);

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
        dirty: false,
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
    const { entries, currentTree } = get();
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
    if (changed > 0) set({ entries: next, dirty: true });
  },

  bulkTrim(indices) {
    const { entries, currentTree } = get();
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
    if (changed > 0) set({ entries: next, dirty: true });
  },

  exportTxt() {
    const { entries, selectedFilePath } = get();
    if (!entries.length || !selectedFilePath) return null;
    const fileName = (selectedFilePath.split(/[\\/]/).pop() ?? "export").replace(/\.json$/i, "");
    const exportEntries: ExportEntry[] = entries.map((e, i) => ({
      index: i + 1,
      speaker: e.kind === "sentence" ? (e.charaName || e.charaNameJp || undefined) : (e.itemName || undefined),
      // Експортуємо ОРИГІНАЛ (EN з .bak або поточний EN) — щоб людина бачила, що перекладати.
      text: e.originalEn ?? e.en ?? "",
      hint: e.id || (e.kind === "item" && e.itemName) || undefined,
    }));
    const content = buildTxt(`DP2: ${fileName}`, exportEntries);
    return { fileName, content };
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
    const { entries, currentTree } = get();
    if (!currentTree) return { applied: 0, missing: 0 };
    const blocks = parseTxt(txt);
    let applied = 0;
    let missing = 0;
    const next = entries.slice();
    for (const b of blocks) {
      const i = b.index - 1;
      const e = entries[i];
      if (!e) { missing++; continue; }
      const { speaker, text } = blockToStorage(b);
      const newSpeaker = e.kind === "sentence"
        ? (speaker !== undefined ? speaker : (e.charaName ?? ""))
        : "";
      const ok = applyEdit(currentTree, e.locator, newSpeaker, text);
      if (!ok) { missing++; continue; }
      next[i] = {
        ...e,
        en: text,
        ...(e.kind === "sentence" ? { charaName: newSpeaker } : {}),
      };
      applied++;
    }
    if (applied > 0) set({ entries: next, dirty: true });
    return { applied, missing };
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
    const { activeIndex, entries, currentTree } = get();
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
    // Зараховуємо у метрики лише якщо рядок переходить у "перекладений" стан,
    // або вже був перекладений — щоб не двічі зараховувати одне й те ж.
    const wasTranslated = isTranslated(e);
    const becameTranslated = isTranslated(next[activeIndex]);
    if (becameTranslated && !wasTranslated) {
      recordTranslation(text, e.en);
    }
  },

  async saveFile() {
    const { selectedFilePath, currentTree } = get();
    if (!selectedFilePath || !currentTree) return;
    const json = JSON.stringify(currentTree, null, 2);
    await window.dp2.writeFile(selectedFilePath, json);
    invalidateTm();
    set({ dirty: false, saveTick: get().saveTick + 1 });
    get().refreshFileMeta(selectedFilePath);
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
