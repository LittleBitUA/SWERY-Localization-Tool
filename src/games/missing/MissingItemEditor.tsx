// Правий side-panel редактора THE MISSING — один Monaco для активного рядка.
// Замість inline-textarea-у-кожному-рядку (повільно і незручно), як у HBR.

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoEditor from "monaco-editor";
import { useT } from "../../lib/i18n";
import { MonacoFontSizeControl, useMonacoFontSize } from "../../components/MonacoFontSize";

export interface MissingActiveItem {
  /** Абсолютний оффсет рядка у m_Script (HEX-друк у UI). */
  offset: number;
  /** Англійський оригінал (read-only). */
  original: string;
  /** Поточне значення (переклад або копія original). */
  current: string;
  /** Індекс у _List.Array оригіналу — для key/перемикання. */
  index: number;
  /** Глобальний MsgEnum (для пошуку у IMHeightInfo). -1 якщо не в length-table. */
  msgEnum?: number;
  /** Box-sizes для всіх мов з IMHeightInfo (4 пари w/h). undefined якщо нема. */
  sizes?: Array<{ w: number; h: number }>;
}

interface Props {
  item: MissingActiveItem | null;
  prev: MissingActiveItem | null;
  next: MissingActiveItem | null;
  onChange: (next: string) => void;
  onSizeChange?: (langIdx: number, w: number, h: number) => void;
  /** Цільовий слот для перекладу (для підсвічування у Box-sizes). 0..3. */
  targetLang?: number;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onClose: () => void;
}

const LANG_LABEL_KEYS = [
  "missing.item.lang.en.label",
  "missing.item.lang.jp.label",
  "missing.item.lang.cn.label",
  "missing.item.lang.kr.label",
];
const LANG_HINT_KEYS = [
  "missing.item.lang.en.hint",
  "missing.item.lang.jp.hint",
  "missing.item.lang.cn.hint",
  "missing.item.lang.kr.hint",
];

