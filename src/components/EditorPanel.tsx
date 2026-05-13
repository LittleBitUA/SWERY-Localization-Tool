import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useStore } from "../lib/store";
import type { FlatEntry } from "../types";
import { useT } from "../lib/i18n";
import {
  DP_TOKEN_RULES,
  diffTags,
  extractTags,
  registerDpTextLanguage,
  setTagDiagnostics,
} from "../lib/monacoLang";

/** Сусідня репліка з тієї ж сцени (file+sheet+list). null — якщо її нема. */
function neighbor(entries: FlatEntry[], idx: number, delta: number): FlatEntry | null {
  const target = idx + delta;
  if (target < 0 || target >= entries.length) return null;
  const cur = entries[idx];
  const other = entries[target];
  if (cur.kind !== "sentence" || other.kind !== "sentence") return null;
  // Та сама сцена = той самий list і sheet у тому ж файлі.
  if (cur.locator.kind !== "sentence" || other.locator.kind !== "sentence") return null;
  if (
    cur.locator.filePath !== other.locator.filePath ||
    cur.locator.sheetIndex !== other.locator.sheetIndex ||
    cur.locator.listIndex !== other.locator.listIndex
  ) {
    return null;
  }
  return other;
}

function ContextRow({ entry, label, onJump }: { entry: FlatEntry; label: string; onJump: () => void }) {
  const t = useT();
  const speaker = entry.charaName || entry.charaNameJp || "—";
  const text = entry.en || entry.originalEn || entry.jp || "—";
  return (
    <button
      onClick={onJump}
      className="block w-full text-left px-4 py-1.5 border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)] transition-colors"
      title={t("editor.context.tooltip")}
    >
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
          {label}
        </span>
        <span className="text-[11px] font-semibold text-[var(--text-muted)] truncate">
          {speaker}
        </span>
      </div>
      <p className="text-[12px] text-[var(--text-muted)] leading-snug line-clamp-2 whitespace-pre-wrap">
        {text}
      </p>
    </button>
  );
}

