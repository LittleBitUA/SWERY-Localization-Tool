// TGL Monaco-editor: split-view 2× Monaco (left RO original, right editable
// translation). Дані тримаються у Documents/SWERY-Localization-Tool/TGL/Text/
// TRANSLATION/<bin>.txt — main.cjs дзеркалить це у <binPath>.txt (workfile),
// тож pack-логіка читає звідти і нічого не треба переробляти.
//
// Користувач казав «я редагую у Notepad++» — оце і є той самий wokflow,
// тільки в одному вікні поряд з оригіналом і кнопками Save/Import/Export/Pack.

import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useT } from "../../lib/i18n";
import { alert as showAlert, confirm as showConfirm } from "../../lib/dialogs";

interface Props {
  binPath: string;
  onBack: () => void;
  onAfterPack?: () => void;
}

export function TglTextEditor({ binPath, onBack, onAfterPack }: Props) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [translation, setTranslation] = useState("");
  const [original, setOriginal] = useState("");
  const [binName, setBinName] = useState<string>("");
  const [translationPath, setTranslationPath] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [packing, setPacking] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leftRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rightRef = useRef<any>(null);
  // Прапор-захист від feedback-loop: коли один редактор тригерить scroll
  // іншого, ми НЕ маємо реагувати на цю саму подію.
  const syncingRef = useRef(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wireSyncScroll(source: any, target: () => any) {
    source.onDidScrollChange((e: { scrollTop: number; scrollLeft: number }) => {
      if (syncingRef.current) return;
      const dst = target();
      if (!dst) return;
      syncingRef.current = true;
      try {
        dst.setScrollTop(e.scrollTop);
        dst.setScrollLeft(e.scrollLeft);
      } finally {
        // Дочекатись наступного RAF — Monaco повторно емітить scroll-event
        // зсередини setScrollTop, без цього guard «зависає» в true.
        requestAnimationFrame(() => { syncingRef.current = false; });
      }
    });
  }

  const handleMountLeft: OnMount = (editor, monaco) => {
    leftRef.current = editor;
    monaco.editor.defineTheme("tgl-monaco-dark", {
      base: "vs-dark", inherit: true, rules: [],
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#c9d1d9",
        "editorLineNumber.foreground": "#484f58",
        "editorLineNumber.activeForeground": "#8b949e",
        "editor.selectionBackground": "#388bfd44",
        "editor.lineHighlightBackground": "#161b22",
        "editorCursor.foreground": "#58a6ff",
      },
    });
    monaco.editor.setTheme("tgl-monaco-dark");
    wireSyncScroll(editor, () => rightRef.current);
  };
  const handleMountRight: OnMount = (editor) => {
    rightRef.current = editor;
    wireSyncScroll(editor, () => leftRef.current);
    editor.focus();
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    window.dp2.tglTextPrep({ binPath }).then((r) => {
      if (cancelled) return;
      if (!r.ok) { setError(r.error ?? "prep fail"); setLoading(false); return; }
      setOriginal(r.originalContent ?? "");
      setTranslation(r.translationContent ?? "");
      setBinName(r.binName ?? "");
      setTranslationPath(r.translationPath ?? "");
      setDirty(false);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(String((e as Error)?.message ?? e));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [binPath]);

  // Ctrl+S — save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) doSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, translation]);

  async function doSave() {
    if (saving) return;
    setSaving(true);
    try {
      const r = await window.dp2.tglTextWrite({ binPath, content: translation });
      if (!r.ok) {
        await showAlert(t("tgl.text.saveErrTitle"), r.error ?? "?", { tone: "danger" });
        return;
      }
      setDirty(false);
    } finally { setSaving(false); }
  }

  async function doImport() {
    const src = await window.dp2.pickFile({
      title: t("tgl.text.importTitle"),
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!src) return;
    if (dirty) {
      const ok = await showConfirm(
        t("tgl.text.importConfirmTitle"),
        t("tgl.text.importConfirmBody"),
        { tone: "warning", okLabel: t("tgl.text.importConfirmOk") },
      );
      if (!ok) return;
    }
    const raw = await window.dp2.readFile(src);
    setTranslation(raw);
    setDirty(true);
  }

  async function doExport() {
    const dest = await window.dp2.pickSaveFile({
      title: t("tgl.text.exportTitle"),
      defaultPath: `${binName || "tgl"}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) return;
    await window.dp2.writeFile(dest, translation);
    await showAlert(t("tgl.text.exportDoneTitle"), t("tgl.text.exportDoneBody", { path: dest }), { tone: "success" });
  }

  async function doPack() {
    // Pack читає workfile, який вже синхронізований при save. Якщо є dirty —
    // спершу save, потім pack.
    if (dirty) {
      const ok = await showConfirm(
        t("tgl.text.packConfirmTitle"),
        t("tgl.text.packConfirmBody"),
        { tone: "warning", okLabel: t("tgl.text.packConfirmOk") },
      );
      if (!ok) return;
      const sr = await window.dp2.tglTextWrite({ binPath, content: translation });
      if (!sr.ok) {
        await showAlert(t("tgl.text.saveErrTitle"), sr.error ?? "?", { tone: "danger" });
        return;
      }
      setDirty(false);
    }
    setPacking(true);
    try {
      // Передаємо ua як рядки з translation. Pack у heavy-worker все одно
      // читає workfile, але інтерфейс вимагає ua-array.
      const ua = translation.split(/\r?\n/);
      const r = await window.dp2.tglPack({ binPath, ua });
      if (r.error) {
        await showAlert(t("tgl.pack.errorTitle"), r.error, { tone: "danger" });
        return;
      }
      onAfterPack?.();
    } finally { setPacking(false); }
  }

  const originalLines = original ? original.split(/\r?\n/).length : 0;
  const translationLines = translation ? translation.split(/\r?\n/).length : 0;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12.5px] text-[var(--text-muted)]">
        {t("tgl.text.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-[13px] text-[var(--danger)] mb-2">{t("tgl.text.errTitle")}</p>
          <p className="text-[12px] font-mono text-[var(--text-muted)] whitespace-pre-wrap break-words">{error}</p>
          <button className="dp-btn mt-3" onClick={onBack}>← {t("btn.back")}</button>
        </div>
      </div>
    );
  }

  const lineMismatch = translationLines !== originalLines;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onBack}>← {t("btn.back")}</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">
          TGL · {t("tgl.text.title")} · {binName}
        </span>
        <span className={`text-[11px] tabular-nums ml-2 ${lineMismatch ? "text-[var(--warning,#d97706)]" : "text-[var(--text-faint)]"}`}
          title={lineMismatch ? t("tgl.text.lineMismatchHint", { ua: translationLines, en: originalLines }) : undefined}>
          {translationLines} / {originalLines}
        </span>
        <div className="flex-1" />
        <button className="dp-btn dp-btn--ghost" onClick={doImport} title={t("tgl.text.importHint")}>
          <svg className="w-3.5 h-3.5 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h3a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
          </svg>
          {t("tgl.text.import")}
        </button>
        <button className="dp-btn dp-btn--ghost" onClick={doExport} title={t("tgl.text.exportHint")}>
          <svg className="w-3.5 h-3.5 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h-3a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 3l5 5m0 0v-5m0 5h-5M9 14l11-11" />
          </svg>
          {t("tgl.text.export")}
        </button>
        <button
          className={`dp-btn ${dirty ? "dp-btn--primary" : ""}`}
          onClick={doSave}
          disabled={!dirty || saving}
          title="Ctrl+S"
        >
          {saving ? t("tgl.text.saving") : t("tgl.text.save")}
        </button>
        <button
          className="dp-btn dp-btn--success"
          onClick={doPack}
          disabled={packing}
        >
          {packing ? t("tgl.text.packing") : t("tgl.text.pack")}
        </button>
      </header>

      {translationPath && (
        <div className="px-4 py-1.5 border-b border-[var(--border-soft)] bg-[var(--bg)] text-[11px] font-mono text-[var(--text-faint)] truncate" title={translationPath}>
          {translationPath}
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0 border-r border-[var(--border-soft)]">
          <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-surface)] border-b border-[var(--border-soft)] shrink-0">
            {t("tgl.text.originalLabel")}
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              value={original}
              language="plaintext"
              theme="tgl-monaco-dark"
              onMount={handleMountLeft}
              options={{
                readOnly: true,
                fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", "Consolas", monospace',
                fontSize: 13,
                lineHeight: 20,
                wordWrap: "on",
                minimap: { enabled: false },
                lineNumbers: "on",
                folding: false,
                renderLineHighlight: "all",
                scrollBeyondLastLine: false,
                padding: { top: 10, bottom: 10 },
                // Monaco за замовч. підсвічує "схожі" символи (латин/кирил/JP) —
                // це дратує у білінгвальному перекладі, тому глушимо все.
                unicodeHighlight: {
                  ambiguousCharacters: false,
                  invisibleCharacters: false,
                  nonBasicASCII: false,
                },
              }}
            />
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-surface)] border-b border-[var(--border-soft)] shrink-0 flex items-center justify-between">
            <span>{t("tgl.text.translationLabel")}</span>
            {dirty && <span className="text-[var(--accent)]">●</span>}
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              value={translation}
              onChange={(v) => { setTranslation(v ?? ""); setDirty(true); }}
              language="plaintext"
              theme="tgl-monaco-dark"
              onMount={handleMountRight}
              options={{
                fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", "Consolas", monospace',
                fontSize: 13,
                lineHeight: 20,
                wordWrap: "on",
                minimap: { enabled: false },
                lineNumbers: "on",
                folding: false,
                renderLineHighlight: "all",
                scrollBeyondLastLine: false,
                padding: { top: 10, bottom: 10 },
                // Monaco за замовч. підсвічує "схожі" символи (латин/кирил/JP) —
                // це дратує у білінгвальному перекладі, тому глушимо все.
                unicodeHighlight: {
                  ambiguousCharacters: false,
                  invisibleCharacters: false,
                  nonBasicASCII: false,
                },
                tabSize: 2,
                renderWhitespace: "selection",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
