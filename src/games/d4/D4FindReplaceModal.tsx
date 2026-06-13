// Find / Replace у поточному D4 файлі.
// Працює з масивом Msg (тільки m_aString — основний переклад). Підтримує
// case-sensitive, whole-word, regex; scope: лише активний запис чи весь файл.

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";

interface Msg {
  objectName: string;
  fileName?: string | null;
  m_aString: string[];
  m_aWord: string[];
  m_aVoiceIdStr: string[];
}

interface Hit {
  msgIdx: number;
  strIdx: number;
  text: string;
  start: number;
  end: number;
}

interface Props {
  open: boolean;
  done: Msg[];
  activeIdx: number;
  onApply: (updated: Msg[]) => void;
  onJump: (msgIdx: number) => void;
  onClose: () => void;
}

function buildRegex(query: string, opts: { cs: boolean; ww: boolean; re: boolean }): RegExp | null {
  if (!query) return null;
  try {
    const flags = opts.cs ? "g" : "gi";
    if (opts.re) return new RegExp(query, flags);
    let q = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (opts.ww) q = `\\b${q}\\b`;
    return new RegExp(q, flags);
  } catch { return null; }
}

export function D4FindReplaceModal({ open, done, activeIdx, onApply, onJump, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [cs, setCs] = useState(false);
  const [ww, setWw] = useState(false);
  const [re, setRe] = useState(false);
  const [scope, setScope] = useState<"current" | "all">("all");
  const [cursor, setCursor] = useState(0);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hits = useMemo<Hit[]>(() => {
    const rx = buildRegex(query, { cs, ww, re });
    if (!rx) return [];
    const out: Hit[] = [];
    const start = scope === "current" ? activeIdx : 0;
    const end = scope === "current" ? activeIdx + 1 : done.length;
    for (let mi = start; mi < end; mi++) {
      const m = done[mi];
      const arr = m?.m_aString ?? [];
      for (let si = 0; si < arr.length; si++) {
        const text = arr[si] ?? "";
        rx.lastIndex = 0;
        let mm: RegExpExecArray | null;
        while ((mm = rx.exec(text)) !== null) {
          out.push({ msgIdx: mi, strIdx: si, text, start: mm.index, end: mm.index + mm[0].length });
          if (mm[0].length === 0) rx.lastIndex++;
        }
      }
    }
    return out;
  }, [query, cs, ww, re, scope, done, activeIdx]);

  if (!open) return null;

  const next = () => {
    if (hits.length === 0) { setInfo(t("d4.find.nothing")); return; }
    const c = (cursor + 1) % hits.length;
    setCursor(c);
    onJump(hits[c].msgIdx);
    setInfo(null);
  };

  const replaceCurrent = () => {
    if (hits.length === 0) { setInfo(t("d4.find.nothing")); return; }
    const h = hits[cursor % hits.length];
    const updated = done.map((m, mi) => {
      if (mi !== h.msgIdx) return m;
      const arr = [...(m.m_aString ?? [])];
      const text = arr[h.strIdx] ?? "";
      arr[h.strIdx] = text.slice(0, h.start) + replace + text.slice(h.end);
      return { ...m, m_aString: arr };
    });
    onApply(updated);
    setInfo(t("d4.find.replaceDone", { n: 1 }));
  };

  const replaceAll = () => {
    const rx = buildRegex(query, { cs, ww, re });
    if (!rx) { setInfo(t("d4.find.nothing")); return; }
    let count = 0;
    const start = scope === "current" ? activeIdx : 0;
    const end = scope === "current" ? activeIdx + 1 : done.length;
    const updated = done.map((m, mi) => {
      if (mi < start || mi >= end) return m;
      const arr = (m.m_aString ?? []).map((s) => {
        return s.replace(rx, (m0) => { count++; return replace; });
      });
      return { ...m, m_aString: arr };
    });
    if (count > 0) onApply(updated);
    setInfo(count > 0 ? t("d4.find.replaceDone", { n: count }) : t("d4.find.nothing"));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-6"
      style={{ background: "rgba(8,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-sm"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "linear-gradient(180deg, #1a0508 0%, #0d0204 100%)",
          border: "1px solid rgba(220,38,38,0.5)",
          boxShadow: "0 0 40px rgba(220,38,38,0.35)",
          color: "#f5e6e6",
        }}
      >
        <header
          className="px-4 py-2.5 flex items-center justify-between"
          style={{
            borderBottom: "1px solid rgba(220,38,38,0.3)",
            background: "linear-gradient(90deg, rgba(220,38,38,0.15) 0%, transparent 100%)",
          }}
        >
          <div>
            <div className="text-[10px] font-bold tracking-[0.3em]" style={{ color: "#dc2626" }}>◆ {t("d4.shortcut.findReplace")} ◆</div>
            <h2 className="text-[13px] font-semibold" style={{ color: "#fff" }}>{t("d4.find.title")}</h2>
          </div>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-sm" style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="p-4 space-y-2.5">
          <input
            autoFocus
            type="text"
            placeholder={t("d4.find.placeholder")}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); setInfo(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") next(); }}
            className="w-full px-2.5 py-1.5 text-[12px] font-mono rounded-sm"
            style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.35)", color: "#fff" }}
          />
          <input
            type="text"
            placeholder={t("d4.find.replace")}
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            className="w-full px-2.5 py-1.5 text-[12px] font-mono rounded-sm"
            style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(220,38,38,0.25)", color: "#fff" }}
          />

          <div className="flex flex-wrap gap-3 text-[11px]" style={{ color: "rgba(245,230,230,0.75)" }}>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} style={{ accentColor: "#dc2626" }} />
              {t("d4.find.caseSensitive")}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={ww} onChange={(e) => setWw(e.target.checked)} style={{ accentColor: "#dc2626" }} />
              {t("d4.find.wholeWord")}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={re} onChange={(e) => setRe(e.target.checked)} style={{ accentColor: "#dc2626" }} />
              {t("d4.find.regex")}
            </label>
          </div>

          <div className="flex gap-1.5 text-[11px]">
            {(["current", "all"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className="px-2.5 py-1 rounded-sm transition-colors"
                style={{
                  background: scope === s ? "rgba(220,38,38,0.3)" : "rgba(0,0,0,0.3)",
                  border: `1px solid ${scope === s ? "#dc2626" : "rgba(220,38,38,0.2)"}`,
                  color: scope === s ? "#fff" : "rgba(245,230,230,0.7)",
                }}
              >
                {s === "current" ? t("d4.find.scope.current") : t("d4.find.scope.all")}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] font-mono" style={{ color: "rgba(245,230,230,0.6)" }}>
              {info ?? t("d4.find.summary", { hits: hits.length })}
            </span>
            <div className="flex gap-1.5">
              <ModalBtn onClick={next}>{t("d4.find.btn.next")}</ModalBtn>
              <ModalBtn onClick={replaceCurrent}>{t("d4.find.btn.replaceOne")}</ModalBtn>
              <ModalBtn onClick={replaceAll} primary>{t("d4.find.btn.replaceAll")}</ModalBtn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalBtn({ onClick, primary, children }: { onClick: () => void; primary?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-sm transition-colors"
      style={{
        background: primary ? "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)" : "rgba(220,38,38,0.12)",
        border: `1px solid ${primary ? "#ef4444" : "rgba(220,38,38,0.3)"}`,
        color: "#fff",
      }}
    >
      {children}
    </button>
  );
}