export function EditorPanel() {
  const t = useT();
  const entries = useStore((s) => s.entries);
  const idx = useStore((s) => s.activeIndex);
  const updateActive = useStore((s) => s.updateActive);
  const saveFile = useStore((s) => s.saveFile);
  const step = useStore((s) => s.step);
  const setActive = useStore((s) => s.setActive);
  const jumpToNextUntranslated = useStore((s) => s.jumpToNextUntranslated);
  const copyOriginalToTranslation = useStore((s) => s.copyOriginalToTranslation);

  const active = idx !== null ? entries[idx] : null;
  const prevNeighbor = idx !== null ? neighbor(entries, idx, -1) : null;
  const nextNeighbor = idx !== null ? neighbor(entries, idx, 1) : null;
  const editorRef = useRef<any>(null);

  // Глобальні шорткати редактора. Capture=true, щоб перехоплювати раніше
  // за Monaco/інпути (інакше Monaco з'їсть Ctrl+Enter, Alt+стрілки тощо).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;

      // Ctrl+S — save
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        saveFile();
        return;
      }
      // Ctrl+Enter — save + next untranslated
      if (ctrl && !e.shiftKey && !e.altKey && k === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        (async () => {
          await saveFile();
          jumpToNextUntranslated();
        })();
        return;
      }
      // Ctrl+J — jump to next untranslated (без save)
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "j") {
        e.preventDefault();
        e.stopPropagation();
        jumpToNextUntranslated();
        return;
      }
      // Ctrl+D — copy original into translation
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "d") {
        e.preventDefault();
        e.stopPropagation();
        copyOriginalToTranslation();
        return;
      }
      // Alt+↑/↓ — prev/next entry
      if (e.altKey && !ctrl && !e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        step(k === "ArrowDown" ? 1 : -1);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [saveFile, step, jumpToNextUntranslated, copyOriginalToTranslation]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerDpTextLanguage(monaco);
    // Чистий VS Code-style темний — без сепії, без бордового
    monaco.editor.defineTheme("dp2-dark", {
      base: "vs-dark",
      inherit: true,
      rules: DP_TOKEN_RULES,
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#c9d1d9",
        "editorLineNumber.foreground": "#484f58",
        "editorLineNumber.activeForeground": "#8b949e",
        "editor.selectionBackground": "#388bfd44",
        "editor.lineHighlightBackground": "#161b22",
        "editor.lineHighlightBorder": "#161b22",
        "editorCursor.foreground": "#58a6ff",
        "editor.findMatchBackground": "#9e6a0399",
        "editor.findMatchHighlightBackground": "#9e6a0344",
        "editor.findMatchBorder": "#9e6a03",
        "editorWidget.background": "#161b22",
        "editorWidget.border": "#30363d",
        "editorWidget.foreground": "#c9d1d9",
        "input.background": "#0d1117",
        "input.border": "#30363d",
        "input.foreground": "#c9d1d9",
        "focusBorder": "#1f6feb",
        "scrollbarSlider.background": "#30363d99",
        "scrollbarSlider.hoverBackground": "#484f58cc",
        "scrollbarSlider.activeBackground": "#6e7681cc",
      },
    });
    monaco.editor.setTheme("dp2-dark");
    editor.focus();
    // Перша діагностика тегів для активного запису.
    if (active) {
      const origForDiag = active.originalEn ?? active.jp ?? "";
      setTagDiagnostics(monaco, editor, origForDiag, active.en);
    }
    // На зміну вмісту — оновлювати діагностику.
    editor.onDidChangeModelContent(() => {
      const cur = editor.getValue();
      if (active) {
        const origForDiag = active.originalEn ?? active.jp ?? "";
        setTagDiagnostics(monaco, editor, origForDiag, cur);
      }
    });
  };

  if (!active) {
    return (
      <aside className="h-full shrink-0 border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center justify-center p-8 text-center">
        <p className="text-[13px] text-[var(--text-muted)] max-w-xs leading-relaxed">
          {t("tm.empty.pick")}
        </p>
      </aside>
    );
  }

  const isSentence = active.kind === "sentence";

  return (
    <aside className="h-full shrink-0 border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-col">
      {/* Header — meta */}
      <div className="px-4 py-3 border-b border-[var(--border-soft)]">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {isSentence ? t("editor.kind.sentence") : t("editor.kind.item")}
          </p>
          {active.isVoiceOnly === 1 && <span className="dp-pill dp-pill--warn">{t("editor.voiceOnly")}</span>}
        </div>
        <h2 className="text-[16px] font-semibold text-[var(--text-strong)] leading-tight truncate">
          {isSentence
            ? (active.charaName || active.charaNameJp || t("editor.unknown"))
            : (active.itemName || active.id)}
        </h2>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2 text-[11px] font-mono text-[var(--text-faint)]">
          {active.id && <span>id: <span className="text-[var(--text-muted)]">{active.id}</span></span>}
          {active.context && <span>{active.context}</span>}
          {active.category && <span>{active.category}</span>}
        </div>
      </div>

      {/* Dialog context: previous reply (same scene) */}
      {prevNeighbor && idx !== null && (
        <ContextRow entry={prevNeighbor} label="↑ попередня" onJump={() => setActive(idx - 1)} />
      )}

      {/* JP reference */}
      <div className="px-4 py-2.5 border-b border-[var(--border-soft)] bg-[var(--bg)]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
            {t("editor.jp.label")}
          </span>
          <button
            className="text-[10px] uppercase tracking-wider text-[var(--accent)] hover:underline"
            onClick={() => navigator.clipboard.writeText(active.jp)}
          >
            {t("btn.copy")}
          </button>
        </div>
        <p className="text-[13px] text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap">
          {isSentence && active.charaNameJp && (
            <span className="text-[var(--text-faint)] mr-2">{active.charaNameJp}:</span>
          )}
          {active.jp || <span className="italic text-[var(--text-faint)]">—</span>}
        </p>
      </div>

      {/* original EN reference */}
      {active.originalEn !== undefined && (
        <div className="px-4 py-2.5 border-b border-[var(--border-soft)] bg-[var(--bg)]">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
              {t("editor.en.label")}
            </span>
            <button
              className="text-[10px] uppercase tracking-wider text-[var(--accent)] hover:underline"
              onClick={() => navigator.clipboard.writeText(active.originalEn ?? "")}
            >
              {t("btn.copy")}
            </button>
          </div>
          <p className="text-[13px] text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap">
            {active.originalEn}
          </p>
        </div>
      )}

      {/* Dialog context: next reply (same scene) */}
      {nextNeighbor && idx !== null && (
        <ContextRow entry={nextNeighbor} label="↓ наступна" onJump={() => setActive(idx + 1)} />
      )}

      {/* Tags mirror — теги з оригіналу і diff vs поточного перекладу */}
      {(() => {
        const origForTags = active.originalEn ?? active.jp ?? "";
        const tagsOrig = extractTags(origForTags);
        if (tagsOrig.length === 0) return null;
        const { missing, extra } = diffTags(origForTags, active.en);
        return (
          <div className="px-4 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)]">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                {t("editor.tags.label")}
              </span>
              {(missing.length > 0 || extra.length > 0) && (
                <span className="text-[10px] text-[var(--warning)]">
                  {missing.length > 0 && t("editor.tags.missing", { n: missing.length })}
                  {missing.length > 0 && extra.length > 0 && " · "}
                  {extra.length > 0 && t("editor.tags.extra", { n: extra.length })}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {tagsOrig.map((tag, i) => {
                const isMissing = missing.includes(tag);
                return (
                  <span
                    key={i}
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                      isMissing
                        ? "border-[var(--warning)] text-[var(--warning)] bg-[var(--warning)]/10"
                        : "border-[var(--border-soft)] text-[var(--text-muted)] bg-[var(--bg-elevated)]"
                    }`}
                  >
                    {tag}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Editable: name (sentence only) */}
      {isSentence && (
        <div className="px-4 py-2.5 border-b border-[var(--border-soft)]">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
            {t("editor.name.label")}
          </label>
          <input
            className="dp-input"
            value={active.charaName ?? ""}
            onChange={(e) => updateActive(e.target.value, active.en)}
          />
        </div>
      )}

      {/* Monaco editor — main translation field */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-4 pt-2 pb-1 flex items-center justify-between shrink-0">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {isSentence ? t("editor.ua.sentence") : t("editor.ua.item")}
          </label>
          <span className="text-[10px] text-[var(--text-faint)] tabular-nums">
            {active.en.length} {t("dp1.chars")}
          </span>
        </div>
        <div className="flex-1 min-h-0 mx-3 mb-3 border border-[var(--border)] rounded-md overflow-hidden">
          <Editor
            key={`${active.locator.filePath}::${idx}`}
            defaultValue={active.en}
            onChange={(v) => updateActive(active.charaName ?? "", v ?? "")}
            language="dp-text"
            theme="dp2-dark"
            onMount={handleMount}
            options={{
              fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", "Consolas", monospace',
              fontSize: 13,
              lineHeight: 20,
              wordWrap: "on",
              minimap: { enabled: false },
              lineNumbers: "on",
              folding: false,
              renderLineHighlight: "line",
              scrollBeyondLastLine: false,
              padding: { top: 10, bottom: 10 },
              fixedOverflowWidgets: true,
              find: {
                addExtraSpaceOnTop: false,
                autoFindInSelection: "never",
                seedSearchStringFromSelection: "selection",
              },
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

      {/* Footer with shortcuts */}
      <div className="px-4 py-2 border-t border-[var(--border-soft)] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-faint)]">
        <span className="dp-kbd">Ctrl+Enter</span>
        <span>{t("editor.kbd.saveNext")}</span>
        <span className="dp-kbd">Ctrl+J</span>
        <span>{t("editor.kbd.nextUntranslated")}</span>
        <span className="dp-kbd">Alt+↑/↓</span>
        <span>{t("editor.kbd.between")}</span>
        <span className="dp-kbd">Ctrl+D</span>
        <span>{t("editor.kbd.copyOriginal")}</span>
        <span className="dp-kbd">Ctrl+S</span>
        <span>{t("editor.kbd.save")}</span>
        <span className="dp-kbd">Ctrl+\</span>
        <span>{t("editor.kbd.focus")}</span>
      </div>
    </aside>
  );
}
