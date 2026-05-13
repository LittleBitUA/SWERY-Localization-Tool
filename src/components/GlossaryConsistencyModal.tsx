import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { useStore } from "../lib/store";
import { readGlossary } from "../lib/glossary";
import type { GlossaryConsistencyResult, GlossaryTermResult, GlossaryViolation } from "../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
}

function highlight(text: string, needle: string): React.ReactNode[] {
  if (!text || !needle) return [text];
  const out: React.ReactNode[] = [];
  const lc = text.toLowerCase();
  const nlc = needle.toLowerCase();
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const j = lc.indexOf(nlc, i);
    if (j < 0) { out.push(text.slice(i)); break; }
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={k++} className="bg-[var(--warning)]/30 text-[var(--text-strong)] rounded px-0.5">
        {text.slice(j, j + needle.length)}
      </mark>
    );
    i = j + needle.length;
  }
  return out;
}

export function GlossaryConsistencyModal({ open, onClose }: Props) {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const loadFile = useStore((s) => s.loadFile);
  const setActive = useStore((s) => s.setActive);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GlossaryConsistencyResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!open || !folder) return;
    let cancelled = false;
    setLoading(true);
    setData(null);
    (async () => {
      try {
        const glossary = await readGlossary(folder);
        if (!glossary.length) {
          if (!cancelled) setData({ termResults: [], totals: { terms: 0, violations: 0, entriesScanned: 0, entriesTranslated: 0 } });
          return;
        }
        const res = await window.dp2.glossaryConsistencyWorker({ folder, glossary });
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, folder, tick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function jump(v: GlossaryViolation) {
    await loadFile(v.filePath);
    setActive(v.entryIndex);
    onClose();
  }

  const violatedTerms = data?.termResults.filter((t) => t.violationCount > 0) ?? [];
  const cleanTerms = data?.termResults.filter((t) => t.violationCount === 0) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[8vh]" onClick={onClose}>
      <div className="dp-card w-[920px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("gc.title")}</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5 truncate">{t("gc.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setTick((x) => x + 1)} className="dp-btn" disabled={loading || !folder}>
              {t("gc.refresh")}
            </button>
            <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!folder ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gc.noFolder")}</p>
          ) : loading || !data ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gc.loading")}</p>
          ) : data.totals.terms === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gc.noGlossary")}</p>
          ) : (
            <>
              <Summary data={data} />

              {violatedTerms.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-[var(--success)]">{t("gc.allClean")}</p>
              ) : (
                <div>
                  <div className="px-5 py-2 text-[11px] uppercase tracking-wider font-semibold text-[var(--text-muted)] border-b border-[var(--border-soft)] bg-[var(--bg)]">
                    {t("gc.violatedTerms")}
                  </div>
                  {violatedTerms.map((term) => (
                    <TermRow
                      key={term.src + "→" + term.tgt}
                      term={term}
                      open={expanded.has(term.src + "→" + term.tgt)}
                      onToggle={() => toggle(term.src + "→" + term.tgt)}
                      onJump={jump}
                    />
                  ))}
                </div>
              )}

              {cleanTerms.length > 0 && (
                <details className="px-5 py-3 border-t border-[var(--border-soft)]">
                  <summary className="cursor-pointer text-[12px] text-[var(--text-muted)]">
                    {t("gc.cleanTerms", { n: cleanTerms.length })}
                  </summary>
                  <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[var(--text-faint)] font-mono">
                    {cleanTerms.map((tr) => (
                      <li key={tr.src + "→" + tr.tgt} className="truncate" title={`${tr.src} → ${tr.tgt}`}>
                        <span className="text-[var(--success)]">✓</span> {tr.src} → {tr.tgt}{" "}
                        <span className="text-[var(--text-faint)]">({tr.okCount})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ data }: { data: GlossaryConsistencyResult }) {
  const t = useT();
  return (
    <div className="grid grid-cols-4 gap-3 px-5 py-4 border-b border-[var(--border-soft)]">
      <SummaryBox label={t("gc.totalTerms")} value={data.totals.terms} />
      <SummaryBox label={t("gc.totalViolations")} value={data.totals.violations} tone={data.totals.violations > 0 ? "warning" : "success"} />
      <SummaryBox label={t("gc.entriesScanned")} value={data.totals.entriesScanned} />
      <SummaryBox label={t("gc.entriesTranslated")} value={data.totals.entriesTranslated} />
    </div>
  );
}

function SummaryBox({ label, value, tone }: { label: string; value: number; tone?: "warning" | "success" }) {
  const color = tone === "warning" ? "text-[var(--warning)]"
    : tone === "success" ? "text-[var(--success)]"
    : "text-[var(--text-strong)]";
  return (
    <div className="border border-[var(--border-soft)] rounded p-3 bg-[var(--bg)]">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{label}</p>
      <p className={`text-[20px] font-bold tabular-nums leading-none ${color}`}>
        {value.toLocaleString("uk-UA")}
      </p>
    </div>
  );
}

function TermRow({
  term, open, onToggle, onJump,
}: {
  term: GlossaryTermResult;
  open: boolean;
  onToggle: () => void;
  onJump: (v: GlossaryViolation) => void;
}) {
  const t = useT();
  return (
    <div className="border-b border-[var(--border-soft)]">
      <button
        className="w-full px-5 py-2 flex items-center gap-3 text-left hover:bg-[var(--row-hover)]"
        onClick={onToggle}
      >
        <svg
          className={`w-3 h-3 shrink-0 text-[var(--text-faint)] transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor" viewBox="0 0 16 16"
        >
          <path d="M5 4l5 4-5 4V4z" />
        </svg>
        <span className="font-mono text-[12px] text-[var(--text)] truncate">{term.src}</span>
        <span className="text-[var(--text-faint)]">→</span>
        <span className="font-mono text-[12px] text-[var(--success)] truncate">{term.tgt}</span>
        <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums shrink-0">
          <span className="text-[var(--success)]" title={t("gc.okCount")}>✓ {term.okCount}</span>
          <span className="text-[var(--warning)] font-semibold" title={t("gc.violations")}>
            ✗ {term.violationCount}
          </span>
        </span>
      </button>

      {open && (
        <ul className="bg-[var(--bg)] border-t border-[var(--border-soft)]">
          {term.violations.map((v, i) => (
            <li
              key={i}
              className="px-5 py-2 pl-10 border-t border-[var(--border-soft)] cursor-pointer hover:bg-[var(--row-hover)]"
              onClick={() => onJump(v)}
            >
              <div className="flex items-center gap-2 mb-0.5 text-[11px]">
                <span className="dp-pill">{v.kind === "sentence" ? t("editor.kind.sentence") : t("editor.kind.item")}</span>
                <span className="font-mono text-[var(--text-muted)] truncate" title={v.entryId}>
                  {v.entryId || `#${v.entryIndex + 1}`}
                </span>
                <span className="font-mono text-[var(--text-faint)] truncate">{v.fileName}</span>
                {v.charaName && <span className="text-[var(--text-faint)] truncate">· {v.charaName}</span>}
                <span className="ml-auto text-[var(--text-faint)]">→</span>
              </div>
              <p className="text-[12px] text-[var(--text-muted)] leading-snug line-clamp-2 whitespace-pre-wrap break-words mb-0.5">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mr-2">EN</span>
                {highlight(v.originalEn, term.src)}
              </p>
              <p className="text-[12px] text-[var(--text)] leading-snug line-clamp-2 whitespace-pre-wrap break-words">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mr-2">UA</span>
                {v.en}
              </p>
            </li>
          ))}
          {term.violationCount > term.violations.length && (
            <li className="px-5 py-2 pl-10 border-t border-[var(--border-soft)] text-[11px] text-[var(--text-faint)] italic">
              {t("gc.moreViolations", { n: term.violationCount - term.violations.length })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
