// Правий sidebar HBR-редактора. Замінює inline-textarea-на-кожному-рядку
// (повільно на 1000+ items) на ОДИН Monaco-editor для активного запису —
// той самий патерн, що у DP2 EditorPanel. Перемикання рядка ремонтує
// редактор через key={textId::variantIdx}, щоб Monaco перестворював модель.
//
// API мінімальний: item (поточний активний рядок), onChange, контекст
// сусідів, валідація плейсхолдерів.

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoEditor from "monaco-editor";
import { useT } from "../../lib/i18n";
import { extractPlaceholders, validatePlaceholders, type HbrTextItem } from "./parser";
import { MonacoFontSizeControl, useMonacoFontSize } from "../../components/MonacoFontSize";

interface Props {
  item: HbrTextItem | null;
  prev: HbrTextItem | null;
  next: HbrTextItem | null;
  onChange: (newValue: string) => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
  onClose: () => void;
}

export function HbrItemEditor({ item, prev, next, onChange, onJumpPrev, onJumpNext, onClose }: Props) {
  const t = useT();
  const [monacoFontSize] = useMonacoFontSize();
  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null);
  // Стабільний Monaco-інстанс: НЕ перемонтуємо при перемиканні запису —
  // лише `model.setValue(item.current)` через ref. Це знімає ~50–100ms
  // лагу на клік (Monaco mount важкий) і прибирає витоки моделей.
  const lastKeyRef = useRef<string | null>(null);
  const skipNextChangeRef = useRef(false);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    // Темний VS-Code-style. Користуємось вже існуючою темою dp2-dark, якщо вона
    // зареєстрована EditorPanel-ом; якщо ще ні — створюємо тимчасову мінімалку.
    try {
      monaco.editor.defineTheme("hbr-dark", {
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
      monaco.editor.setTheme("hbr-dark");
    } catch { /* тема вже є — нічого */ }
    editor.focus();
  };

  // Sync model коли перемикається запис (стабільний Monaco, без remount).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !item) return;
    const key = `${item.textId}::${item.variantIdx}`;
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
    // Той самий запис — не перетираємо value, інакше з'їдається останній
    // символ між debounce-flush у parent і цим effect-ом.
  }, [item]);

  if (!item) {
    return (
      <aside className="h-full shrink-0 border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center justify-center p-8 text-center">
        <p className="text-[13px] text-[var(--text-muted)] max-w-xs leading-relaxed">
          {t("hbr.itemEditor.empty")}
        </p>
      </aside>
    );
  }

  const isSame = item.current === item.original;
  const isEmpty = !item.current || item.current.trim().length === 0;
  const { missing, extra } = validatePlaceholders(item.original, item.current);
  const tags = extractPlaceholders(item.original);

  return (
    <aside className="h-full shrink-0 w-[480px] border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-col">
      <div className="px-4 py-2.5 border-b border-[var(--border-soft)] flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)] mb-0.5">
            {t("hbr.itemEditor.entry")}
          </p>
          <p className="text-[12px] font-mono text-[var(--text)] truncate" title={item.textId}>
            {item.textId}
          </p>
          <p className="text-[11px] text-[var(--text-faint)] tabular-nums mt-0.5">
            {t("hbr.itemEditor.variant", { n: item.variantIdx })}
          </p>
        </div>
        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={onClose}
          title={t("btn.close")}
        >
          ✕
        </button>
      </div>

      {/* Original EN */}
      <div className="px-4 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
            {t("hbr.itemEditor.original")}
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

      {/* Tags mirror */}
      {tags.length > 0 && (
        <div className="px-4 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
              {t("hbr.itemEditor.tags")}
            </span>
            {(missing.length > 0 || extra.length > 0) && (
              <span className="text-[10px] text-[var(--warning,#d97706)]">
                {missing.length > 0 && t("hbr.itemEditor.tagsMissing", { n: missing.length })}
                {missing.length > 0 && extra.length > 0 && " · "}
                {extra.length > 0 && t("hbr.itemEditor.tagsExtra", { n: extra.length })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {tags.map((tag, i) => {
              const isMissing = missing.includes(tag);
              return (
                <span
                  key={i}
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    isMissing
                      ? "border-[var(--warning,#d97706)] text-[var(--warning,#d97706)] bg-[var(--warning,#d97706)]/10"
                      : "border-[var(--border-soft)] text-[var(--text-muted)] bg-[var(--bg-elevated)]"
                  }`}
                >
                  {tag}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Monaco — переклад */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 pt-2 pb-1 flex items-center justify-between shrink-0 gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t("hbr.itemEditor.translation")}
          </label>
          <span className="text-[10px] text-[var(--text-faint)] tabular-nums flex items-center gap-2">
            <MonacoFontSizeControl />
            {isEmpty
              ? <span className="text-[var(--danger)]">{t("hbr.itemEditor.empty.badge")}</span>
              : isSame
                ? <span className="text-[var(--warning,#d97706)]">{t("hbr.itemEditor.same.badge")}</span>
                : <span className="text-[var(--success)]">{t("hbr.itemEditor.ok.badge")}</span>}
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
            theme="hbr-dark"
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
            }}
          />
        </div>
      </div>

      {/* Nav */}
      <div className="px-4 py-1.5 border-t border-[var(--border-soft)] flex items-center justify-between bg-[var(--bg)]">
        <button
          className="dp-btn dp-btn--ghost"
          onClick={onJumpPrev}
          disabled={!prev}
          title={t("hbr.itemEditor.prev")}
        >
          ← {t("hbr.itemEditor.prev")}
        </button>
        <button
          className="dp-btn dp-btn--ghost"
          onClick={onJumpNext}
          disabled={!next}
          title={t("hbr.itemEditor.next")}
        >
          {t("hbr.itemEditor.next")} →
        </button>
      </div>
    </aside>
  );
}
