// DP1 mes_all.json parser helpers.
// Запис у JSON: { Id1, Id2, Flag1, Flag2, FirstSegmentLenght, Text, EmptyRecord }.
// Маркери всередині Text: {NEXT_SEGMENT}, {NEXT_FRAME id=N}, {ICON id=N},
// {SET_COLOR color=N, R, G}, {RESET_COLOR}, {SET_SPACING value=N}, {BR},
// {NO_OP:0xNNNN}, {UNK:0xNNNN}.

import type { Dp1Record } from "../../lib/ipc";

const HAS_CYR = /[Ѐ-ӿ]/;

/** Перекладений == текст відрізняється від оригіналу І містить кирилицю. */
export function isDp1RecordTranslated(orig: string, done: string): boolean {
  if (done === orig) return false;
  return HAS_CYR.test(done);
}

/** Витягує всі {…} токени з тексту. Нормалізує `=N` для числових параметрів. */
export function extractDp1Tokens(text: string): string[] {
  const tokens = text.match(/\{[^{}]+\}/g) ?? [];
  return tokens.map((t) => t.replace(/=\d+/g, "=N"));
}

/** Знаходить розбіжності у наборі токенів між оригіналом та перекладом. */
export function dp1MarkerIssues(orig: string, done: string): { missing: string[]; extra: string[] } {
  const oTokens = extractDp1Tokens(orig);
  const dTokens = extractDp1Tokens(done);
  const oCounts = new Map<string, number>();
  for (const t of oTokens) oCounts.set(t, (oCounts.get(t) || 0) + 1);
  const dCounts = new Map<string, number>();
  for (const t of dTokens) dCounts.set(t, (dCounts.get(t) || 0) + 1);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, v] of oCounts) {
    const dv = dCounts.get(k) || 0;
    if (dv < v) missing.push(k + (v - dv > 1 ? `×${v - dv}` : ""));
  }
  for (const [k, v] of dCounts) {
    const ov = oCounts.get(k) || 0;
    if (v > ov) extra.push(k + (v - ov > 1 ? `×${v - ov}` : ""));
  }
  return { missing, extra };
}

/** Швидка перевірка: чи є хоч одне порушення цілісності токенів. */
export function dp1HasMarkerIssues(orig: string, done: string): boolean {
  if (orig === done) return false;
  const { missing, extra } = dp1MarkerIssues(orig, done);
  return missing.length > 0 || extra.length > 0;
}

/**
 * Перерахунок FirstSegmentLenght. Той самий алгоритм, що у main.cjs
 * (dp1ComputeFsl). Backend все одно перевіряє і ставить значення —
 * це лише для preview-бейджу у UI.
 */
export function dp1ComputeFsl(text: string): number {
  if (!text) return 0;
  const re = /\{NEXT_SEGMENT\}|\{NEXT_FRAME\b[^}]*\}/;
  const m = text.match(re);
  const head = m ? text.slice(0, m.index) : text;
  return head.replace(/\{[^{}]*\}/g, "").length;
}

export type { Dp1Record };