export function MissingItemEditor({ item, prev, next, onChange, onSizeChange, targetLang = 0, onJumpPrev, onJumpNext, onClose }: Props) {
  const t = useT();
  const [monacoFontSize] = useMonacoFontSize();
  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);
  // Стабільний Monaco — `model.setValue` замість key-remount.
  const lastKeyRef = useRef<string | null>(null);
  const skipNextChangeRef = useRef(false);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    try {
      monaco.editor.defineTheme("missing-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#0d1117",
          "editor.foreground": "#c9d1d9",
          "editorLineNumber.foreground": "#484f58",
          "editor.selectionBackground": "#388bfd44",
          "editor.lineHighlightBackground": "#161b22",
          "editor.lineHighlightBorder": "#161b22",
          "editorCursor.foreground": "#58a6ff",
        },
      });
      monaco.editor.setTheme("missing-dark");
    } catch { /* тема уже є */ }
    editor.focus();
  };

  // Sync моделі при перемиканні запису без re-mount Monaco.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !item) return;
    const key = `${item.offset}-${item.index}`;
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      skipNextChangeRef.current = true;
      const model = ed.getModel();
      if (model) {
        model.setValue(item.current ?? "");
        model.pushStackElement();
      }
      ed.setPosition({ lineNumber: 1, column: 1 });
      ed.focus();
    }
  }, [item]);

  if (!item) {
    return (
      <aside className="h-full shrink-0 w-[480px] border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center justify-center p-8 text-center">
        <p className="text-[13px] text-[var(--text-muted)] max-w-xs leading-relaxed">
          {t("missing.itemEditor.empty")}
        </p>
      </aside>
    );
  }

  const isSame = item.current === item.original;
  const isEmpty = !item.current || item.current.trim().length === 0;
  const offsetHex = "0x" + item.offset.toString(16).padStart(6, "0");

  return (
    <aside className="h-full shrink-0 w-[480px] border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-col">
      <div className="px-4 py-2.5 border-b border-[var(--border-soft)] flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)] mb-0.5">
            {t("missing.itemEditor.entry")}
          </p>
          <p className="text-[12px] font-mono text-[var(--text)] truncate" title={offsetHex}>{offsetHex}</p>
        </div>
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={onClose} title={t("btn.close")}>✕</button>
      </div>

      <div className="px-4 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
            {t("missing.itemEditor.original")}
          </span>
          <button
            className="text-[10px] uppercase tracking-wider text-[var(--accent)] hover:underline"
            onClick={() => navigator.clipboard.writeText(item.original)}
          >
            {t("btn.copy")}
          </button>
        </div>
        <p className="text-[12.5px] text-[var(--text-muted)] leading-snug whitespace-pre-wrap break-words max-h-32 overflow-auto">
          {item.original || <span className="italic text-[var(--text-faint)]">—</span>}
        </p>
      </div>

      {/* Box-sizes (IMHeightInfo) — тільки цільовий слот, інші мови не чіпаємо. */}
      {item.sizes && item.sizes[targetLang] && (
        <div className="px-4 py-2 border-b border-[var(--border-soft)]">
          <div className="flex items-center justify-between mb-1.5 gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
              {t("missing.item.boxSize", { lang: String(targetLang), code: LANG_LABEL_KEYS[targetLang] ? t(LANG_LABEL_KEYS[targetLang]) : "?" })}
            </span>
            <span className="text-[10px] text-[var(--text-faint)]" title={t("missing.item.enumTitle")}>
              enum {item.msgEnum && item.msgEnum >= 0 ? item.msgEnum : "—"}
            </span>
          </div>
          <div className="flex items-center gap-2 border border-[var(--accent)]/60 bg-[var(--accent)]/8 rounded p-2">
            <label className="text-[10px] text-[var(--text-faint)] uppercase">W</label>
            <input
              type="number" min={0} step={1}
              className="dp-input !p-1 !text-[12px] tabular-nums w-[80px]"
              value={item.sizes[targetLang].w}
              onChange={(e) => onSizeChange?.(targetLang, parseFloat(e.target.value) || 0, item.sizes![targetLang].h)}
              title={t("missing.item.widthTitle")}
            />
            <span className="text-[var(--text-faint)]">×</span>
            <label className="text-[10px] text-[var(--text-faint)] uppercase">H</label>
            <input
              type="number" min={0} step={1}
              className="dp-input !p-1 !text-[12px] tabular-nums w-[80px]"
              value={item.sizes[targetLang].h}
              onChange={(e) => onSizeChange?.(targetLang, item.sizes![targetLang].w, parseFloat(e.target.value) || 0)}
              title={t("missing.item.heightTitle")}
            />
            <span className="text-[10px] text-[var(--text-faint)] ml-auto italic">
              {LANG_HINT_KEYS[targetLang] ? t(LANG_HINT_KEYS[targetLang]) : ""}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 pt-2 pb-1 flex items-center justify-between shrink-0 gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t("missing.itemEditor.translation")}
          </label>
          <span className="text-[10px] text-[var(--text-faint)] tabular-nums flex items-center gap-2">
            <MonacoFontSizeControl />
            {isEmpty
              ? <span className="text-[var(--danger)]">{t("missing.itemEditor.empty.badge")}</span>
              : isSame
                ? <span className="text-[var(--warning,#d97706)]">{t("missing.itemEditor.same.badge")}</span>
                : <span className="text-[var(--success)]">{t("missing.itemEditor.ok.badge")}</span>}
            <span>{item.current.length}</span>
          </span>
        </div>
        <div className="flex-1 min-h-0 mx-3 mb-3 border border-[var(--border)] rounded-md overflow-hidden">
          <Editor
            defaultValue={item.current}
            onChange={(v) => {
              if (skipNextChangeRef.current) { skipNextChangeRef.current = false; return; }
              onChange(v ?? "");
            }}
            language="plaintext"
            theme="missing-dark"
            onMount={handleMount}
            options={{
              fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", "Consolas", monospace',
              fontSize: monacoFontSize,
              lineHeight: Math.round(monacoFontSize * 1.55),
              wordWrap: "on",
              minimap: { enabled: false },
              lineNumbers: "off",
              folding: false,
              renderLineHighlight: "line",
              scrollBeyondLastLine: false,
              padding: { top: 10, bottom: 10 },
              fixedOverflowWidgets: true,
              contextmenu: true,
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              acceptSuggestionOnEnter: "off",
              tabSize: 2,
              renderWhitespace: "selection",
              unicodeHighlight: {
                ambiguousCharacters: false,
                invisibleCharacters: false,
                nonBasicASCII: false,
              },
            }}
          />
        </div>
      </div>

      <div className="px-4 py-1.5 border-t border-[var(--border-soft)] flex items-center justify-between bg-[var(--bg)]">
        <button className="dp-btn dp-btn--ghost" onClick={onJumpPrev} disabled={!prev} title={t("missing.itemEditor.prev")}>
          ← {t("missing.itemEditor.prev")}
        </button>
        <button className="dp-btn dp-btn--ghost" onClick={onJumpNext} disabled={!next} title={t("missing.itemEditor.next")}>
          {t("missing.itemEditor.next")} →
        </button>
      </div>
    </aside>
  );
}
