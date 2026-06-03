// Zustand store: керує станом теки, дерева файлів, записів.

import { create } from "zustand";
import type { FlatEntry } from "../types";
import { flatten, applyEdit, isTranslated, needsTranslation } from "./parser";
import { invalidateTm } from "./tm";
import { recordTranslation } from "./metrics";
import { buildTxt, parseTxt, blockToStorage, type ExportEntry } from "./txtRoundtrip";
import { confirm as showConfirm } from "./dialogs";
import { showError } from "../components/Toast";
import { t } from "./i18n";

// Generation counter: кожен loadFile інкрементує його перед await.
// Якщо до моменту resolve user встиг клікнути інший файл — generation
// у замиканні не збігається з поточним, і ми відкидаємо результат.
// Без цього стара завершена IO-операція могла перезаписати entries
// свіжіше обраного файла (last-completed wins).
let _loadFileGen = 0;
import {
  emptyStatusFile,
  pruneEntry,
  pruneFileMeta,
  readStatusFile,
  writeStatusFile,
  type FileMeta,
  type StatusEntry,
  type StatusFile,
  type StatusKind,
} from "./status";
import { DP2_OTHERS_PATH_IDS } from "../games/dp2/othersPathIds";

/** Стабільний ключ статусу для DP2 entry. */
export function dp2StatusKey(e: FlatEntry): string {
  const loc = e.locator;
  let tail: string;
  if (loc.kind === "sentence") {
    tail = `${loc.sheetIndex}:${loc.listIndex}:${loc.scenarioIndex}`;
  } else if (loc.kind === "item") {
    tail = `${loc.sheetIndex}:${loc.listIndex}`;
  } else {
    // UILabel — один рядок на файл, фіксований tail.
    tail = "ui:mText";
  }
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
  /** Текст останньої saveFile-помилки. Сетиться у саппорт SaveStatusBadge. */
  lastSaveError: string | null;
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
  /** Файл-level: позначити всі рядки markedTranslated=true/false (Зекономлено
   *  Перекладено). Читає файл через IPC, парсить, оновлює entries map. */
  bulkMarkFileTranslated: (filePath: string, mark: boolean) => Promise<{ count: number }>;
  /** Файл-level: «Зредаговано» — файл малюється помаранчевим у sidebar. */
  setFileEdited: (filePath: string, edited: boolean) => Promise<void>;
  /** Зчитати file-meta для FileNode (`allTranslated` / `edited` прапорці). */
  getFileMeta: (filePath: string) => import("./status").FileMeta | undefined;
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
  /** Перебудувати дерево «Others» (викликати після extract/clear модалки). */
  refreshOthers: () => Promise<void>;
  /** Find/Replace по всіх записах поточного файла (charaName + текст). */
  findReplaceAll: (find: string, replace: string, opts: { caseSensitive: boolean; wholeWord: boolean }) =>
    { entries: number; replacements: number };
  /**
   * Прев'ю TM auto-fill (1:1): рахує неперекладені записи поточного файла,
   * чий source ТОЧНО збігається з якимось TM-source. Жодних substring-замін.
   */
  previewTmExact: (tm: Array<{ src: string; tgt: string }>) =>
    { matches: Array<{ entryIndex: number; src: string; tgt: string }> };
  /** Застосувати TM auto-fill 1:1: пише tgt у entry.en для exact-збігів. */
  applyTmExact: (tm: Array<{ src: string; tgt: string }>) => number;
}

/**
 * Доклеїти до кореня DP2-tree віртуальну теку `Others` зі списком
 * UILabel-Done-файлів. Викликається після кожного `listTree`.
 * Якщо у Others/Done нічого ще нема (extract не запускався) — не додаємо
 * пусту теку, щоб не засмічувати дерево.
 */
