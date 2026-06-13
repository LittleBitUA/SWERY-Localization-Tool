// Великі модалки D4: Corpus Stats, Global Search, Batch Replace, Glossary.
// Усі мають однаковий D4-стиль (червоні акценти).

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";

function ModalShell({
  title, subtitle, onClose, children, width = "max-w-3xl",
}: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(8,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className={`w-full ${width} max-h-[85vh] rounded-sm flex flex-col`}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "linear-gradient(180deg, #1a0508 0%, #0d0204 100%)",
          border: "1px solid rgba(220,38,38,0.5)",
          boxShadow: "0 0 40px rgba(220,38,38,0.35)",
          color: "#f5e6e6",
        }}
      >
        <header className="px-4 py-2.5 flex items-center justify-between" style={{
          borderBottom: "1px solid rgba(220,38,38,0.3)",
          background: "linear-gradient(90deg, rgba(220,38,38,0.15) 0%, transparent 100%)",
        }}>
          <div>
            <div className="text-[10px] font-bold tracking-[0.3em]" style={{ color: "#dc2626" }}>◆ D4 ◆</div>
            <h2 className="text-[13px] font-semibold" style={{ color: "#fff" }}>{title}</h2>
            {subtitle && <p className="text-[11px] mt-0.5" style={{ color: "rgba(245,230,230,0.55)" }}>{subtitle}</p>}
          </div>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-sm" style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>{children}</div>
      </div>
    </div>
  );
}

