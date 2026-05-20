// DP1 Web Worker: тримає копію `original` + `done` у пам'яті worker'а
// і обчислює filter / counts поза main thread. На 17K записах це знімає
// блокування UI під час пошуку.

import type { Dp1Record } from "../../lib/ipc";

type Filter = "all" | "translated" | "untranslated" | "issues";

interface RowSummary {
  index: number;
  translated: boolean;
  hasIssues: boolean;
}

interface Counts {
  total: number;
  translated: number;
  untranslated: number;
  withIssues: number;
}

const HAS_CYR = /[Ѐ-ӿ]/;
const TOKEN_RE = /\{[^{}]+\}/g;

function normToken(t: string): string {
  return t.replace(/=\d+/g, "=N");
}

function hasMarkerIssues(orig: string, done: string): boolean {
  if (orig === done) return false;
  const o = (orig.match(TOKEN_RE) || []).map(normToken);
  const d = (done.match(TOKEN_RE) || []).map(normToken);
  const oc = new Map<string, number>();
  for (const t of o) oc.set(t, (oc.get(t) || 0) + 1);
  const dc = new Map<string, number>();
  for (const t of d) dc.set(t, (dc.get(t) || 0) + 1);
  for (const [k, v] of oc) if ((dc.get(k) || 0) !== v) return true;
  for (const [k, v] of dc) if ((oc.get(k) || 0) !== v) return true;
  return false;
}

interface State {
  original: Dp1Record[];
  done: Dp1Record[];
  visibleIndices: number[];
  // Кешований per-row статус (translated/hasIssues). Перераховуємо лише
  // коли змінюється `done[i]` через `updateOne`.
  status: Map<number, { translated: boolean; hasIssues: boolean }>;
}

let state: State | null = null;

function recomputeStatus(i: number) {
  if (!state) return;
  const o = state.original[i];
  const d = state.done[i];
  if (!o || !d) return;
  const oText = o.Text ?? "";
  const dText = d.Text ?? "";
  const translated = oText !== dText && HAS_CYR.test(dText);
  const hasIssues = translated && hasMarkerIssues(oText, dText);
  state.status.set(i, { translated, hasIssues });
}

function computeCounts(): Counts {
  if (!state) return { total: 0, translated: 0, untranslated: 0, withIssues: 0 };
  let translated = 0, withIssues = 0;
  for (const i of state.visibleIndices) {
    const s = state.status.get(i);
    if (s?.translated) translated++;
    if (s?.hasIssues) withIssues++;
  }
  return {
    total: state.visibleIndices.length,
    translated,
    untranslated: state.visibleIndices.length - translated,
    withIssues,
  };
}

function filterRows(filter: Filter, query: string): RowSummary[] {
  if (!state) return [];
  const q = query.trim().toLowerCase();
  const out: RowSummary[] = [];
  for (const i of state.visibleIndices) {
    const s = state.status.get(i);
    if (!s) continue;
    if (filter === "translated" && !s.translated) continue;
    if (filter === "untranslated" && s.translated) continue;
    if (filter === "issues" && !s.hasIssues) continue;
    if (q) {
      const o = state.original[i];
      const d = state.done[i];
      const hay = `${i}\n${o.Id1}/${o.Id2}\n${(o.Text || "").toLowerCase()}\n${(d.Text || "").toLowerCase()}`;
      if (!hay.includes(q)) continue;
    }
    out.push({ index: i, translated: s.translated, hasIssues: s.hasIssues });
  }
  return out;
}

type InMsg =
  | { id: number; type: "init"; original: Dp1Record[]; done: Dp1Record[]; visibleIndices: number[] }
  | { id: number; type: "updateOne"; index: number; text: string }
  | { id: number; type: "query"; filter: Filter; query: string };

self.addEventListener("message", (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  if (msg.type === "init") {
    state = {
      original: msg.original,
      done: msg.done,
      visibleIndices: msg.visibleIndices,
      status: new Map(),
    };
    for (const i of msg.visibleIndices) recomputeStatus(i);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
      id: msg.id, type: "counts", counts: computeCounts(),
    });
  } else if (msg.type === "updateOne") {
    if (!state) return;
    state.done[msg.index] = { ...state.done[msg.index], Text: msg.text };
    recomputeStatus(msg.index);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
      id: msg.id, type: "counts", counts: computeCounts(),
    });
  } else if (msg.type === "query") {
    const rows = filterRows(msg.filter, msg.query);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
      id: msg.id, type: "rows", rows,
    });
  }
});

export {};