async function withOthersBranch(tree: TreeNode | null): Promise<TreeNode | null> {
  if (!tree) return tree;
  try {
    const r = await window.dp2.dp2OthersStatus({ pathIds: Array.from(DP2_OTHERS_PATH_IDS) });
    if (!r.ok || !r.doneDir || !r.files) return tree;
    const presentFiles = r.files.filter((f) => f.doneSize != null);
    if (presentFiles.length === 0) return tree;
    const otherChildren: TreeNode[] = presentFiles.map((f) => ({
      type: "file",
      name: f.name,
      path: f.donePath,
    }));
    const othersNode: TreeNode = {
      type: "folder",
      name: "Others",
      path: r.doneDir,
      children: otherChildren,
    };
    // Видаляємо попередню «Others»-гілку (якщо є) і додаємо свіжу — це робить
    // повторні виклики (post-extract) ідемпотентними.
    const filtered = (tree.children ?? []).filter((c) => !(c.type === "folder" && c.path === r.doneDir));
    return { ...tree, children: [...filtered, othersNode] };
  } catch {
    return tree;
  }
}

/** Перший .json-файл у дереві (DFS), або null. */
function findFirstFile(node: TreeNode | null): string | null {
  if (!node) return null;
  if (node.type === "file") return node.path;
  for (const c of node.children ?? []) {
    const hit = findFirstFile(c);
    if (hit) return hit;
  }
  return null;
}