// ── #13 Corpus Stats Modal ───────────────────────────────────────
export function D4CorpusStatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [data, setData] = useState<Awaited<ReturnType<typeof window.dp2.d4TextCorpusStatsFull>> | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.dp2.d4TextCorpusStatsFull().then((r) => { setData(r); setLoading(false); });
  }, [open]);
  if (!open) return null;
  const pct = data?.percent ? Math.round(data.percent) : 0;
  return (
    <ModalShell title={t("d4.stats.title")} onClose={onClose} width="max-w-4xl">
      <div className="p-5 space-y-4">
        {loading && <p className="text-[12px]" style={{ color: "rgba(245,230,230,0.5)" }}>…</p>}
        {data?.ok && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <Metric label={t("d4.stats.files")} value={`${data.filesCount}`} />
              <Metric label={t("d4.stats.entries")} value={`${data.totalEntries?.toLocaleString("uk-UA")}`} />
              <Metric label={t("d4.stats.strings")} value={`${data.totalStrings?.toLocaleString("uk-UA")}`} />
              <Metric label={t("d4.stats.translatedPct")} value={`${pct}%`} ok={pct > 0} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <Metric label={t("d4.stats.enWords")} value={`${data.enWords?.toLocaleString("uk-UA")}`} />
              <Metric label={t("d4.stats.uaWords")} value={`${data.uaWords?.toLocaleString("uk-UA")}`} />
              <Metric label={t("d4.stats.enChars")} value={`${data.enChars?.toLocaleString("uk-UA")}`} />
              <Metric label={t("d4.stats.uaChars")} value={`${data.uaChars?.toLocaleString("uk-UA")}`} />
            </div>
            <section className="rounded-sm overflow-hidden" style={{ border: "1px solid rgba(220,38,38,0.2)" }}>
              <header className="px-3 py-2 text-[11px] font-semibold tracking-wider uppercase" style={{ color: "#dc2626", borderBottom: "1px solid rgba(220,38,38,0.15)" }}>
                {t("d4.stats.perFile")}
              </header>
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr style={{ color: "rgba(245,230,230,0.5)" }}>
                    <th className="text-left px-3 py-1 font-normal">{t("d4.stats.col.file")}</th>
                    <th className="text-right px-3 py-1 font-normal">{t("d4.stats.col.entries")}</th>
                    <th className="text-right px-3 py-1 font-normal">{t("d4.stats.col.strings")}</th>
                    <th className="text-right px-3 py-1 font-normal">{t("d4.stats.col.translated")}</th>
                    <th className="text-right px-3 py-1 font-normal">{t("d4.stats.col.pct")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.files?.map((f) => (
                    <tr key={f.name} className="border-t" style={{ borderColor: "rgba(220,38,38,0.08)" }}>
                      <td className="px-3 py-1 truncate" style={{ color: "#fff" }}>{f.name.replace(/\.json$/, "")}</td>
                      <td className="px-3 py-1 text-right tabular-nums" style={{ color: "rgba(245,230,230,0.7)" }}>{f.entries}</td>
                      <td className="px-3 py-1 text-right tabular-nums" style={{ color: "rgba(245,230,230,0.7)" }}>{f.strings}</td>
                      <td className="px-3 py-1 text-right tabular-nums" style={{ color: f.translated > 0 ? "#22c55e" : "rgba(245,230,230,0.4)" }}>{f.translated}</td>
                      <td className="px-3 py-1 text-right tabular-nums" style={{ color: f.percent > 0 ? "#22c55e" : "rgba(245,230,230,0.4)" }}>{f.percent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </ModalShell>
  );
}
function Metric({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-sm p-3" style={{ background: "rgba(0,0,0,0.35)", border: `1px solid ${ok ? "rgba(34,197,94,0.3)" : "rgba(220,38,38,0.2)"}` }}>
      <div className="text-[9px] font-bold tracking-[0.25em] uppercase mb-1" style={{ color: ok ? "#22c55e" : "#dc2626" }}>{label}</div>
      <div className="text-[15px] font-semibold tabular-nums" style={{ color: "#fff" }}>{value}</div>
    </div>
  );
}

// ── #6 Global Search Modal ───────────────────────────────────────
interface SearchHit {
  file: string; msgIdx: number; objectName: string;
  fileName: string | null; field: string; strIdx: number; text: string;
}
export function D4GlobalSearchModal({
  open, onClose, onJump,
}: { open: boolean; onClose: () => void; onJump?: (fileBase: string, msgIdx: number) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [cs, setCs] = useState(false);
  const [ww, setWw] = useState(false);
  const [re, setRe] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!query) return;
    setBusy(true);
    const r = await window.dp2.d4TextSearchAll({ query, opts: { caseSensitive: cs, wholeWord: ww, regex: re } });
    setBusy(false);
    setHits(r.hits ?? []);
    setTruncated(!!r.truncated);
  };

  if (!open) return null;
  return (
    <ModalShell title={t("d4.search.title")} subtitle={t("d4.search.subtitle")} onClose={onClose} width="max-w-4xl">
      <div className="p-4 space-y-3">
        <div className="flex gap-2">
          <input
            autoFocus type="text" placeholder={t("d4.find.placeholder")}
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            className="flex-1 px-2.5 py-1.5 text-[12px] font-mono rounded-sm"
            style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.35)", color: "#fff" }}
          />
          <button onClick={run} disabled={busy} className="px-4 py-1.5 text-[11px] font-semibold uppercase rounded-sm" style={{ background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)", color: "#fff", border: "1px solid #ef4444" }}>
            {t("d4.search.btn")}
          </button>
        </div>
        <div className="flex gap-3 text-[11px]" style={{ color: "rgba(245,230,230,0.75)" }}>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} style={{ accentColor: "#dc2626" }} />{t("d4.find.caseSensitive")}</label>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={ww} onChange={(e) => setWw(e.target.checked)} style={{ accentColor: "#dc2626" }} />{t("d4.find.wholeWord")}</label>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={re} onChange={(e) => setRe(e.target.checked)} style={{ accentColor: "#dc2626" }} />{t("d4.find.regex")}</label>
        </div>
        <p className="text-[10.5px] font-mono" style={{ color: "rgba(245,230,230,0.5)" }}>
          {t("d4.search.summary", { hits: hits.length })}{truncated && " · " + t("d4.search.truncated")}
        </p>
        <div className="space-y-1">
          {hits.map((h, i) => (
            <button
              key={i}
              onClick={() => onJump?.(h.file.replace(/\.json$/, ""), h.msgIdx)}
              className="w-full text-left p-2 rounded-sm transition-colors"
              style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(220,38,38,0.15)" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.12)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.3)"; }}
            >
              <div className="flex gap-2 text-[10px] font-mono" style={{ color: "rgba(245,230,230,0.5)" }}>
                <span style={{ color: "#dc2626" }}>{h.file.replace(/\.json$/, "")}</span>
                <span>· {h.objectName}[{h.strIdx}]</span>
                <span>· {h.field}</span>
              </div>
              <div className="text-[11.5px] font-mono mt-0.5 truncate" style={{ color: "#fff" }}>{h.text}</div>
            </button>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}

// ── #12 Batch Replace Modal ──────────────────────────────────────
export function D4BatchReplaceModal({ open, onClose, onApplied }: { open: boolean; onClose: () => void; onApplied?: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [cs, setCs] = useState(false);
  const [ww, setWw] = useState(false);
  const [re, setRe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ totalReplaced: number; files: Array<{ name: string; replaced: number }> } | null>(null);

  const run = async (dryRun: boolean) => {
    if (!query) return;
    setBusy(true);
    const r = await window.dp2.d4TextBatchReplace({ query, replacement, opts: { caseSensitive: cs, wholeWord: ww, regex: re, dryRun } });
    setBusy(false);
    if (r.ok) {
      setPreview({ totalReplaced: r.totalReplaced ?? 0, files: r.files ?? [] });
      if (!dryRun) onApplied?.();
    }
  };

  if (!open) return null;
  return (
    <ModalShell title={t("d4.batch.title")} subtitle={t("d4.batch.subtitle")} onClose={onClose} width="max-w-2xl">
      <div className="p-4 space-y-3">
        <input
          autoFocus type="text" placeholder={t("d4.find.placeholder")}
          value={query} onChange={(e) => { setQuery(e.target.value); setPreview(null); }}
          className="w-full px-2.5 py-1.5 text-[12px] font-mono rounded-sm"
          style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.35)", color: "#fff" }}
        />
        <input
          type="text" placeholder={t("d4.find.replace")}
          value={replacement} onChange={(e) => { setReplacement(e.target.value); setPreview(null); }}
          className="w-full px-2.5 py-1.5 text-[12px] font-mono rounded-sm"
          style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.25)", color: "#fff" }}
        />
        <div className="flex gap-3 text-[11px]" style={{ color: "rgba(245,230,230,0.75)" }}>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} style={{ accentColor: "#dc2626" }} />{t("d4.find.caseSensitive")}</label>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={ww} onChange={(e) => setWw(e.target.checked)} style={{ accentColor: "#dc2626" }} />{t("d4.find.wholeWord")}</label>
          <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={re} onChange={(e) => setRe(e.target.checked)} style={{ accentColor: "#dc2626" }} />{t("d4.find.regex")}</label>
        </div>
        <div className="flex gap-1.5 justify-end">
          <button onClick={() => run(true)} disabled={busy || !query} className="px-3 py-1.5 text-[11px] font-semibold uppercase rounded-sm" style={{ background: "rgba(220,38,38,0.12)", border: "1px solid rgba(220,38,38,0.3)", color: "#fff" }}>
            {t("d4.batch.dryRun")}
          </button>
          <button onClick={() => run(false)} disabled={busy || !query} className="px-3 py-1.5 text-[11px] font-semibold uppercase rounded-sm" style={{ background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)", border: "1px solid #ef4444", color: "#fff" }}>
            {t("d4.batch.apply")}
          </button>
        </div>
        {preview && (
          <div className="rounded-sm p-3 text-[11px] font-mono" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(34,197,94,0.3)", color: "#86efac" }}>
            <div className="mb-1.5 font-semibold">{t("d4.batch.replacedTotal", { n: preview.totalReplaced })}</div>
            <ul className="space-y-0.5">{preview.files.map((f) => <li key={f.name}>{f.name.replace(/\.json$/, "")}: {f.replaced}</li>)}</ul>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// ── #8 Glossary Modal ────────────────────────────────────────────
export function D4GlossaryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [entries, setEntries] = useState<Array<{ src: string; tgt: string; note?: string }>>([]);
  useEffect(() => {
    if (!open) return;
    window.dp2.d4GlossaryRead().then((r) => { if (r.ok) setEntries(r.entries ?? []); });
  }, [open]);
  const save = async () => {
    await window.dp2.d4GlossaryWrite({ entries: entries.filter((e) => e.src && e.tgt) });
    onClose();
  };
  const update = (i: number, k: "src" | "tgt" | "note", v: string) => {
    setEntries((prev) => prev.map((e, idx) => idx === i ? { ...e, [k]: v } : e));
  };
  if (!open) return null;
  return (
    <ModalShell title={t("d4.gloss.title")} subtitle={t("d4.gloss.subtitle")} onClose={onClose} width="max-w-3xl">
      <div className="p-4 space-y-2">
        <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider" style={{ color: "rgba(245,230,230,0.5)" }}>
          <div className="col-span-4">{t("d4.gloss.src")}</div>
          <div className="col-span-4">{t("d4.gloss.tgt")}</div>
          <div className="col-span-3">{t("d4.gloss.note")}</div>
          <div className="col-span-1"></div>
        </div>
        {entries.map((e, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <input value={e.src} onChange={(ev) => update(i, "src", ev.target.value)} className="col-span-4 px-2 py-1 text-[11.5px] font-mono rounded-sm" style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.25)", color: "#fff" }} />
            <input value={e.tgt} onChange={(ev) => update(i, "tgt", ev.target.value)} className="col-span-4 px-2 py-1 text-[11.5px] font-mono rounded-sm" style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(34,197,94,0.25)", color: "#fff" }} />
            <input value={e.note ?? ""} onChange={(ev) => update(i, "note", ev.target.value)} className="col-span-3 px-2 py-1 text-[11.5px] rounded-sm" style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.15)", color: "rgba(245,230,230,0.75)" }} />
            <button onClick={() => setEntries((prev) => prev.filter((_, idx) => idx !== i))} className="col-span-1 text-[14px]" style={{ color: "rgba(220,38,38,0.7)" }}>×</button>
          </div>
        ))}
        <div className="flex gap-1.5 pt-2">
          <button onClick={() => setEntries((prev) => [...prev, { src: "", tgt: "", note: "" }])} className="px-3 py-1.5 text-[11px] font-semibold uppercase rounded-sm" style={{ background: "rgba(220,38,38,0.12)", border: "1px solid rgba(220,38,38,0.3)", color: "#fff" }}>
            {t("d4.gloss.add")}
          </button>
          <button onClick={save} className="px-3 py-1.5 text-[11px] font-semibold uppercase rounded-sm" style={{ background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)", border: "1px solid #ef4444", color: "#fff" }}>
            {t("d4.gloss.save")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── #7 Translation Memory Panel (inline, не модалка) ─────────────
// Показує найсхожіші вже-перекладені пари за поточним рядком m_aString.
function lcs(a: string, b: string): number {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1).fill(0);
  let cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i-1] === b[j-1] ? prev[j-1] + 1 : Math.max(prev[j], cur[j-1]);
    }
    [prev, cur] = [cur, prev]; cur.fill(0);
  }
  return prev[m];
}
function similarity(a: string, b: string): number {
  const al = a.length, bl = b.length;
  if (al === 0 || bl === 0) return 0;
  const l = lcs(a.toLowerCase(), b.toLowerCase());
  return l / Math.max(al, bl);
}

export function D4TmPanel({
  query, pairs, onPick,
}: {
  query: string;
  pairs: Array<{ en: string; ua: string }>;
  onPick: (ua: string) => void;
}) {
  const t = useT();
  const top = useMemo(() => {
    if (!query || query.length < 3) return [];
    const scored = pairs.map((p) => ({ ...p, score: similarity(query, p.en) }));
    return scored.filter((p) => p.score > 0.4).sort((a, b) => b.score - a.score).slice(0, 5);
  }, [query, pairs]);
  if (top.length === 0) return null;
  return (
    <div className="rounded-sm p-2.5 space-y-1.5" style={{ background: "rgba(13, 2, 4, 0.65)", border: "1px solid rgba(220,38,38,0.2)" }}>
      <div className="text-[9.5px] font-bold tracking-[0.25em] uppercase" style={{ color: "#dc2626" }}>
        {t("d4.tm.title")}
      </div>
      {top.map((p, i) => (
        <button key={i} onClick={() => onPick(p.ua)} className="block w-full text-left rounded-sm p-1.5 transition-colors" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(220,38,38,0.12)" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.12)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.3)"; }}
        >
          <div className="text-[10.5px] font-mono truncate" style={{ color: "rgba(245,230,230,0.55)" }}>{p.en}</div>
          <div className="text-[11px] font-mono truncate" style={{ color: "#86efac" }}>{p.ua}</div>
          <div className="text-[9px] mt-0.5 font-mono" style={{ color: "rgba(245,230,230,0.4)" }}>
            {t("d4.tm.match", { pct: Math.round(p.score * 100) })}
          </div>
        </button>
      ))}
    </div>
  );
}
