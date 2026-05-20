// DP1 Text Editor state.
//
// In-memory модель: пара (`original`, `done`) — масиви Dp1Record однакової
// довжини. `visibleIndices` — індекси у цих масивах, де EmptyRecord:false
// (плейсхолдери ховаємо з UI). Усі дії — суто з in-memory `done`; на диск
// летимо лише через `saveAll()` (debounce-autosave або Ctrl+S).
//
// Сильно нагадує lib/store.ts (DP2), але дані плоскі — без вкладених
// sheet/list/text-array. Тож зберігаємо власний store; компоненти можуть
// бути спільні (Resizer тощо), а основна таблиця/Monaco — DP1-specific.

import { create } from "zustand";
import type { Dp1Record, Dp1Meta } from "../../lib/ipc";
import { isDp1RecordTranslated, dp1HasMarkerIssues } from "./parser";

export type Dp1Filter = "all" | "translated" | "untranslated" | "issues";

interface Dp1State {
  loading: boolean;
  error: string | null;

  // Дані з диску.
  original: Dp1Record[];
  done: Dp1Record[];
  meta: Dp1Meta | null;

  // Похідне: індекси у `original`/`done`, які треба показувати (EmptyRecord:false).
  visibleIndices: number[];

  // UI-state.
  selectedIndex: number | null; // абсолютний індекс у original/done (не filtered)
  searchQuery: string;
  filter: Dp1Filter;

  // Dirty/save.
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  saveTick: number;

  // ── actions ───────────────────────────────────────────────────
  init: () => Promise<void>;
  reload: () => Promise<void>;
  setSelectedIndex: (i: number | null) => void;
  setSearchQuery: (q: string) => void;
  setFilter: (f: Dp1Filter) => void;
  updateText: (index: number, text: string) => void;
  /** Bulk-update: для batch-replace / TM-autofill. */
  patchTexts: (updates: Array<{ index: number; text: string }>) => void;
  saveAll: () => Promise<{ ok: boolean; error?: string }>;
}

export const useDp1Store = create<Dp1State>((set, get) => ({
  loading: false,
  error: null,
  original: [],
  done: [],
  meta: null,
  visibleIndices: [],
  selectedIndex: null,
  searchQuery: "",
  filter: "all",
  dirty: false,
  saving: false,
  lastSavedAt: null,
  saveTick: 0,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const r = await window.dp2.dp1TextLoad();
      if (!r.ok || !r.original || !r.done) {
        set({ loading: false, error: r.error ?? "load failed" });
        return;
      }
      const original = r.original;
      const done = r.done;
      const visibleIndices: number[] = [];
      for (let i = 0; i < original.length; i++) {
        if (!original[i]?.EmptyRecord) visibleIndices.push(i);
      }
      set({
        loading: false,
        original,
        done,
        meta: r.meta ?? null,
        visibleIndices,
        selectedIndex: visibleIndices[0] ?? null,
        dirty: false,
      });
    } catch (e: unknown) {
      set({ loading: false, error: String((e as Error)?.message ?? e) });
    }
  },

  reload: async () => { await get().init(); },

  setSelectedIndex: (i) => set({ selectedIndex: i }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setFilter: (f) => set({ filter: f }),

  updateText: (index, text) => {
    const done = get().done;
    if (!done[index]) return;
    if (done[index].Text === text) return;
    const next = done.slice();
    next[index] = { ...done[index], Text: text };
    set({ done: next, dirty: true });
  },

  patchTexts: (updates) => {
    if (!updates.length) return;
    const done = get().done.slice();
    let changed = 0;
    for (const u of updates) {
      const cur = done[u.index];
      if (!cur || cur.Text === u.text) continue;
      done[u.index] = { ...cur, Text: u.text };
      changed++;
    }
    if (changed > 0) set({ done, dirty: true });
  },

  saveAll: async () => {
    set({ saving: true });
    try {
      const r = await window.dp2.dp1TextSave({ done: get().done });
      if (r.ok) {
        set((s) => ({
          saving: false,
          dirty: false,
          lastSavedAt: Date.now(),
          saveTick: s.saveTick + 1,
        }));
      } else {
        set({ saving: false });
      }
      return r;
    } catch (e: unknown) {
      set({ saving: false });
      return { ok: false, error: String((e as Error)?.message ?? e) };
    }
  },
}));

/**
 * Похідний обчислений масив `Dp1FilteredRow` — відфільтровані+знайдені
 * рядки для таблиці. Винесено окремо, щоб таблиця могла useMemo з потрібними
 * залежностями (selector сам по собі робить shallow-equal лише на верхньому
 * рівні масиву, тож зручніше викликати з компонента).
 */
export interface Dp1Row {
  index: number;
  original: Dp1Record;
  done: Dp1Record;
  translated: boolean;
  hasIssues: boolean;
}

export function buildDp1Rows(state: Pick<Dp1State, "original" | "done" | "visibleIndices" | "filter" | "searchQuery">): Dp1Row[] {
  const { original, done, visibleIndices, filter, searchQuery } = state;
  const q = searchQuery.trim().toLowerCase();
  const out: Dp1Row[] = [];
  for (const i of visibleIndices) {
    const o = original[i];
    const d = done[i];
    if (!o || !d) continue;
    const translated = isDp1RecordTranslated(o.Text ?? "", d.Text ?? "");
    const hasIssues = translated && dp1HasMarkerIssues(o.Text ?? "", d.Text ?? "");
    // Фільтр
    if (filter === "translated" && !translated) continue;
    if (filter === "untranslated" && translated) continue;
    if (filter === "issues" && !hasIssues) continue;
    // Пошук — по index/Id1/Id2/original/done
    if (q) {
      const hay = [
        String(i),
        `${o.Id1}/${o.Id2}`,
        (o.Text ?? "").toLowerCase(),
        (d.Text ?? "").toLowerCase(),
      ].join("\n");
      if (!hay.includes(q)) continue;
    }
    out.push({ index: i, original: o, done: d, translated, hasIssues });
  }
  return out;
}

export function getDp1Counts(state: Pick<Dp1State, "original" | "done" | "visibleIndices">) {
  let translated = 0, withIssues = 0;
  for (const i of state.visibleIndices) {
    const o = state.original[i];
    const d = state.done[i];
    if (!o || !d) continue;
    const t = isDp1RecordTranslated(o.Text ?? "", d.Text ?? "");
    if (t) translated++;
    if (t && dp1HasMarkerIssues(o.Text ?? "", d.Text ?? "")) withIssues++;
  }
  return {
    total: state.visibleIndices.length,
    translated,
    untranslated: state.visibleIndices.length - translated,
    withIssues,
  };
}
