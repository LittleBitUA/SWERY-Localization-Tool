import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import {
  highlight,
  searchAll,
  type SearchField,
  type SearchOptions,
  type SearchResult,
} from "../lib/search";
import { useT } from "../lib/i18n";

interface GlobalSearchModalProps {
  open: boolean;
  onClose: () => void;
}

function buildFieldLabels(t: (k: string) => string): Record<SearchField, string> {
  return {
    all: t("gs.field.all"),
    jp: t("gs.field.jp"),
    en: t("gs.field.en"),
    originalEn: t("gs.field.originalEn"),
    charaName: t("gs.field.charaName"),
  };
}

function fieldBadge(t: (k: string) => string, f: Exclude<SearchField, "all">): string {
  if (f === "charaName") return t("gs.field.charaName.short");
  return f === "jp" ? "JP" : f === "en" ? "UA" : "EN";
}

function shortName(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}

function Highlighted({ text, opts }: { text: string; opts: SearchOptions }) {
  const segs = useMemo(() => highlight(text, opts), [text, opts]);
  return (
    <>
      {segs.map((s, i) =>
        s.hit ? (
          <mark key={i} className="bg-[var(--warning)]/30 text-[var(--text-strong)] rounded px-0.5">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  );
}

export function GlobalSearchModal({ open, onClose }: GlobalSearchModalProps) {
  const t = useT();
  const FIELD_LABELS = buildFieldLabels(t);
  const folder = useStore((s) => s.folder);
  const loadFile = useStore((s) => s.loadFile);
  const setActive = useStore((s) => s.setActive);
  const saveTick = useStore((s) => s.saveTick);

  const [query, setQuery] = useState("");
  const [field, setField] = useState<SearchField>("all");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [regexError, setRegexError] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Debounced search. Реагуємо на query/опції + saveTick (щоб після Save переробити).
  useEffect(() => {
    if (!open || !folder) return;
    setRegexError(false);
    if (regex && query.trim()) {
      try { new RegExp(query); } catch { setRegexError(true); setResult(null); return; }
    }
    if (!query.trim()) {
      setResult(null);
      return;
    }
    const t = window.setTimeout(() => {
      setLoading(true);
      const opts: SearchOptions = { query, field, caseSensitive, regex };
      searchAll(folder, opts)
        .then((r) => setResult(r))
        .finally(() => setLoading(false));
    }, 220);
    return () => window.clearTimeout(t);
  }, [open, folder, query, field, caseSensitive, regex, saveTick]);

  if (!open) return null;

  const opts: SearchOptions = { query, field, caseSensitive, regex };

  function toggleFile(p: string) {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  async function jump(filePath: string, entryIndex: number) {
    await loadFile(filePath);
    setActive(entryIndex);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh]" onClick={onClose}>
      <div
        className="dp-card w-[920px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("gs.title")}</h2>
          <span className="text-[11px] text-[var(--text-faint)]">{t("gs.hint")}</span>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              className={`dp-input flex-1 ${regexError ? "border-[var(--danger)]" : ""}`}
              placeholder={regex ? t("gs.placeholderRegex") : t("gs.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); onClose(); }
                if (e.key === "Enter" && result && result.hits.length > 0) {
                  e.preventDefault();
                  const first = result.hits[0];
                  jump(first.filePath, first.entryIndex);
                }
              }}
            />
            <button
              className={`dp-btn ${regex ? "dp-btn--primary" : ""}`}
              title={t("gs.toggle.regex")}
              onClick={() => setRegex((v) => !v)}
            >
              .*
            </button>
            <button
              className={`dp-btn ${caseSensitive ? "dp-btn--primary" : ""}`}
              title={t("gs.toggle.case")}
              onClick={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {(Object.keys(FIELD_LABELS) as SearchField[]).map((f) => (
              <button
                key={f}
                className={`dp-btn ${field === f ? "dp-btn--primary" : ""}`}
                onClick={() => setField(f)}
              >
                {FIELD_LABELS[f]}
              </button>
            ))}
          </div>

          {regexError && (
            <p className="text-[11px] text-[var(--danger)]">{t("gs.invalidRegex")}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {!folder && (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gs.prompt.pickFolder")}</p>
          )}
          {folder && !query.trim() && (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gs.prompt.type")}</p>
          )}
          {folder && loading && (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gs.prompt.searching")}</p>
          )}
          {folder && !loading && query.trim() && result && result.hits.length === 0 && (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gs.prompt.none")}</p>
          )}

          {folder && result && result.hits.length > 0 && (
            <div className="py-1">
              {[...result.byFile.entries()].map(([filePath, fileHits]) => {
                const collapsed = collapsedFiles.has(filePath);
                return (
                  <div key={filePath} className="border-b border-[var(--border-soft)]">
                    <button
                      className="w-full px-4 py-1.5 flex items-center gap-2 text-left hover:bg-[var(--row-hover)]"
                      onClick={() => toggleFile(filePath)}
                    >
                      <svg
                        className={`w-3 h-3 shrink-0 text-[var(--text-faint)] transition-transform ${collapsed ? "" : "rotate-90"}`}
                        fill="currentColor"
                        viewBox="0 0 16 16"
                      >
                        <path d="M5 4l5 4-5 4V4z" />
                      </svg>
                      <span className="font-mono text-[12px] text-[var(--text)] truncate">
                        {shortName(filePath)}
                      </span>
                      <span className="text-[11px] text-[var(--text-faint)] tabular-nums ml-auto">
                        {fileHits.length}
                      </span>
                    </button>
                    {!collapsed && (
                      <ul>
                        {fileHits.map((h, idx) => {
                          const e = h.entry;
                          return (
                            <li
                              key={idx}
                              className="px-4 py-1.5 pl-8 hover:bg-[var(--row-hover)] cursor-pointer border-t border-[var(--border-soft)]"
                              onClick={() => jump(h.filePath, h.entryIndex)}
                            >
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="dp-pill text-[10px]">{fieldBadge(t, h.matchedField)}</span>
                                <span className="text-[11px] font-mono text-[var(--text-muted)] truncate" title={e.id}>
                                  {e.id || `#${h.entryIndex + 1}`}
                                </span>
                                {e.charaName && (
                                  <span className="text-[11px] text-[var(--text-faint)] truncate">
                                    {e.charaName}
                                  </span>
                                )}
                                <span className="ml-auto text-[10px] text-[var(--text-faint)]">→</span>
                              </div>
                              <p className="text-[12px] text-[var(--text-muted)] leading-snug line-clamp-2 whitespace-pre-wrap break-words">
                                <Highlighted text={h.matchedText} opts={opts} />
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {result && (
          <div className="px-5 py-2 border-t border-[var(--border-soft)] text-[11px] text-[var(--text-faint)] flex items-center gap-3">
            <span>
              {t("gs.found")}:{" "}
              <span className="text-[var(--text)] font-semibold">{result.hits.length}</span>{" "}
              {t("gs.in")}{" "}
              <span className="text-[var(--text)] font-semibold">{result.byFile.size}</span> {t("gs.files")}
            </span>
            {result.truncated && (
              <span className="text-[var(--warning)]">{t("gs.truncated")}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
