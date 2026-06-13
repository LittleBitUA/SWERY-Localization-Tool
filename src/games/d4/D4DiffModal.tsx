// D4 — модалка діффу Original vs Done для активного запису.
// Простий word-level diff: біле = без змін, зелене = додано, червоне =
// видалено. Лівий блок — оригінал, правий — переклад.

import { useEffect } from "react";
import { useT } from "../../lib/i18n";

interface Props {
  open: boolean;
  origStrings: string[];
  doneStrings: string[];
  onClose: () => void;
}

// Спрощена LCS-діагональ для word-level diff. Для коротких ігрових рядків
// (~50-200 слів) працює миттєво, без потреби у diff-бібліотеці.
function wordDiff(a: string, b: string): Array<{ type: "same" | "del" | "add"; text: string }> {
  const aw = a.match(/\S+\s*|\s+/g) ?? [];
  const bw = b.match(/\S+\s*|\s+/g) ?? [];
  const n = aw.length, m = bw.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    dp[i][j] = aw[i-1] === bw[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  }
  const out: Array<{ type: "same" | "del" | "add"; text: string }> = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (aw[i-1] === bw[j-1]) { out.unshift({ type: "same", text: aw[i-1] }); i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) { out.unshift({ type: "del", text: aw[i-1] }); i--; }
    else { out.unshift({ type: "add", text: bw[j-1] }); j--; }
  }
  while (i > 0) { out.unshift({ type: "del", text: aw[i-1] }); i--; }
  while (j > 0) { out.unshift({ type: "add", text: bw[j-1] }); j--; }
  return out;
}

export function D4DiffModal({ open, origStrings, doneStrings, onClose }: Props) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const n = Math.max(origStrings.length, doneStrings.length);
  const rows: Array<{ orig: string; done: string; changed: boolean; diff: ReturnType<typeof wordDiff> }> = [];
  for (let i = 0; i < n; i++) {
    const o = origStrings[i] ?? "";
    const d = doneStrings[i] ?? "";
    rows.push({ orig: o, done: d, changed: o !== d, diff: wordDiff(o, d) });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(8,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[80vh] rounded-sm flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "linear-gradient(180deg, #1a0508 0%, #0d0204 100%)",
          border: "1px solid rgba(220,38,38,0.5)",
          color: "#f5e6e6",
        }}
      >
        <header
          className="px-4 py-2.5 flex items-center justify-between"
          style={{ borderBottom: "1px solid rgba(220,38,38,0.3)" }}
        >
          <h2 className="text-[13px] font-semibold" style={{ color: "#fff" }}>{t("d4.diff.title")}</h2>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-sm" style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="overflow-y-auto p-4 space-y-3" style={{ scrollbarWidth: "thin" }}>
          {rows.map((r, i) => (
            <div key={i} className="rounded-sm overflow-hidden" style={{ border: "1px solid rgba(220,38,38,0.2)" }}>
              <div className="px-3 py-1 text-[10px] font-mono tabular-nums tracking-wider uppercase" style={{ background: "rgba(220,38,38,0.08)", color: r.changed ? "#22c55e" : "rgba(245,230,230,0.4)" }}>
                [{i.toString().padStart(3, "0")}] {r.changed ? "● changed" : "○ unchanged"}
              </div>
              {!r.changed ? (
                <div className="px-3 py-2 text-[11.5px] font-mono italic" style={{ color: "rgba(245,230,230,0.4)" }}>
                  {r.orig || t("d4.diff.empty")}
                </div>
              ) : (
                <div className="grid grid-cols-2 divide-x" style={{ borderColor: "rgba(220,38,38,0.15)" }}>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: "rgba(245,230,230,0.45)" }}>{t("d4.diff.original")}</div>
                    <div className="text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap">
                      {r.diff.filter((d) => d.type !== "add").map((d, k) => (
                        <span key={k} style={{
                          background: d.type === "del" ? "rgba(239,68,68,0.18)" : "transparent",
                          color: d.type === "del" ? "#fecaca" : "rgba(245,230,230,0.7)",
                          textDecoration: d.type === "del" ? "line-through" : "none",
                        }}>{d.text}</span>
                      ))}
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: "rgba(245,230,230,0.45)" }}>{t("d4.diff.translation")}</div>
                    <div className="text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap">
                      {r.diff.filter((d) => d.type !== "del").map((d, k) => (
                        <span key={k} style={{
                          background: d.type === "add" ? "rgba(34,197,94,0.18)" : "transparent",
                          color: d.type === "add" ? "#86efac" : "rgba(245,230,230,0.85)",
                        }}>{d.text}</span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
