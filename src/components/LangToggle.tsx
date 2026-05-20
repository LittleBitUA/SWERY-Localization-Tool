import { getLang, setLang, useT } from "../lib/i18n";

export function LangToggle({ compact = false }: { compact?: boolean }) {
  const t = useT(); // підписатись на зміну мови, щоб самим перерендеритись
  const cur = getLang();
  function flip() {
    setLang(cur === "uk" ? "en" : "uk");
  }
  if (compact) {
    return (
      <button
        className="dp-btn dp-btn--ghost"
        onClick={flip}
        title={t(cur === "uk" ? "lang.switchToEn" : "lang.switchToUk")}
      >
        <span className="font-mono text-[11px] font-semibold uppercase">{cur}</span>
      </button>
    );
  }
  // Pill-style segmented control: фон у контейнера, кнопки самі заокруглені.
  // Раніше було `border + overflow-hidden` на flex-контейнері, але при
  // субпіксельному DPI-масштабуванні Windows Chromium лишав тонкі шви/щілини
  // між активною і неактивною кнопкою. Тут border'у на стику немає взагалі.
  return (
    <div className="inline-flex rounded-md bg-[var(--bg-elevated)] p-0.5 gap-0.5 ring-1 ring-[var(--border-soft)]">
      <button
        className={`px-2.5 py-1 text-[11px] font-semibold uppercase rounded transition-colors ${
          cur === "uk" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]"
        }`}
        onClick={() => setLang("uk")}
      >
        UK
      </button>
      <button
        className={`px-2.5 py-1 text-[11px] font-semibold uppercase rounded transition-colors ${
          cur === "en" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]"
        }`}
        onClick={() => setLang("en")}
      >
        EN
      </button>
    </div>
  );
}
