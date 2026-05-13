// Translation Memory: збирає перекладені пари EN→UA з обох корпусів (DP2 + DP1)
// у Node worker_thread, потім зберігає в renderer-кеші. Збіги шукаються вже
// в-пам'яті у renderer.

export type TmSource = "dp2" | "dp1";

export interface TmEntry {
  source: TmSource;
  src: string;
  tgt: string;
  jp: string;
  filePath: string;
  fileName: string;
  charaName?: string;
}

export interface TmMatch {
  entry: TmEntry;
  score: number; // 1.0 = exact, <1.0 = fuzzy
}

interface CacheKey {
  dp2Folder: string | null;
  dp1EngPath: string | null;
}

let cache: { key: CacheKey; entries: TmEntry[] } | null = null;

function sameKey(a: CacheKey, b: CacheKey) {
  return a.dp2Folder === b.dp2Folder && a.dp1EngPath === b.dp1EngPath;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

export async function buildTm(
  dp2Folder: string | null,
  dp1EngPath: string | null,
  force = false
): Promise<TmEntry[]> {
  const key: CacheKey = { dp2Folder, dp1EngPath };
  if (!force && cache && sameKey(cache.key, key)) return cache.entries;
  const raw = await window.dp2.buildTmWorker({ dp2Folder, dp1EngPath });
  const entries: TmEntry[] = raw.map((r) => ({
    source: r.source,
    src: r.src,
    tgt: r.tgt,
    jp: r.jp,
    filePath: r.filePath,
    fileName: r.fileName,
    charaName: r.charaName,
  }));
  cache = { key, entries };
  return entries;
}

export function invalidateTm() {
  cache = null;
}

export function findMatches(
  tm: TmEntry[],
  query: string,
  excludeTgt: string,
  limit = 6,
  sourceFilter: TmSource | null = null
): TmMatch[] {
  const q = query.trim();
  if (!q) return [];
  const qLower = q.toLowerCase();
  // Для длинних запитів пропускаємо fuzzy — рахуємо лише exact.
  const longQuery = q.length > 200;
  const qTokens = longQuery ? null : tokenize(q);

  const exact: TmMatch[] = [];
  const fuzzy: TmMatch[] = [];

  for (const e of tm) {
    if (!e.src) continue;
    if (sourceFilter && e.source !== sourceFilter) continue;
    if (e.src.length === q.length && e.src.toLowerCase() === qLower) {
      if (e.tgt === excludeTgt) continue;
      exact.push({ entry: e, score: 1 });
      continue;
    }
    if (!qTokens) continue;
    const tokens = tokenize(e.src);
    const s = jaccard(qTokens, tokens);
    if (s >= 0.55) fuzzy.push({ entry: e, score: s });
  }

  exact.sort((a, b) => a.entry.tgt.localeCompare(b.entry.tgt));
  fuzzy.sort((a, b) => b.score - a.score);

  const seenTgt = new Set<string>();
  const merged: TmMatch[] = [];
  for (const m of [...exact, ...fuzzy]) {
    if (seenTgt.has(m.entry.tgt)) continue;
    seenTgt.add(m.entry.tgt);
    merged.push(m);
    if (merged.length >= limit) break;
  }
  return merged;
}
