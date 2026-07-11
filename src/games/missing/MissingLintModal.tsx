import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { parseMissingMsg } from "./parser";

interface FileItem {
  name: string;
  file: string;
  origPath: string;
  donePath: string;
  hasDone: boolean;
}

interface Violation {
  file: string;
  idx: number;
  msgEnum: number;
  kind: "empty" | "placeholder-translated" | "tag-mismatch" | "bad-escape";
  original: string;
  current: string;
  detail?: string;
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

const TOKEN_RE = /<\/?[a-zA-Z][^<>]*>/g;
function isPlaceholderText(s: string) {
  return s === "NO_TEXT_en" || /^[A-Z_0-9]+_en$/.test(s) || /^V_[A-Z]{2}_\d{3}$/.test(s);
}

// Швидкий lint для MISSING. Знаходить:
//   1. empty: переклад порожній, але оригінал — реальний текст
//   2. placeholder-translated: NO_TEXT_en/V_*_001 змінено (а не повинно)
//   3. tag-mismatch: <color>/<scale>/<ruby> теги не збігаються з оригіналом
//   4. bad-escape: непарні \" або інші підозрілі escape (рідко)
async function runLint(files: FileItem[], t: (key: string, params?: Record<string, string | number>) => string): Promise<Violation[]> {
  const W = window.dp2 as unknown as { missingTextRead: (p: string) => Promise<{ ok: boolean; base64?: string }> };
  const out: Violation[] = [];
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
      const enumN = orig.entries[i]?.msgEnum ?? -1;
      const isPh = isPlaceholderText(o);

      if (isPh && d !== o) {
        out.push({ file: f.name, idx: i, msgEnum: enumN, kind: "placeholder-translated", original: o, current: d, detail: t("missing.lint.detail.placeholder") });
        continue;
      }
      if (!isPh && o && (!d || !d.trim())) {
        out.push({ file: f.name, idx: i, msgEnum: enumN, kind: "empty", original: o, current: d });
        continue;
      }
      if (d === o || isPh) continue;
      // Tag-set
      const oT = (o.match(TOKEN_RE) || []).map((t) => t.replace(/=#?[0-9a-fA-F.,\s]+/g, "=N")).sort();
      const dT = (d.match(TOKEN_RE) || []).map((t) => t.replace(/=#?[0-9a-fA-F.,\s]+/g, "=N")).sort();
      if (oT.join("|") !== dT.join("|")) {
        out.push({ file: f.name, idx: i, msgEnum: enumN, kind: "tag-mismatch", original: o, current: d, detail: `EN: [${oT.join(", ") || "—"}]  UA: [${dT.join(", ") || "—"}]` });
        continue;
      }
      // Перевірка непарних \"
      const dq = (d.match(/\\"/g) || []).length;
      const oq = (o.match(/\\"/g) || []).length;
      if (dq !== oq) {
        out.push({ file: f.name, idx: i, msgEnum: enumN, kind: "bad-escape", original: o, current: d, detail: `EN \\" count: ${oq}, UA \\" count: ${dq}` });
      }
    }
  }
  return out;
}

export function MissingLintModal({ open, onClose, files, onGoTo }: Props) {
  const t = useT();
  const [items, setItems] = useState<Violation[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(0);

  async function load() {
    setLoading(true); setScanned(0);
    try {
      const r = await runLint(files, t);
      setItems(r);
      setScanned(files.length);
    } finally { setLoading(false); }
  }
  useEffect(() => { if (open) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const kindLabel = (k: Violation["kind"]) => k === "empty" ? t("missing.lint.kind.empty")
    : k === "placeholder-translated" ? t("missing.lint.kind.placeholder")
    : k === "tag-mismatch" ? t("missing.lint.kind.tagMismatch")
    : t("missing.lint.kind.badEscape");
  const kindColor = (k: Violation["kind"]) => k === "empty" ? "var(--danger)"
    : k === "placeholder-translated" ? "var(--warning,#d97706)"
    : k === "tag-mismatch" ? "var(--danger)"
    : "var(--warning,#d97706)";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70" onClick={onClose}>
      <div className="dp-card w-full max-w-4xl flex flex-col" style={{ maxHeight: "85vh" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("missing.lint.title")}</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              {t("missing.lint.summary", { problems: String(items.length), files: String(scanned) })}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={load} className="dp-btn" disabled={loading}>{loading ? "…" : t("missing.lint.refresh")}</button>
            <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {loading && <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("missing.lint.checking")}</p>}
          {!loading && items.length === 0 && (
            <p className="py-10 text-center text-[13px] text-[var(--success)]">{t("missing.lint.clean")}</p>
          )}
          {!loading && items.length > 0 && (
            <div className="space-y-2">
              {items.map((v, i) => {
                const f = files.find((x) => x.name === v.file);
                return (
                  <div key={i} className="border border-[var(--border-soft)] rounded p-3 bg-[var(--bg)] hover:border-[var(--accent)]/40 transition-colors">
                    <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span style={{ color: kindColor(v.kind) }} className="font-semibold">{kindLabel(v.kind)}</span>
                        <span className="font-mono text-[var(--text-faint)]">{v.file}</span>
                        <span className="font-mono text-[var(--text-muted)]">#{v.idx}</span>
                        {v.msgEnum >= 0 && <span className="font-mono text-[var(--text-muted)]">enum {v.msgEnum}</span>}
                      </div>
                      {f && (
                        <button className="dp-btn dp-btn--ghost text-[11px]" onClick={() => onGoTo(f, v.idx)}>{t("missing.lint.goto")} →</button>
                      )}
                    </div>
                    {v.detail && <p className="text-[10.5px] font-mono text-[var(--text-faint)] mb-1">{v.detail}</p>}
                    <p className="text-[11.5px] text-[var(--text-muted)] line-clamp-2 whitespace-pre-wrap break-words mb-0.5">
                      <span className="text-[var(--text-faint)] mr-1">EN:</span>{v.original || "—"}
                    </p>
                    <p className="text-[11.5px] text-[var(--text)] line-clamp-2 whitespace-pre-wrap break-words">
                      <span className="text-[var(--text-faint)] mr-1">UA:</span>{v.current || "—"}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
