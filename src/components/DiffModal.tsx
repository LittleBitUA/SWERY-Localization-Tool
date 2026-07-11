// Side-by-side діф між оригіналом і поточним перекладом активного запису.
// Користувач натискає кнопку "Diff" у toolbar — відкривається модалка з
// Monaco DiffEditor (read-only). Корисно для вилову зайвих крапок, тегів,
// пробілів і пропущених рядків — речей, які важко помітити у звичайному edit.
//
// Принципово read-only: редагуємо у головному редакторі, тут лише дивимось.

import { DiffEditor } from "@monaco-editor/react";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  original: string;
  modified: string;
  /** Заголовок з ID/назвою запису для контексту. */
  title?: string;
  /** Підпис правого боку (за замовч. "UA"). */
  labelModified?: string;
  /** Підпис лівого боку (за замовч. "EN"). */
  labelOriginal?: string;
  onClose: () => void;
}

export function DiffModal({
  open, original, modified, title, labelModified = "UA", labelOriginal = "EN", onClose,
}: Props) {
  const t = useT();
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="dp-card w-[min(1400px,96vw)] h-[min(820px,92vh)] flex flex-col"
        style={{ background: "var(--bg-surface)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-[var(--border-soft)] flex items-center gap-3">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            {t("components.diffModal.title")}
          </span>
          {title && (
            <span className="text-[11px] font-mono text-[var(--text-faint)] truncate">{title}</span>
          )}
          <div className="flex-1" />
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
            <span className="text-[var(--text-muted)]">{labelOriginal}</span>
            <span className="mx-2">↔</span>
            <span className="text-[var(--accent)]">{labelModified}</span>
          </span>
          <button
            className="dp-btn dp-btn--ghost"
            onClick={onClose}
            title={t("components.diffModal.close")}
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <DiffEditor
            height="100%"
            original={original}
            modified={modified}
            language="plaintext"
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 20,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Code", "Consolas", monospace',
              renderWhitespace: "boundary",
              diffWordWrap: "on",
            }}
          />
        </div>
      </div>
    </div>
  );
}
