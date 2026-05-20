// Zustand store для The Good Life — окремий від DP1/DP2, бо інший формат
// файла (бінарка через IPC). Workfile = <bin>.txt поряд з бінаркою; pack —
// записує нову бінарку поверх оригіналу (з .bak).

import { create } from "zustand";
import { t } from "../../lib/i18n";
import {
  flattenTgl,
  isTglTranslated,
  tglEscapeForTxt,
  tglTxtToLines,
  tglUnescapeFromTxt,
  type TglEntry,
  type TglRecord,
} from "./parser";
import {
  emptyStatusFile,
  pruneEntry,
  readStatusFile,
  writeStatusFile,
  type StatusFile,
  type StatusKind,
} from "../../lib/status";
import { recordTranslation } from "../../lib/metrics";

function tglStatusPath(binPath: string): string {
  return binPath + ".status.json";
}

export function tglKey(index: number): string {
  return `idx:${index}`;
}

export type TglFilter =
  | "all" | "translated" | "untranslated"
  | "draft" | "review" | "approved" | "bookmarks";

interface TglState {
  binPath: string | null;
  records: TglRecord[];
  uaTexts: string[];
  entries: TglEntry[];
  activeIndex: number | null;
  dirty: boolean;
  search: string;
  filter: TglFilter;
  loading: boolean;
  error: string | null;
  saveTick: number;
  lastAutosaveAt: number | null;
  statuses: StatusFile;

  init: () => Promise<void>;
  loadBin: (path: string) => Promise<void>;
  setSearch: (s: string) => void;
  setFilter: (f: TglFilter) => void;
  setActive: (i: number | null) => void;
  step: (delta: number) => void;
  jumpToNextUntranslated: () => boolean;
  copyOriginalToTranslation: () => void;
  updateActive: (text: string) => void;
  saveWorkfile: () => Promise<void>;
  autosave: () => Promise<void>;
  pack: () => Promise<{ outputPath?: string; bakPath?: string; translated?: number; fallback?: number; size?: number; error?: string }>;

  setEntryStatus: (i: number, status: StatusKind | undefined) => Promise<void>;
  toggleEntryBookmark: (i: number) => Promise<void>;
  bulkSetStatus: (indices: number[], status: StatusKind | undefined) => Promise<void>;
  bulkCopyOriginalToTranslation: (indices: number[]) => void;
  bulkTrim: (indices: number[]) => void;

  exportTxt: () => { fileName: string; content: string } | null;
  importTxtContent: (raw: string) => Promise<{
    applied: number;
    mismatch?: {
      txtLines: number;
      binLines: number;
      // Декілька рядків навколо першої різниці: i — позиція у тексті,
      // txt — рядок з .txt (якщо є), bin — оригінал з bin (якщо є).
      diffSamples: Array<{ i: number; txt?: string; bin?: string }>;
    };
  }>;

  // Undo для масових операцій
  undoStack: Array<{ label: string; uaTexts: string[]; entries: TglEntry[] }>;
  pushUndo: (label: string) => void;
  canUndo: () => boolean;
  undo: () => boolean;
}