/** Перевіряє, чи `path` існує серед файлів дерева. Повертає сам path або null. */
function findFileInTree(node: TreeNode | null, path: string | undefined): string | null {
  if (!path || !node) return null;
  if (node.type === "file") return node.path === path ? node.path : null;
  for (const c of node.children ?? []) {
    const hit = findFileInTree(c, path);
    if (hit) return hit;
  }
  return null;
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
  lastSaveError: null,
  statuses: emptyStatusFile(),
  undoStack: [],

  async init() {
    try {
      const settings = await window.dp2.getSettings();
      const last = settings.lastFolder;
      if (!last) return;
      const rawTree = await window.dp2.listTree(last);
      if (!rawTree) return;
      const tree = await withOthersBranch(rawTree);
      const statuses = await readStatusFile(statusFilePath(last));
      set({ folder: last, tree, statuses });

      // Авто-відкриття: пам'ять про останній файл живе у settings.dp2LastFile.
      // Якщо він валідний у поточному дереві — відкриваємо його. Інакше — перший
      // файл у дереві, щоб юзер не дивився на пусту праву панель.
      const candidate = findFileInTree(tree, (settings as any).dp2LastFile as string | undefined)
        ?? findFirstFile(tree);
      if (candidate) {
        try { await get().loadFile(candidate); } catch {}
      }

      // Фоновий перерахунок прогресу для всіх файлів — щоб у дереві одразу
      // бачити translated/total без потреби клікати кожен. Виконується після
      // первинного init, не блокує UI.
      window.dp2.fileCountsWorker({ folder: last })
        .then((counts) => {
          const curTree = get().tree;
          if (!curTree) return;
          let nextTree: TreeNode | null = curTree;
          for (const c of counts) {
            nextTree = updateFileStats(nextTree, c.path, c.total, c.translated);
          }
          set({ tree: nextTree });
        })
        .catch(() => {});
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
      const rawTree = await window.dp2.listTree(folder);
      const tree = await withOthersBranch(rawTree);
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
    const gen = ++_loadFileGen;
    set({ loading: true, error: null });
    const stale = () => gen !== _loadFileGen;
    try {
      let rawForTree = await window.dp2.readFile(fullPath);
      if (stale()) return;
      let restoredFromAutosave = false;

      // Якщо є autosave свіжіший за файл — пропонуємо відновити. Це сценарій
      // крашу/закриття без Ctrl+S: незбережені правки сидять у sidecar.
      const auto = await window.dp2.readAutosave(fullPath);
      if (stale()) return;
      if (auto && auto.autosaveMtime > auto.originalMtime + 100) {
        const ago = Math.max(1, Math.round((Date.now() - auto.autosaveMtime) / 60000));
        const yes = await showConfirm(
          t("autosave.recover.title"),
          t("autosave.recover.body", { minutes: ago }),
        );
        if (stale()) return;
        if (yes) {
          rawForTree = auto.content;
          restoredFromAutosave = true;
        } else {
          try { await window.dp2.deleteAutosave(fullPath); } catch {}
        }
      }

      const tree = JSON.parse(rawForTree);

      let originalTree: any = null;
      const bak = await window.dp2.readBackup(fullPath);
      if (stale()) return;
      if (bak) {
        try { originalTree = JSON.parse(bak); } catch { /* corrupted, ignore */ }
      }

      const entries = flatten(fullPath, tree, originalTree);
      if (stale()) return;
      set({
        selectedFilePath: fullPath,
        currentTree: tree,
        entries,
        activeIndex: entries.length ? 0 : null,
        dirty: restoredFromAutosave,
        lastAutosaveAt: null,
        loading: false,
      });
      get().refreshFileMeta(fullPath);
      try { await window.dp2.saveSettings({ dp2LastFile: fullPath }); } catch {}
    } catch (e: any) {
      if (stale()) return;
      set({ loading: false, error: String(e) });
      showError(e, t("toast.loadFailed"));
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
    // Заголовок/speaker мусять бути одно-рядковими. У DP2 поля `m_name`
    // та `m_charaName` іноді містять справжні `\n` (мультирядкові підказки
    // або кілька імен) — якщо їх віддати у .txt як є, наступний рядок
    // стане частиною body і imports підмішає JP до EN-перекладу.
    const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    const exportEntries: ExportEntry[] = entries.map((e, i) => {
      const isSentence = e.kind === "sentence";
      const rawSpeaker = isSentence ? (e.charaName || e.charaNameJp || "") : "";
      const speaker = rawSpeaker ? oneLine(rawSpeaker) || undefined : undefined;
      const hintParts: string[] = [];
      if (e.id) hintParts.push(e.id);
      if (!isSentence && e.itemName) {
        const nm = oneLine(e.itemName);
        if (nm) hintParts.push(nm);
      }
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

  // ── File-level marks (ПКМ → «Перекладено» / «Зредаговано») ─────────────
  async bulkMarkFileTranslated(filePath, mark) {
    const { folder, statuses } = get();
    if (!folder) return { count: 0 };
    try {
      const [raw, bak] = await Promise.all([
        window.dp2.readFile(filePath),
        window.dp2.readBackup(filePath),
      ]);
      const tree = JSON.parse(raw);
      let originalTree: any = null;
      if (bak) { try { originalTree = JSON.parse(bak); } catch {} }
      const entries = flatten(filePath, tree, originalTree);
      const keys = entries.map(dp2StatusKey);
      const map = { ...statuses.entries };
      for (const k of keys) {
        const cur = map[k] ?? {};
        map[k] = { ...cur, markedTranslated: mark ? true : undefined };
      }
      // Файл-level прапор: «всі рядки позначені перекладеними» — щоб FileList
      // міг швидко малювати файл зеленим без перепідрахунку.
      const files = { ...(statuses.files ?? {}) };
      const cur = files[filePath] ?? {};
      files[filePath] = { ...cur, allTranslated: mark ? true : undefined };
      let next: StatusFile = { ...statuses, entries: map, files };
      for (const k of keys) next = pruneEntry(next, k);
      next = pruneFileMeta(next, filePath);
      set({ statuses: next });
      try { await writeStatusFile(statusFilePath(folder), next); } catch {}
      return { count: keys.length };
    } catch (e) {
      console.warn("bulkMarkFileTranslated failed:", e);
      return { count: 0 };
    }
  },

  async setFileEdited(filePath, edited) {
    const { folder, statuses } = get();
    if (!folder) return;
    const files = { ...(statuses.files ?? {}) };
    const cur = files[filePath] ?? {};
    files[filePath] = { ...cur, edited: edited ? true : undefined };
    let next: StatusFile = { ...statuses, files };
    next = pruneFileMeta(next, filePath);
    set({ statuses: next });
    try { await writeStatusFile(statusFilePath(folder), next); } catch {}
  },

  getFileMeta(filePath): FileMeta | undefined {
    return get().statuses.files?.[filePath];
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
    try {
      await window.dp2.writeFile(selectedFilePath, json);
    } catch (e) {
      // Антивірус/lock/permissions — не залишаємо користувача з ілюзією,
      // що файл збережено. dirty залишається true → індикатор горить.
      const msg = e instanceof Error ? e.message : String(e);
      set({ lastSaveError: msg });
      showError(e, t("toast.saveFailed"));
      throw e;
    }
    invalidateTm();
    try { await window.dp2.deleteAutosave(selectedFilePath); } catch {}
    set({ dirty: false, saveTick: get().saveTick + 1, lastAutosaveAt: null, lastSaveError: null });
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
    // Total = лише ті записи, що ПОТРЕБУЮТЬ перекладу (мають латинські літери).
    // Інакше counter (2054/2068) не збігається з фільтром «Untranslated», який
    // виключає числа/empty/«-» через needsTranslation.
    let translatable = 0;
    let translated = 0;
    for (const e of entries) {
      if (!needsTranslation(e)) continue;
      translatable++;
      if (isTranslated(e)) translated++;
    }
    const nextTree = updateFileStats(tree, fullPath, translatable, translated);
    set({ tree: nextTree });
  },

  async refreshOthers() {
    const { tree } = get();
    if (!tree) return;
    // Знімаємо стару Others-гілку перед перебудовою — інакше withOthersBranch
    // побачить уже додану й залишить її як є (хоча воно і ідемпотентне через
    // фільтрацію за `path === r.doneDir`, явно знімаємо для прозорості).
    const stripped: TreeNode = { ...tree, children: (tree.children ?? []).slice() };
    const next = await withOthersBranch(stripped);
    if (next) set({ tree: next });
  },

  previewTmExact(tm) {
    const { entries } = get();
    // Будуємо мапу: normalized(src) → tgt. Якщо для одного src є кілька різних
    // tgt — беремо найдовший (зазвичай повніший переклад). На однакових tgt
    // дублі ігноруються.
    const map = new Map<string, string>();
    for (const t of tm) {
      const k = (t.src ?? "").trim().toLowerCase();
      const v = (t.tgt ?? "").trim();
      if (!k || !v) continue;
      const cur = map.get(k);
      if (!cur || v.length > cur.length) map.set(k, v);
    }
    const matches: Array<{ entryIndex: number; src: string; tgt: string }> = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (isTranslated(e)) continue;
      const src = (e.originalEn ?? "").trim();
      if (!src) continue;
      const tgt = map.get(src.toLowerCase());
      if (!tgt) continue;
      // Уникаємо застосовувати tgt, який дорівнює src (це не переклад).
      if (tgt.toLowerCase() === src.toLowerCase()) continue;
      matches.push({ entryIndex: i, src, tgt });
    }
    return { matches };
  },

  applyTmExact(tm) {
    const { entries, currentTree, selectedFilePath } = get();
    if (!currentTree) return 0;
    const { matches } = get().previewTmExact(tm);
    if (matches.length === 0) return 0;
    get().pushUndo("apply-tm-exact");
    const next = entries.slice();
    let applied = 0;
    for (const m of matches) {
      const e = next[m.entryIndex];
      if (!e) continue;
      const ok = applyEdit(currentTree, e.locator, e.charaName ?? "", m.tgt);
      if (!ok) continue;
      next[m.entryIndex] = { ...e, en: m.tgt };
      applied++;
    }
    if (applied > 0) {
      invalidateTm();
      set({ entries: next, dirty: true });
      if (selectedFilePath) get().refreshFileMeta(selectedFilePath);
    }
    return applied;
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
