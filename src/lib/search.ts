// Глобальний пошук — тонка обгортка над worker-IPC. Парсинг JSON виконує
// Node worker_threads, тут лише обробка результату для UI.

export type SearchField = "all" | "jp" | "en" | "originalEn" | "charaName";

export interface SearchOptions {
  query: string;
  field: SearchField;
  caseSensitive: boolean;
  regex: boolean;
}

export interface SearchHit {
  filePath: string;
  fileName: string;
  entryIndex: number;
  entry: {
    kind: string;
    id: string;
    charaName?: string;
  };
  matchedField: Exclude<SearchField, "all">;
  matchedText: string;
}

export interface SearchResult {
  hits: SearchHit[];
  byFile: Map<string, SearchHit[]>;
  truncated: boolean;
}

export async function searchAll(folder: string, opts: SearchOptions): Promise<SearchResult> {
  if (!opts.query.trim()) return { hits: [], byFile: new Map(), truncated: false };
  if (opts.regex) {
    try { new RegExp(opts.query); }
    catch { return { hits: [], byFile: new Map(), truncated: false }; }
  }

  const raw = await window.dp2.searchAllWorker({ folder, opts });
  const hits: SearchHit[] = raw.hits.map((h) => ({
    filePath: h.filePath,
    fileName: h.fileName,
    entryIndex: h.entryIndex,
    matchedField: h.matchedField as Exclude<SearchField, "all">,
    matchedText: h.matchedText,
    entry: {
      kind: h.entry.kind,
      id: h.entry.id,
      charaName: h.entry.charaName,
    },
  }));
  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits) {
    let arr = byFile.get(h.filePath);
    if (!arr) { arr = []; byFile.set(h.filePath, arr); }
    arr.push(h);
  }
  return { hits, byFile, truncated: raw.truncated };
}

/** Розбити рядок на сегменти {text, hit:boolean} за матчем — для підсвічування у UI. */
export function highlight(text: string, opts: SearchOptions): Array<{ text: string; hit: boolean }> {
  const q = opts.query.trim();
  if (!q || !text) return [{ text, hit: false }];
  let re: RegExp;
  try {
    if (opts.regex) {
      re = new RegExp(q, opts.caseSensitive ? "g" : "gi");
    } else {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(escaped, opts.caseSensitive ? "g" : "gi");
    }
  } catch {
    return [{ text, hit: false }];
  }
  const out: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), hit: false });
    out.push({ text: m[0], hit: true });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
