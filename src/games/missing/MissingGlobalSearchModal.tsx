import { useEffect, useState } from "react";
import { parseMissingMsg } from "./parser";

interface FileItem {
  name: string;
  file: string;
  origPath: string;
  donePath: string;
  hasDone: boolean;
}

interface Hit {
  file: string;
  idx: number;
  msgEnum: number;
  original: string;
  current: string;
  matchedIn: "orig" | "current" | "both";
}

interface Props {
  open: boolean;
  onClose: () => void;
  files: FileItem[];
  onGoTo: (file: FileItem, idx: number) => void;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function runSearch(files: FileItem[], query: string, caseSensitive: boolean): Promise<Hit[]> {
  const W = window.dp2 as unknown as { missingTextRead: (p: string) => Promise<{ ok: boolean; base64?: string }> };
  const hits: Hit[] = [];
  const q = caseSensitive ? query : query.toLowerCase();
  if (!q) return hits;
  for (const f of files) {
    const sourcePath = f.hasDone ? f.donePath : f.origPath;
    const [oR, dR] = await Promise.all([
      W.missingTextRead(f.origPath),
      W.missingTextRead(sourcePath),
    ]);
    if (!oR.ok || !oR.base64) continue;
    const orig = parseMissingMsg(b64ToBytes(oR.base64));
    const done = dR.ok && dR.base64 ? parseMissingMsg(b64ToBytes(dR.base64)) : orig;
    for (let i = 0; i < orig.entries.length; i++) {
      const o = orig.entries[i]?.text ?? "";
      const d = done.entries[i]?.text ?? "";
      const oCheck = caseSensitive ? o : o.toLowerCase();
      const dCheck = caseSensitive ? d : d.toLowerCase();
      const inO = oCheck.includes(q);
      const inD = dCheck.includes(q);
      if (!inO && !inD) continue;
      hits.push({
        file: f.name,
        idx: i,
        msgEnum: orig.entries[i]?.msgEnum ?? -1,
        original: o,
        current: d,
        matchedIn: inO && inD ? "both" : inO ? "orig" : "current",
      });
      if (hits.length >= 500) return hits;
    }
  }
  return hits;
}

function highlight(text: string, query: string, caseSensitive: boolean) {
  if (!query) return text;
  const flags = caseSensitive ? "g" : "gi";
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${safe})`, flags));
  return parts.map((p, i) =>
    i % 2 === 1
      ? <mark key={i} className="bg-[var(--accent)]/30 text-[var(--text)] px-0.5 rounded-sm">{p}</mark>
      : <span key={i}>{p}</span>
  );
}

export function MissingGlobalSearchModal({ open, onClose, files, onGoTo }: Props) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) { setDraft(""); setQuery(""); setHits([]); return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (draft === query) return;
    const id = setTimeout(() => setQuery(draft), 250);
    return () => clearTimeout(id);
  }, [draft, query]);

  useEffect(() => {
    if (!open) return;
    if (!query.trim()) { setHits([]); return; }
    let cancelled = false;
    setLoading(true);
    runSearch(files, query.trim(), caseSensitive)
      .then((r) => { if (!cancelled) setHits(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, caseSensitive, open, files]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70" onClick={onClose}>
      <div className="dp-card w-full max-w-4xl flex flex-col" style={{ maxHeight: "85vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">Глобальний пошук</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              {loading ? "Шукаю…" : query ? `${hits.length} результатів у ${files.length} файлах${hits.length >= 500 ? " (обрізано до 500)" : ""}` : "Введи запит — шукаємо по оригіналу та перекладу"}
            </p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-2 flex-wrap">
          <input
            autoFocus
            type="text"
            className="dp-input flex-1 min-w-[200px]"
            placeholder="Що шукаємо? (Ctrl+Shift+F)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)] cursor-pointer">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            Aa
          </label>
        </div>

        <div className="flex-1 overflow-auto">
          {!query.trim() && (
            <p className="py-10 text-center text-[12px] text-[var(--text-faint)] italic">Почни писати, щоб побачити результати</p>
          )}
          {query.trim() && !loading && hits.length === 0 && (
            <p className="py-10 text-center text-[12px] text-[var(--text-faint)]">Нічого не знайдено.</p>
          )}
          {hits.length > 0 && (
            <div className="divide-y divide-[var(--border-soft)]">
              {hits.map((h, i) => {
                const f = files.find((x) => x.name === h.file);
                return (
                  <button
                    key={i}
                    className="w-full text-left px-5 py-2.5 hover:bg-[var(--bg-elev,var(--row-hover))] transition-colors"
                    onClick={() => { if (f) { onGoTo(f, h.idx); onClose(); } }}
                  >
                    <div className="flex items-center gap-2 text-[10.5px] mb-1">
                      <span className="font-mono text-[var(--accent)]">{h.file}</span>
                      <span className="text-[var(--text-faint)]">#{h.idx}</span>
                      {h.msgEnum >= 0 && <span className="font-mono text-[var(--text-faint)]">enum {h.msgEnum}</span>}
                      <span className="text-[var(--text-faint)] ml-auto">{h.matchedIn === "both" ? "EN+UA" : h.matchedIn === "orig" ? "EN" : "UA"}</span>
                    </div>
                    {(h.matchedIn === "orig" || h.matchedIn === "both") && (
                      <p className="text-[11.5px] text-[var(--text-muted)] line-clamp-1 mb-0.5">
                        <span className="text-[var(--text-faint)] mr-1">EN:</span>{highlight(h.original, query, caseSensitive)}
                      </p>
                    )}
                    {(h.matchedIn === "current" || h.matchedIn === "both") && (
                      <p className="text-[11.5px] text-[var(--text)] line-clamp-1">
                        <span className="text-[var(--text-faint)] mr-1">UA:</span>{highlight(h.current, query, caseSensitive)}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
