import { useEffect, useState } from "react";

interface Violation {
  index: number;
  id1: number;
  id2: number;
  missing: string[];
  extra: string[];
  original: string;
  current: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onGoTo: (index: number) => void;
}

// Перевіряє відповідність набору `{…}` маркерів у Done vs Original. Викликається
// з Dp1TextEditor як перед-pack lint і як standalone-перегляд через кнопку.
export function Dp1LintModal({ open, onClose, onGoTo }: Props) {
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [items, setItems] = useState<Violation[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await window.dp2.dp1TextLintMarkers();
      if (!r.ok) { setError(r.error ?? "lint failed"); return; }
      setScanned(r.scannedRows ?? 0);
      setItems(r.violations ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (open) load(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-4xl flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">
              Перевірка цілісності маркерів
            </h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              Знайдено {items.length} рядків з порушеннями (з {scanned.toLocaleString("uk-UA")} перевірених)
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={load} className="dp-btn" disabled={loading}>
              {loading ? "…" : "Оновити"}
            </button>
            <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {loading && (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">Перевірка…</p>
          )}
          {error && !loading && (
            <p className="py-10 text-center text-[13px] text-[var(--danger)]">{error}</p>
          )}
          {!loading && !error && items.length === 0 && (
            <p className="py-10 text-center text-[13px] text-[var(--success)]">
              Усе чисто — маркери збігаються з оригіналом.
            </p>
          )}
          {!loading && items.length > 0 && (
            <div className="space-y-2">
              {items.map((v) => (
                <div
                  key={`${v.index}-${v.id1}-${v.id2}`}
                  className="border border-[var(--border-soft)] rounded p-3 bg-[var(--bg)] hover:border-[var(--accent)]/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-[var(--text-muted)]">#{v.index}</span>
                      <span className="font-mono text-[var(--text-faint)]">Id1/Id2 {v.id1}/{v.id2}</span>
                    </div>
                    <button
                      className="dp-btn dp-btn--ghost text-[11px]"
                      onClick={() => onGoTo(v.index)}
                    >
                      Перейти →
                    </button>
                  </div>
                  <div className="flex items-center gap-3 mb-2 text-[11px] flex-wrap">
                    {v.missing.length > 0 && (
                      <span className="text-[var(--danger)]">
                        ✗ <span className="font-mono">{v.missing.join(", ")}</span>
                      </span>
                    )}
                    {v.extra.length > 0 && (
                      <span className="text-[var(--warning)]">
                        + <span className="font-mono">{v.extra.join(", ")}</span>
                      </span>
                    )}
                  </div>
                  <p className="text-[11.5px] text-[var(--text-muted)] line-clamp-2 whitespace-pre-wrap break-words mb-1">
                    <span className="text-[var(--text-faint)] mr-1">EN:</span>{v.original}
                  </p>
                  <p className="text-[11.5px] text-[var(--text)] line-clamp-2 whitespace-pre-wrap break-words">
                    <span className="text-[var(--text-faint)] mr-1">UA:</span>{v.current}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