export const useTglStore = create<TglState>((set, get) => ({
  binPath: null,
  records: [],
  uaTexts: [],
  entries: [],
  activeIndex: null,
  dirty: false,
  search: "",
  filter: "all",
  loading: false,
  error: null,
  saveTick: 0,
  lastAutosaveAt: null,
  statuses: emptyStatusFile(),
  undoStack: [],

  async init() {
    try {
      const settings = await window.dp2.getSettings();
      const last = settings.tglBinPath;
      if (last) await get().loadBin(last);
    } catch {}
  },

  async loadBin(path: string) {
    set({ loading: true, error: null });
    try {
      const res = await window.dp2.tglLoad(path);
      if (res.error || !res.records || !res.ua) throw new Error(res.error || t("tgl.err.loadFail"));
      const records = res.records;
      const uaTexts = res.ua;
      const entries = flattenTgl(records, uaTexts);
      const statuses = await readStatusFile(tglStatusPath(path));
      set({
        binPath: path,
        records,
        uaTexts,
        entries,
        statuses,
        activeIndex: entries.length ? 0 : null,
        dirty: false,
        loading: false,
      });
    } catch (e: any) {
      set({ loading: false, error: String(e?.message ?? e) });
    }
  },

  setSearch(s) { set({ search: s }); },
  setFilter(f) { set({ filter: f }); },
  setActive(i) { set({ activeIndex: i }); },

  step(delta) {
    const { entries, activeIndex } = get();
    if (!entries.length) return;
    const cur = activeIndex ?? 0;
    const n = entries.length;
    const next = ((cur + delta) % n + n) % n;
    set({ activeIndex: next });
  },

  jumpToNextUntranslated() {
    const { entries, activeIndex } = get();
    if (!entries.length) return false;
    const start = (activeIndex ?? -1) + 1;
    const n = entries.length;
    for (let off = 0; off < n; off++) {
      const i = (start + off) % n;
      if (!isTglTranslated(entries[i])) {
        set({ activeIndex: i });
        return true;
      }
    }
    return false;
  },

  copyOriginalToTranslation() {
    const { activeIndex, entries } = get();
    if (activeIndex === null) return;
    const e = entries[activeIndex];
    if (!e) return;
    get().updateActive(e.original);
  },

  updateActive(text) {
    const { activeIndex, entries, uaTexts } = get();
    if (activeIndex === null) return;
    const e = entries[activeIndex];
    if (!e) return;
    const nextUa = uaTexts.slice();
    nextUa[e.index] = text;
    const nextEntries = entries.slice();
    nextEntries[activeIndex] = { ...e, ua: text };
    set({ uaTexts: nextUa, entries: nextEntries, dirty: true });
    const before = e.ua || "";
    const cyr = /[Ѐ-ӿ]/;
    const wasTrans = before && before !== e.original && cyr.test(before);
    const isTrans = text && text !== e.original && cyr.test(text);
    if (isTrans && !wasTrans) recordTranslation(text, before);
  },

  async saveWorkfile() {
    const { binPath, uaTexts } = get();
    if (!binPath) return;
    const res = await window.dp2.tglSaveWorkfile({ binPath, ua: uaTexts });
    if (res.error) throw new Error(res.error);
    set({ saveTick: get().saveTick + 1, dirty: false });
  },

  async autosave() {
    const { binPath, dirty } = get();
    if (!binPath || !dirty) return;
    try {
      await get().saveWorkfile();
      set({ lastAutosaveAt: Date.now() });
    } catch {}
  },

  async pack() {
    const { binPath, uaTexts } = get();
    if (!binPath) return { error: t("tgl.err.notLoaded") };
    // КРИТИЧНО: pack читає workfile з диска. Якщо saveWorkfile впав
    // (locked file, antivirus, no space) — pack відправить у бін СТАРИЙ
    // вміст і ми ніколи цього не помітимо. Раніше catch{} ковтав помилку
    // і пакувало stale workfile → битий патч у гру.
    try {
      await get().saveWorkfile();
    } catch (e) {
      return { error: `Не вдалося зберегти workfile перед паком: ${e instanceof Error ? e.message : String(e)}` };
    }
    const res = await window.dp2.tglPack({ binPath, ua: uaTexts });
    return res;
  },

  async setEntryStatus(i, status) {
    const { binPath, statuses } = get();
    if (!binPath) return;
    const key = tglKey(i);
    const cur = statuses.entries[key] ?? {};
    let next: StatusFile = {
      ...statuses,
      entries: { ...statuses.entries, [key]: { ...cur, status } },
    };
    next = pruneEntry(next, key);
    set({ statuses: next });
    try { await writeStatusFile(tglStatusPath(binPath), next); } catch {}
  },

  async toggleEntryBookmark(i) {
    const { binPath, statuses } = get();
    if (!binPath) return;
    const key = tglKey(i);
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
    try { await writeStatusFile(tglStatusPath(binPath), next); } catch {}
  },

  async bulkSetStatus(indices, status) {
    const { binPath, statuses } = get();
    if (!binPath || !indices.length) return;
    const map = { ...statuses.entries };
    for (const i of indices) {
      const key = tglKey(i);
      map[key] = { ...(map[key] ?? {}), status };
    }
    let next: StatusFile = { ...statuses, entries: map };
    for (const i of indices) next = pruneEntry(next, tglKey(i));
    set({ statuses: next });
    try { await writeStatusFile(tglStatusPath(binPath), next); } catch {}
  },

  bulkCopyOriginalToTranslation(indices) {
    const { entries, uaTexts } = get();
    if (!indices.length) return;
    const nextUa = uaTexts.slice();
    const nextEntries = entries.slice();
    let changed = 0;
    for (const i of indices) {
      const e = entries[i];
      if (!e) continue;
      const src = e.original ?? "";
      if (!src) continue;
      nextUa[e.index] = src;
      nextEntries[i] = { ...e, ua: src };
      changed++;
    }
    if (changed > 0) set({ uaTexts: nextUa, entries: nextEntries, dirty: true });
  },

  bulkTrim(indices) {
    const { entries, uaTexts } = get();
    if (!indices.length) return;
    const nextUa = uaTexts.slice();
    const nextEntries = entries.slice();
    let changed = 0;
    for (const i of indices) {
      const e = entries[i];
      if (!e) continue;
      const trimmed = e.ua.replace(/^\s+|\s+$/g, "").replace(/[ \t]+\n/g, "\n");
      if (trimmed === e.ua) continue;
      nextUa[e.index] = trimmed;
      nextEntries[i] = { ...e, ua: trimmed };
      changed++;
    }
    if (changed > 0) set({ uaTexts: nextUa, entries: nextEntries, dirty: true });
  },

  exportTxt() {
    const { binPath, uaTexts, records } = get();
    if (!binPath || !records.length) return null;
    const fileName = (binPath.split(/[\\/]/).pop() ?? "English") + ".txt";
    const body = uaTexts.map((s, i) => tglEscapeForTxt(typeof s === "string" ? s : records[i].en)).join("\r\n");
    return { fileName, content: body };
  },

  async importTxtContent(raw) {
    const { entries, uaTexts, records } = get();
    if (!records.length) return { applied: 0 };
    const lines = tglTxtToLines(raw);
    if (lines.length !== records.length) {
      // Підбираємо кілька прикладів навколо першої точки розбіжності, щоб
      // користувач міг побачити, ЯКИЙ рядок у .txt не той (зазвичай
      // розщеплений на два newline'ом усередині перекладу).
      const diffSamples: Array<{ i: number; txt?: string; bin?: string }> = [];
      const maxLen = Math.max(lines.length, records.length);
      let firstDiff = -1;
      for (let i = 0; i < maxLen; i++) {
        const txt = i < lines.length ? tglUnescapeFromTxt(lines[i]) : undefined;
        const bin = i < records.length ? records[i].en : undefined;
        if (txt === undefined || bin === undefined || txt !== bin) { firstDiff = i; break; }
      }
      if (firstDiff < 0) firstDiff = Math.min(lines.length, records.length);
      const from = Math.max(0, firstDiff - 1);
      const to = Math.min(maxLen, firstDiff + 5);
      for (let i = from; i < to; i++) {
        diffSamples.push({
          i,
          txt: i < lines.length ? tglUnescapeFromTxt(lines[i]) : undefined,
          bin: i < records.length ? records[i].en : undefined,
        });
      }
      return { applied: 0, mismatch: { txtLines: lines.length, binLines: records.length, diffSamples } };
    }
    get().pushUndo("import-txt");
    const nextUa = uaTexts.slice();
    const nextEntries = entries.slice();
    let applied = 0;
    for (let i = 0; i < records.length; i++) {
      const decoded = tglUnescapeFromTxt(lines[i]);
      if (nextUa[i] !== decoded) { nextUa[i] = decoded; applied++; }
      if (nextEntries[i]) nextEntries[i] = { ...nextEntries[i], ua: decoded };
    }
    if (applied > 0) {
      set({ uaTexts: nextUa, entries: nextEntries, dirty: true });
      // Одразу синхронізуємо <bin>.txt-workfile, щоб після перезапуску
      // прогрес підтягнувся з диска без повторного імпорту.
      try { await get().saveWorkfile(); } catch {}
    }
    return { applied };
  },

  pushUndo(label) {
    const { undoStack, uaTexts, entries } = get();
    const snapshot = { label, uaTexts: uaTexts.slice(), entries: entries.slice() };
    const nextStack = [...undoStack, snapshot];
    while (nextStack.length > 10) nextStack.shift();
    set({ undoStack: nextStack });
  },

  canUndo() { return get().undoStack.length > 0; },

  undo() {
    const { undoStack } = get();
    if (!undoStack.length) return false;
    const snap = undoStack[undoStack.length - 1];
    set({
      uaTexts: snap.uaTexts,
      entries: snap.entries,
      undoStack: undoStack.slice(0, -1),
      dirty: true,
    });
    return true;
  },
}));
