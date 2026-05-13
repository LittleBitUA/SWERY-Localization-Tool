import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function FindReplaceModal({ open, onClose }: Props) {
  const t = useT();
  const findReplaceAll = useStore((s) => s.findReplaceAll);
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setTimeout(() => findRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  function onReplaceAll() {
    if (!find) return;
    const { entries, replacements } = findReplaceAll(find, replace, {
      caseSensitive,
      wholeWord,
    });
    if (replacements === 0) {
      setResult(t("fr.noMatches"));
    } else {
      setResult(t("fr.replaced", { n: replacements, entries }));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-6 bg-black/60"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">
            {t("fr.title")}
          </h2>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("fr.findLabel")}
            </label>
            <input
              ref={findRef}
              className="dp-input"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={t("fr.findPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") onReplaceAll();
                if (e.key === "Escape") onClose();
              }}
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("fr.replaceLabel")}
            </label>
            <input
              className="dp-input"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder={t("fr.replacePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") onReplaceAll();
                if (e.key === "Escape") onClose();
              }}
            />
          </div>

          <div className="flex items-center gap-4 pt-1">
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              {t("fr.caseSensitive")}
            </label>
            <label className="flex items-center gap-2 text-[12px] text-[var(--text-muted)] cursor-pointer">
              <input
                type="checkbox"
                checked={wholeWord}
                onChange={(e) => setWholeWord(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              {t("fr.wholeWord")}
            </label>
          </div>

          <p className="text-[11px] text-[var(--text-faint)] pt-1 leading-relaxed">
            {t("fr.hint")}
          </p>

          {result && (
            <p
              className={`text-[12px] font-semibold ${
                result === t("fr.noMatches")
                  ? "text-[var(--text-muted)]"
                  : "text-[var(--success)]"
              }`}
            >
              {result}
            </p>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
          <button onClick={onClose} className="dp-btn">
            {t("btn.close")}
          </button>
          <button
            onClick={onReplaceAll}
            className="dp-btn dp-btn--primary"
            disabled={!find}
          >
            {t("fr.replaceAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
