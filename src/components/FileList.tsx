import { useEffect, useRef, useState } from "react";
import { useStore, type TreeNode } from "../lib/store";
import { useT } from "../lib/i18n";
import { alert as showAlert, confirm as showConfirm } from "../lib/dialogs";

interface CtxMenuState { x: number; y: number; node: TreeNode }

function FileNode({
  node,
  depth,
  onContext,
}: {
  node: TreeNode;
  depth: number;
  onContext: (e: React.MouseEvent, node: TreeNode) => void;
}) {
  const selectedFilePath = useStore((s) => s.selectedFilePath);
  const loadFile = useStore((s) => s.loadFile);
  // File-level marks (з ПКМ-меню): edited → помаранчевий, allTranslated → зелений.
  const fileMeta = useStore((s) => s.statuses.files?.[node.path]);

  const isActive = node.path === selectedFilePath;
  const total = node.totalEntries ?? 0;
  const translated = node.translatedCount ?? 0;
  const pct = total > 0 ? Math.round((translated / total) * 100) : 0;
  const isComplete = total > 0 && translated >= total;
  const isMarkedAll = !!fileMeta?.allTranslated;
  const isEdited = !!fileMeta?.edited;
  const padLeft = 8 + depth * 14;

  // Кольорова класифікація: edited (помаранчевий) > complete/allTranslated
  // (зелений) > default. Active state лише ПІДСВІЧУЄ текст (text-strong) і
  // фон (row-active) — НЕ перекриває колір іконки/бару, інакше повний файл
  // після кліку «втрачає» зелений.
  type ColorTone = "edited" | "done" | "default";
  const colorTone: ColorTone = isEdited
    ? "edited"
    : (isComplete || isMarkedAll)
    ? "done"
    : "default";
  const TEXT: Record<ColorTone, string> = {
    edited: "text-[var(--warning,#d97706)] hover:text-[var(--warning,#d97706)]",
    done: "text-[var(--success)] hover:text-[var(--success)]",
    default: "text-[var(--text-muted)] hover:text-[var(--text)]",
  };
  const ICON: Record<ColorTone, string> = {
    edited: "text-[var(--warning,#d97706)]",
    done: "text-[var(--success)]",
    default: "text-[var(--text-faint)]",
  };
  const BAR: Record<ColorTone, string> = {
    edited: "bg-[var(--warning,#d97706)]",
    done: "bg-[var(--success)]",
    default: "bg-[var(--accent)]",
  };
  const COUNTER: Record<ColorTone, string> = {
    edited: "text-[var(--warning,#d97706)] font-semibold",
    done: "text-[var(--success)] font-semibold",
    default: "text-[var(--text-faint)]",
  };
  // Active перекриває текст на strong; колір іконки/бару зберігається.
  const textClass = isActive ? "text-[var(--text-strong)]" : TEXT[colorTone];

  return (
    <button
      onClick={() => loadFile(node.path)}
      onContextMenu={(e) => onContext(e, node)}
      className={`group w-full text-left py-1 transition-colors ${
        isActive ? "bg-[var(--row-active)]" : "hover:bg-[var(--row-hover)]"
      } ${textClass}`}
      style={{ paddingLeft: padLeft, paddingRight: 8 }}
    >
      <div className="flex items-center gap-1.5">
        <svg
          className={`w-3.5 h-3.5 shrink-0 ${ICON[colorTone]}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          {colorTone === "edited" ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          ) : colorTone === "done" ? (
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          )}
        </svg>
        <span className="font-mono text-[11.5px] truncate flex-1" title={node.name}>
          {node.name}
        </span>
        {total > 0 && (
          <span className={`text-[10px] tabular-nums shrink-0 ${COUNTER[colorTone]}`}>
            {translated}/{total}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className="mt-1 h-[2px] rounded-full bg-[var(--border-soft)] overflow-hidden" style={{ marginLeft: 18 }}>
          <div
            className={`h-full transition-all ${BAR[colorTone]}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </button>
  );
}

function FolderNode({
  node,
  depth,
  defaultExpanded,
  onContext,
}: {
  node: TreeNode;
  depth: number;
  defaultExpanded: boolean;
  onContext: (e: React.MouseEvent, node: TreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const padLeft = 6 + depth * 14;

  return (
    <>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="group w-full text-left py-1 hover:bg-[var(--row-hover)] text-[var(--text-muted)] transition-colors"
        style={{ paddingLeft: padLeft, paddingRight: 8 }}
      >
        <div className="flex items-center gap-1">
          <svg
            className={`w-3 h-3 shrink-0 text-[var(--text-faint)] transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <path d="M5 4l5 4-5 4V4z" />
          </svg>
          <svg
            className="w-3.5 h-3.5 shrink-0 text-[var(--accent)]"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
          </svg>
          <span className="font-mono text-[11.5px] truncate flex-1 text-[var(--text)]" title={node.name}>
            {node.name}
          </span>
          {node.children && (
            <span className="text-[10px] tabular-nums text-[var(--text-faint)]">
              {node.children.length}
            </span>
          )}
        </div>
      </button>
      {expanded && node.children?.map((child) => (
        <TreeItem key={child.path} node={child} depth={depth + 1} onContext={onContext} />
      ))}
    </>
  );
}

function TreeItem({
  node, depth, onContext,
}: {
  node: TreeNode;
  depth: number;
  onContext: (e: React.MouseEvent, node: TreeNode) => void;
}) {
  if (node.type === "folder") {
    return <FolderNode node={node} depth={depth} defaultExpanded={true} onContext={onContext} />;
  }
  return <FileNode node={node} depth={depth} onContext={onContext} />;
}

export function FileList() {
  const t = useT();
  const tree = useStore((s) => s.tree);
  const folder = useStore((s) => s.folder);
  const pickFolder = useStore((s) => s.pickFolder);
  const loading = useStore((s) => s.loading);
  const restoreOriginal = useStore((s) => s.restoreOriginal);
  const bulkMarkFileTranslated = useStore((s) => s.bulkMarkFileTranslated);
  const setFileEdited = useStore((s) => s.setFileEdited);
  const filesMeta = useStore((s) => s.statuses.files);

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  // Закриття контекстного меню при кліку поза ним / Esc.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  function handleContext(e: React.MouseEvent, node: TreeNode) {
    e.preventDefault();
    if (node.type !== "file") return;
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  }

  async function handleRestore(node: TreeNode) {
    setCtxMenu(null);
    const confirmed = await showConfirm(
      t("files.confirmRestoreTitle"),
      t("files.confirmRestore", { name: node.name }),
      { tone: "danger", okLabel: t("files.restoreOriginal") }
    );
    if (!confirmed) return;
    const ok = await restoreOriginal(node.path);
    if (!ok) {
      await showAlert(t("dialog.error"), t("files.noBackup"));
    }
  }

  if (!folder) {
    const prompt = t("files.pickPrompt", { btn: t("header.folder") });
    // Split навколо {btn} щоб обернути назву кнопки в .dp-kbd.
    const parts = prompt.split(t("header.folder"));
    return (
      <aside className="h-full shrink-0 border-r border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center justify-center p-6 text-center">
        <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
          {parts[0]}
          <span className="dp-kbd">{t("header.folder")}</span>
          {parts.slice(1).join(t("header.folder"))}
        </p>
      </aside>
    );
  }

  return (
    <aside className="h-full shrink-0 border-r border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-col">
      <div className="px-3 h-9 flex items-center justify-between border-b border-[var(--border-soft)]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {t("files.title")}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {loading && !tree ? (
          <p className="px-3 py-2 text-[12px] text-[var(--text-faint)]">{t("files.loading")}</p>
        ) : !tree || !tree.children || tree.children.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-[var(--text-faint)]">{t("files.empty")}</p>
        ) : (
          // Рендеримо дітей кореня, щоб коренева "TEXT" не показувалась окремим рядком —
          // одразу видно її піддиректорії.
          tree.children.map((child) => (
            <TreeItem key={child.path} node={child} depth={0} onContext={handleContext} />
          ))
        )}
      </div>

      {ctxMenu && (() => {
        const meta = filesMeta?.[ctxMenu.node.path];
        const allTranslated = !!meta?.allTranslated;
        const edited = !!meta?.edited;
        const close = () => setCtxMenu(null);
        return (
          <div
            className="fixed z-50 dp-card py-1 text-[12px] min-w-[260px] shadow-xl"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 280),
              top: Math.min(ctxMenu.y, window.innerHeight - 240),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1 text-[10.5px] text-[var(--text-faint)] font-mono truncate" title={ctxMenu.node.name}>
              {ctxMenu.node.name}
            </div>
            <div className="border-t border-[var(--border-soft)] my-1" />
            <button
              onClick={async () => {
                close();
                await bulkMarkFileTranslated(ctxMenu.node.path, !allTranslated);
              }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-[var(--row-hover)] ${allTranslated ? "text-[var(--success)] font-semibold" : ""}`}
            >
              {allTranslated ? "✓ Зняти позначку «Перекладено»" : "✓ Позначити «Перекладено»"}
            </button>
            <button
              onClick={async () => {
                close();
                await setFileEdited(ctxMenu.node.path, !edited);
              }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-[var(--row-hover)] ${edited ? "text-[var(--warning,#d97706)] font-semibold" : ""}`}
            >
              {edited ? "✎ Зняти позначку «Зредаговано»" : "✎ Позначити «Зредаговано»"}
            </button>
            <div className="border-t border-[var(--border-soft)] my-1" />
            <button
              onClick={() => handleRestore(ctxMenu.node)}
              className="block w-full text-left px-3 py-1.5 hover:bg-[var(--row-hover)]"
            >
              {t("files.restoreOriginal")}
            </button>
          </div>
        );
      })()}
    </aside>
  );
}
