import { useEffect, useState } from "react";
import { scanAll, type Issue, type IssueKind, type ScanResult } from "../lib/validate";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";

interface PreflightModalProps {
  open: boolean;
  onClose: () => void;
  onProceed: () => void;
}

function buildKindLabels(t: (k: string) => string): Record<IssueKind, string> {
  return {
    empty: t("pre.kind.empty"),
    newline: t("pre.kind.newline"),
    tag: t("pre.kind.tag"),
  };
}

const KIND_PILL: Record<IssueKind, string> = {
  empty: "dp-pill--danger",
  newline: "dp-pill--warn",
  tag: "dp-pill--warn",
};

function shortName(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

export function PreflightModal({ open, onClose, onProceed }: PreflightModalProps) {
  const t = useT();
  const KIND_LABELS = buildKindLabels(t);
  const folder = useStore((s) => s.folder);
  const loadFile = useStore((s) => s.loadFile);
  const setActive = useStore((s) => s.setActive);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<IssueKind | "all">("all");

  useEffect(() => {
    if (!open || !folder) return;
    setLoading(true);
    setScan(null);
    scanAll(folder)
      .then((r) => setScan(r))
      .finally(() => setLoading(false));
  }, [open, folder]);

  if (!open) return null;

  const grouped = (() => {
    if (!scan) return new Map<IssueKind, Issue[]>();
    const m = new Map<IssueKind, Issue[]>();
    for (const i of scan.issues) {
      if (!m.has(i.kind)) m.set(i.kind, []);
      m.get(i.kind)!.push(i);
    }
    return m;
  })();

  const total = scan?.issues.length ?? 0;
  const filtered = scan ? (filter === "all" ? scan.issues : scan.issues.filter((i) => i.kind === filter)) : [];

  async function jumpToIssue(issue: Issue) {
    await loadFile(issue.filePath);
    setActive(issue.entryIndex);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="dp-card w-[820px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("pre.title")}</h2>
          <button className="dp-btn dp-btn--ghost" onClick={onClose}>{t("btn.close")}</button>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center py-10 text-[13px] text-[var(--text-muted)]">
            {t("pre.scanning")}
          </div>
        )}

        {!loading && scan && (
          <>
            <div className="px-5 py-2.5 border-b border-[var(--border-soft)] flex items-center gap-3 text-[12px] text-[var(--text-muted)]">
              <span>
                {t("pre.records")}: <span className="text-[var(--text)] font-semibold">{scan.totalEntries}</span>
              </span>
              <span>
                {t("pre.translated")}:{" "}
                <span className="text-[var(--success)] font-semibold">{scan.totalTranslated}</span>{" "}
                ({((scan.totalTranslated / Math.max(1, scan.totalEntries)) * 100).toFixed(1)}%)
              </span>
              <span className="ml-auto">
                {t("pre.issues")}:{" "}
                <span className={`font-semibold ${total > 0 ? "text-[var(--warning)]" : "text-[var(--success)]"}`}>
                  {total}
                </span>
              </span>
            </div>

            <div className="px-5 py-2 border-b border-[var(--border-soft)] flex flex-wrap gap-1.5">
              <button
                className={`dp-btn ${filter === "all" ? "dp-btn--primary" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("table.filter.all", { n: total })}
              </button>
              {(Object.keys(KIND_LABELS) as IssueKind[]).map((k) => {
                const n = grouped.get(k)?.length ?? 0;
                if (n === 0) return null;
                return (
                  <button
                    key={k}
                    className={`dp-btn ${filter === k ? "dp-btn--primary" : ""}`}
                    onClick={() => setFilter(k)}
                  >
                    {KIND_LABELS[k]} {n}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="py-10 text-center text-[13px] text-[var(--text-muted)]">
                  {total === 0 ? t("pre.clean") : t("pre.emptyFilter")}
                </div>
              ) : (
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 bg-[var(--bg-surface)] border-b border-[var(--border-soft)] text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                    <tr>
                      <th className="text-left px-3 py-1.5 w-[160px]">{t("pre.col.kind")}</th>
                      <th className="text-left px-3 py-1.5 w-[180px]">{t("pre.col.file")}</th>
                      <th className="text-left px-3 py-1.5">{t("pre.col.id")}</th>
                      <th className="w-[80px]"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 500).map((iss, idx) => (
                      <tr
                        key={idx}
                        className="border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]"
                      >
                        <td className="px-3 py-1.5 align-top">
                          <span className={`dp-pill ${KIND_PILL[iss.kind]}`}>
                            {KIND_LABELS[iss.kind]}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 align-top font-mono text-[11px] text-[var(--text-muted)] truncate" title={iss.filePath}>
                          {shortName(iss.filePath)}
                        </td>
                        <td className="px-3 py-1.5 align-top">
                          <p className="font-mono text-[11px] text-[var(--text)] truncate" title={iss.id}>
                            {iss.id}
                          </p>
                          <p className="text-[11px] text-[var(--text-faint)] mt-0.5">{iss.detail}</p>
                        </td>
                        <td className="px-3 py-1.5 align-top text-right">
                          <button
                            className="dp-btn dp-btn--ghost text-[11px]"
                            onClick={() => jumpToIssue(iss)}
                          >
                            {t("btn.jump")}
                          </button>
                        </td>
                      </tr>
                    ))}
                    {filtered.length > 500 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-2 text-center text-[11px] text-[var(--text-faint)]">
                          + ще {filtered.length - 500}. Виправ перших, тоді перескануй.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
              <button className="dp-btn" onClick={onClose}>{t("btn.fix")}</button>
              <button
                className={total > 0 ? "dp-btn dp-btn--ghost" : "dp-btn dp-btn--success"}
                onClick={() => { onClose(); onProceed(); }}
              >
                {total > 0 ? t("btn.proceed") : t("btn.proceedClean")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
