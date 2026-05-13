import { useT } from "../lib/i18n";

export type WrapMode = "clip" | "default" | "wrap";

interface WrapToggleProps {
  value: WrapMode;
  onChange: (v: WrapMode) => void;
}

/**
 * Три піктограми як у Google Sheets:
 * — Clip (обрізка до краю)
 * — Default (стандартні 2 рядки)
 * — Wrap (повне обгортання)
 *
 * Це ЛИШЕ візуально — текст у файлі не змінюється.
 */
export function WrapToggle({ value, onChange }: WrapToggleProps) {
  const t = useT();
  const items: { v: WrapMode; title: string; icon: JSX.Element }[] = [
    {
      v: "clip",
      title: t("wrap.clip"),
      // Прямокутник з трьома короткими горизонтальними насічками — текст у 1 рядок.
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="6" width="18" height="12" rx="1.5" />
          <path d="M6 12h6" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      v: "default",
      title: t("wrap.default"),
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="6" width="18" height="12" rx="1.5" />
          <path d="M6 10h12M6 14h8" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      v: "wrap",
      title: t("wrap.wrap"),
      // Стрілка-загин — як у Google: показує перенесення на новий рядок.
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path d="M4 6h16M4 12h12a3 3 0 010 6h-3m0 0l2-2m-2 2l2 2M4 18h6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className="inline-flex rounded-md border border-[var(--border-soft)] overflow-hidden" title={t("wrap.label")}>
      {items.map((it) => (
        <button
          key={it.v}
          onClick={() => onChange(it.v)}
          title={it.title}
          className={`px-2 py-1 transition-colors ${
            value === it.v
              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
              : "text-[var(--text-muted)] hover:bg-[var(--row-hover)]"
          }`}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
}
