// Окремий Zustand-стор для DP1 — щоб не змішувати з DP2.

import { create } from "zustand";
import { t } from "../../lib/i18n";
import {
  buildDoneRecords,
  flattenDp1,
  isDp1Translated,
  type Dp1Entry,
  type Dp1Record,
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
import { buildTxt, parseTxt, blockToStorage, type ExportEntry } from "../../lib/txtRoundtrip";

function dp1StatusPath(engPath: string): string {
  return engPath.replace(/\.json$/i, ".status.json");
}

export function dp1Key(index: number): string {
  return `idx:${index}`;
}

export type Dp1Filter = "all" | "translated" | "untranslated" | "draft" | "review" | "approved" | "bookmarks";

interface Dp1State {
  /** Шлях до eng.json (або іншого DP1 JSON-дампа). */
  engPath: string | null;
  /** Сирий масив records у пам'яті (для запису назад). */
  records: Dp1Record[];
  /** Окремий масив UA-перекладів за тим самим індексом. */
  uaTexts: string[];
  entries: Dp1Entry[];
  activeIndex: number | null;
  dirty: boolean;
  search: string;
  filter: Dp1Filter;
  loading: boolean;
  error: string | null;
  saveTick: number;
  /** ms таймстамп останнього успішного авто-збереження workfile. */
  lastAutosaveAt: number | null;
  statuses: StatusFile;

  init: () => Promise<void>;
  loadEng: (path: string) => Promise<void>;
  setSearch: (s: string) => void;
  setFilter: (f: Dp1Filter) => void;
  setActive: (i: number | null) => void;
  step: (delta: number) => void;
  jumpToNextUntranslated: () => boolean;
  copyOriginalToTranslation: () => void;
  updateActive: (text: string) => void;
  saveWorkfile: () => Promise<void>;
  /** Debounce-friendly авто-збереження у workfile (alias saveWorkfile + позначка часу). */
  autosave: () => Promise<void>;
  saveDone: () => Promise<string | null>;
  // status helpers
  setEntryStatus: (i: number, status: StatusKind | undefined) => Promise<void>;
  toggleEntryBookmark: (i: number) => Promise<void>;
  bulkSetStatus: (indices: number[], status: StatusKind | undefined) => Promise<void>;
  bulkCopyOriginalToTranslation: (indices: number[]) => void;
  bulkTrim: (indices: number[]) => void;
  exportTxt: () => { fileName: string; content: string } | null;
  importTxtContent: (txt: string) => { applied: number; missing: number };
  // Undo для масових операцій
  undoStack: Array<{ label: string; uaTexts: string[]; entries: Dp1Entry[] }>;
  pushUndo: (label: string) => void;
  canUndo: () => boolean;
  undo: () => boolean;
}

function sha1(_s: string): string {
  // Не потрібен у TS (Workfile зберігаємо просто за індексом-записом).
  // Залишено для майбутньої сумісності з Python workfile (sha1:occurrence).
  return "";
}
void sha1;

export const useDp1Store = create<Dp1State>((set, get) => ({
  engPath: null,
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
      const last = (settings as any).dp1EngPath as string | undefined;
      if (last) await get().loadEng(last);
    } catch {}
  },

  async loadEng(path: string) {
    set({ loading: true, error: null });
    try {
      const raw = await window.dp2.readFile(path);
      const records: Dp1Record[] = JSON.parse(raw);
      if (!Array.isArray(records)) throw new Error(t("dp1.err.expectArray"));

      // Спроба завантажити воркфайл <base>_ua_work.json — простий формат:
      //   { "version": 3, "mode": "by_index", "ua": ["...", "..."] }
      // Якщо знайдемо Python v2 (by_hash_occurrence) — теж зможемо застосувати.
      const workPath = path.replace(/\.json$/i, "_ua_work.json");
      let uaTexts: string[] = records.map((r) => String(r.Text ?? ""));
      try {
        const rawWork = await window.dp2.readFile(workPath);
        const wf = JSON.parse(rawWork);
        if (wf && wf.mode === "by_index" && Array.isArray(wf.ua)) {
          for (let i = 0; i < records.length; i++) {
            if (i < wf.ua.length && typeof wf.ua[i] === "string" && wf.ua[i]) {
              uaTexts[i] = wf.ua[i];
            }
          }
        }
        // Python v2 (by_hash_occurrence) — підтримуємо через Web Crypto sha1.
        else if (wf && wf.mode === "by_hash_occurrence" && wf.ua_by_occ) {
          const enc = new TextEncoder();
          const seen: Record<string, number> = {};
          for (let i = 0; i < records.length; i++) {
            const t = String(records[i].Text ?? "");
            const buf = await crypto.subtle.digest("SHA-1", enc.encode(t));
            const h = Array.from(new Uint8Array(buf))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            seen[h] = (seen[h] ?? 0) + 1;
            const k = `${h}:${seen[h]}`;
            const v = wf.ua_by_occ[k];
            if (typeof v === "string" && v) uaTexts[i] = v;
          }
        }
      } catch {}

      const entries = flattenDp1(records, uaTexts);
      const statuses = await readStatusFile(dp1StatusPath(path));
      set({
        engPath: path,
        records,
        uaTexts,
        entries,
        statuses,
        activeIndex: entries.length ? 0 : null,
        dirty: false,
        loading: false,
      });
      try { await window.dp2.saveSettings({ dp1EngPath: path }); } catch {}
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
      if (!isDp1Translated(entries[i]) && !entries[i].empty) {
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
    // Зарахування в метрики: переклад з'явився (= оригінал → містить кирилицю/інший текст).
    const before = e.ua || "";
    const cyr = /[Ѐ-ӿ]/;
    const wasTrans = before && before !== e.original && cyr.test(before);
    const isTrans = text && text !== e.original && cyr.test(text);
    if (isTrans && !wasTrans) {
      recordTranslation(text, before);
    }
  },

  async saveWorkfile() {
    const { engPath, uaTexts, records } = get();
    if (!engPath) return;
    const workPath = engPath.replace(/\.json$/i, "_ua_work.json");
    // Тримаємо паралельний масив, але порожні рядки/= оригіналу не записуємо
    // (формат by_index — ефективно і просто).
    const trimmed = uaTexts.map((s, i) => {
      const t = String(s ?? "");
      const orig = String(records[i]?.Text ?? "");
      return t && t !== orig ? t : "";
    });
    const payload = { version: 3, mode: "by_index", ua: trimmed };
    await window.dp2.writeFile(workPath, JSON.stringify(payload, null, 2));
    set({ saveTick: get().saveTick + 1, dirty: false });
  },

  async autosave() {
    const { engPath, dirty } = get();
    if (!engPath || !dirty) return;
    try {
      await get().saveWorkfile();
      set({ lastAutosaveAt: Date.now() });
    } catch {}
  },

  async saveDone() {
    const { engPath, records, uaTexts } = get();
    if (!engPath) return null;
    const donePath = engPath.replace(/\.json$/i, "_ua_done.json");
    const out = buildDoneRecords(records, uaTexts);
    await window.dp2.writeFile(donePath, JSON.stringify(out, null, 2));
    // паралельно зберегти й воркфайл
    try { await get().saveWorkfile(); } catch {}
    return donePath;
  },

  async setEntryStatus(i, status) {
    const { engPath, statuses } = get();
    if (!engPath) return;
    const key = dp1Key(i);
    const cur = statuses.entries[key] ?? {};
    let next: StatusFile = {
      ...statuses,
      entries: { ...statuses.entries, [key]: { ...cur, status } },
    };
    next = pruneEntry(next, key);
    set({ statuses: next });
    try { await writeStatusFile(dp1StatusPath(engPath), next); } catch {}
  },

  async toggleEntryBookmark(i) {
    const { engPath, statuses } = get();
    if (!engPath) return;
    const key = dp1Key(i);
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
    try { await writeStatusFile(dp1StatusPath(engPath), next); } catch {}
  },

  async bulkSetStatus(indices, status) {
    const { engPath, statuses } = get();
    if (!engPath || !indices.length) return;
    const map = { ...statuses.entries };
    for (const i of indices) {
      const key = dp1Key(i);
      map[key] = { ...(map[key] ?? {}), status };
    }
    let next: StatusFile = { ...statuses, entries: map };
    for (const i of indices) next = pruneEntry(next, dp1Key(i));
    set({ statuses: next });
    try { await writeStatusFile(dp1StatusPath(engPath), next); } catch {}
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
      const src = (e.original ?? "").trim();
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
    const { entries, engPath } = get();
    if (!entries.length || !engPath) return null;
    const fileName = (engPath.split(/[\\/]/).pop() ?? "export").replace(/\.json$/i, "");
    const HAS_CYR = /[Ѐ-ӿ]/;
    const exportEntries: ExportEntry[] = entries
      .filter((e) => !e.empty)
      .map((e) => {
        // Якщо переклад уже є (UA містить кирилицю і відрізняється від ENG) —
        // експортуємо саме його, щоб людина продовжила; інакше — англ-оригінал.
        const isAlreadyTranslated =
          !!e.ua && e.ua !== e.original && HAS_CYR.test(e.ua);
        return {
          index: e.index + 1,
          speaker: undefined,
          text: isAlreadyTranslated ? e.ua : e.original,
          hint: `${e.id} flags ${e.flags}`,
        };
      });
    const content = buildTxt(`DP1: ${fileName}`, exportEntries);
    return { fileName, content };
  },

  importTxtContent(txt) {
    const { entries, uaTexts } = get();
    get().pushUndo("import-txt");
    const blocks = parseTxt(txt);
    let applied = 0;
    let missing = 0;
    const nextUa = uaTexts.slice();
    const nextEntries = entries.slice();
    for (const b of blocks) {
      const recordIdx = b.index - 1;
      const positional = entries.findIndex((x) => x.index === recordIdx);
      if (positional < 0) { missing++; continue; }
      const { text } = blockToStorage(b);
      nextUa[recordIdx] = text;
      nextEntries[positional] = { ...entries[positional], ua: text };
      applied++;
    }
    if (applied > 0) set({ uaTexts: nextUa, entries: nextEntries, dirty: true });
    return { applied, missing };
  },

  pushUndo(label) {
    const { undoStack, uaTexts, entries } = get();
    const snapshot = { label, uaTexts: uaTexts.slice(), entries: entries.slice() };
    const nextStack = [...undoStack, snapshot];
    while (nextStack.length > 10) nextStack.shift();
    set({ undoStack: nextStack });
  },

  canUndo() {
    return get().undoStack.length > 0;
  },

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
