import { getLang, setLang, useT } from "../lib/i18n";

export function LangToggle({ compact = false }: { compact?: boolean }) {
  useT(); // підписатись на зміну мови, щоб самим перерендеритись
  const cur = getLang();
  function flip() {
    setLang(cur === "uk" ? "en" : "uk");
  }
  if (compact) {
    return (
      <button
        className="dp-btn dp-btn--ghost"
        onClick={flip}
        title={cur === "uk" ? "Switch to English" : "Перемкнути на українську"}
      >
        <span className="font-mono text-[11px] font-semibold uppercase">{cur}</span>
      </button>
    );
  }
  return (
    <div className="inline-flex rounded-md border border-[var(--border-soft)] overflow-hidden">
      <button
        className={`px-2.5 py-1 text-[11px] font-semibold uppercase ${
          cur === "uk" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--row-hover)]"
        }`}
        onClick={() => setLang("uk")}
      >
        UK
      </button>
      <button
        className={`px-2.5 py-1 text-[11px] font-semibold uppercase ${
          cur === "en" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--row-hover)]"
        }`}
        onClick={() => setLang("en")}
      >
        EN
      </button>
    </div>
  );
}
