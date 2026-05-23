// Generic dropdown для хедерних меню (Tools, File...). Відкривається клік'ом
// на тригерну кнопку, закривається при кліку поза / Esc / вибору пункту.
// Поведінка свідомо проста, без портів/floating-ui — нам треба лиш позиція
// нижче тригера, ширина від контенту, fade-in.

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  /** Якщо undefined — це divider (горизонтальна лінія). */
  label?: string;
  icon?: string;
  shortcut?: string;
  /** disabled state. */
  disabled?: boolean;
  /** Колір акценту: default | danger | warning | success. */
  tone?: "default" | "danger" | "warning" | "success";
  onClick?: () => void;
  title?: string;
}

interface Props {
  trigger: ReactNode;
  items: MenuItem[];
  /** Випадання — "left" або "right" (праве вирівнювання за right edge тригера). */
  align?: "left" | "right";
  /** Опціонально: фіксована мін. ширина dropdown'у. */
  minWidth?: number;
}

const TONE_CLASS: Record<NonNullable<MenuItem["tone"]>, string> = {
  default: "text-[var(--text)]",
  danger: "text-[var(--danger)]",
  warning: "text-[var(--warning,#d97706)]",
  success: "text-[var(--success)]",
};

export function HeaderMenu({ trigger, items, align = "left", minWidth = 220 }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        className={`dp-btn dp-btn--ghost ${open ? "bg-[var(--row-hover)]" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
        <svg className="ml-1 w-3 h-3 inline opacity-70" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute top-full mt-1 z-50 dp-card py-1 shadow-xl"
          style={{
            [align]: 0,
            minWidth,
          } as React.CSSProperties}
        >
          {items.map((it, i) => {
            if (it.label === undefined) {
              return <div key={i} className="my-1 border-t border-[var(--border-soft)]" />;
            }
            return (
              <button
                key={i}
                type="button"
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  setOpen(false);
                  it.onClick?.();
                }}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-[12px] ${TONE_CLASS[it.tone ?? "default"]} ${
                  it.disabled
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:bg-[var(--row-hover)] cursor-pointer"
                }`}
              >
                {it.icon !== undefined && <span className="w-4 text-center shrink-0" aria-hidden>{it.icon}</span>}
                <span className="flex-1 truncate">{it.label}</span>
                {it.shortcut && (
                  <span className="text-[10px] text-[var(--text-faint)] font-mono shrink-0">{it.shortcut}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
