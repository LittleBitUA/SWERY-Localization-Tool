// Find & Replace у межах поточного HBR-файлу. Працює лише з полем `current`
// (перекладом), не чіпає оригінал. Підтримує case-sensitive і regex.
// Превʼю показує до 20 потенційних замін перед застосуванням.

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import type { HbrTextItem } from "./parser";

interface Props {
  open: boolean;
  items: HbrTextItem[] | null;
  onApply: (updates: Array<{ idx: number; next: string }>) => void;
  onClose: () => void;
}

interface Hit {
  idx: number;
  before: string;
  after: string;
  count: number;
}

export function HbrFindReplaceModal({ open, items, onApply, onClose }: Props) {
  const t = useT();
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hits = useMemo<Hit[]>(() => {
    setRegexError(null);
    if (!open || !items || !find) return [];
    let re: RegExp;
    try {
      if (useRegex) {
        re = new RegExp(find, caseSensitive ? "g" : "gi");
      } else {
        const esc = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        re = new RegExp(esc, caseSensitive ? "g" : "gi");
      }
    } catch (e) {
      setRegexError((e as Error).message);
      return [];
    }
    const out: Hit[] = [];
    for (let i = 0; i < items.length; i++) {
      const cur = items[i].current ?? "";
      if (!cur) continue;
      re.lastIndex = 0;
      const matches = cur.match(re);
      if (!matches || matches.length === 0) continue;
      re.lastIndex = 0;
      const next = cur.replace(re, replace);
      if (next === cur) continue;
      out.push({ idx: i, before: cur, after: next, count: matches.length });
    }
    return out;
  }, [open, items, find, replace, caseSensitive, useRegex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-[640px] flex flex-col"
        style={{ maxHeight: "75vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("hbr.findReplace.title")}</h2>
            <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">{t("hbr.findReplace.subtitle")}</p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">✕</button>
        </header>

        <div className="px-5 py-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("hbr.findReplace.find")}</span>
            <input
              autoFocus
              className="dp-input"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={t("hbr.findReplace.findPh")}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t("hbr.findReplace.replace")}</span>
            <input
              className="dp-input"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder={t("hbr.findReplace.replacePh")}
            />
          </label>
          <div className="flex items-center gap-4 text-[11.5px] text-[var(--text-muted)]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
              {t("hbr.findReplace.caseSensitive")}
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} />
              {t("hbr.findReplace.regex")}
            </label>
            <span className="ml-auto tabular-nums">
              {regexError
                ? <span className="text-[var(--danger)]">{regexError}</span>
                : <span>{t("hbr.findReplace.matches", { rows: hits.length, count: hits.reduce((s, h) => s + h.count, 0) })}</span>}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-auto border-t border-[var(--border-soft)] px-5 py-3 text-[11.5px]">
          {hits.length === 0 ? (
            <p className="text-[var(--text-faint)] italic">{t("hbr.findReplace.noHits")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {hits.slice(0, 50).map((h) => (
                <li key={h.idx} className="border border-[var(--border-soft)] rounded p-2 bg-[var(--bg)]">
                  <p className="text-[10px] font-mono text-[var(--text-faint)] mb-1">
                    {items?.[h.idx].textId} · #{items?.[h.idx].variantIdx} · ×{h.count}
                  </p>
                  <p className="text-[var(--text-muted)] whitespace-pre-wrap break-words line-clamp-2">{h.before}</p>
                  <p className="text-[var(--success)] whitespace-pre-wrap break-words line-clamp-2 mt-0.5">→ {h.after}</p>
                </li>
              ))}
              {hits.length > 50 && (
                <li className="text-[var(--text-faint)] italic text-center">…+{hits.length - 50}</li>
              )}
            </ul>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-[var(--border-soft)] flex justify-end gap-2">
          <button className="dp-btn" onClick={onClose}>{t("btn.cancel")}</button>
          <button
            className="dp-btn dp-btn--primary"
            disabled={hits.length === 0}
            onClick={() => {
              onApply(hits.map((h) => ({ idx: h.idx, next: h.after })));
              onClose();
            }}
          >
            {t("hbr.findReplace.apply", { n: hits.length })}
          </button>
        </footer>
      </div>
    </div>
  );
}
