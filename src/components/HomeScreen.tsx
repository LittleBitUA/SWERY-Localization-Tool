import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { LangToggle } from "./LangToggle";

interface HomeScreenProps {
  onPickGame: (id: "dp1" | "dp2") => void;
  onOpenSetup: () => void;
  recentFolders: string[];
  onOpenFolder: (path: string) => void;
}

interface GameDef {
  id: "dp1" | "dp2";
  titleKey: string;
  subtitleKey: string;
  blurbKey: string;
  disabled: boolean;
}

const GAMES: GameDef[] = [
  {
    id: "dp1",
    titleKey: "home.dp1.title",
    subtitleKey: "home.dp1.subtitle",
    blurbKey: "home.dp1.blurb",
    disabled: false,
  },
  {
    id: "dp2",
    titleKey: "home.dp2.title",
    subtitleKey: "home.dp2.subtitle",
    blurbKey: "home.dp2.blurb",
    disabled: false,
  },
];

export function HomeScreen({ onPickGame, onOpenSetup, recentFolders, onOpenFolder }: HomeScreenProps) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 10);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] overflow-y-auto">
      {/* Floating top-right language toggle */}
      <div className="absolute top-3 right-4 z-10">
        <LangToggle />
      </div>

      <div
        className={`flex-1 flex flex-col items-center justify-center px-6 py-10 transition-opacity duration-300 ${mounted ? "opacity-100" : "opacity-0"}`}
      >
        <div className="max-w-[920px] w-full">
          <header className="text-center mb-10">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-faint)] mb-3">
              {t("home.tagline")}
            </p>
            <h1 className="text-[28px] font-bold text-[var(--text-strong)] mb-2 tracking-tight">
              {t("home.title")}
            </h1>
            <p className="text-[14px] text-[var(--text-muted)] max-w-[600px] mx-auto leading-relaxed">
              {t("home.subtitle")}
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            {GAMES.map((g) => {
              const isActive = !g.disabled;
              return (
                <button
                  key={g.id}
                  type="button"
                  disabled={g.disabled}
                  onClick={() => isActive && onPickGame(g.id)}
                  className={`group relative text-left rounded-xl border transition-all p-5 ${
                    g.disabled
                      ? "border-[var(--border-soft)] bg-[var(--bg-surface)]/40 cursor-not-allowed"
                      : "border-[var(--border)] bg-[var(--bg-surface)] hover:border-[var(--accent)] hover:bg-[var(--bg-elevated)] cursor-pointer"
                  }`}
                >
                  <span className={`absolute top-3 right-3 dp-pill ${g.disabled ? "dp-pill--warn" : "dp-pill--success"}`}>
                    {g.disabled ? t("home.badge.soon") : t("home.badge.ready")}
                  </span>
                  <div
                    className={`w-12 h-12 rounded-lg flex items-center justify-center mb-3 ${
                      g.disabled
                        ? "bg-[var(--bg-elevated)] text-[var(--text-faint)]"
                        : "bg-[var(--accent-soft)] text-[var(--accent)]"
                    }`}
                  >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h2 className={`text-[18px] font-bold leading-tight mb-1 ${g.disabled ? "text-[var(--text-faint)]" : "text-[var(--text-strong)]"}`}>
                    {t(g.titleKey)}
                  </h2>
                  <p className={`text-[12px] mb-3 ${g.disabled ? "text-[var(--text-faint)]" : "text-[var(--text-muted)]"}`}>
                    {t(g.subtitleKey)}
                  </p>
                  <p className={`text-[12.5px] leading-relaxed ${g.disabled ? "text-[var(--text-faint)]" : "text-[var(--text-muted)]"}`}>
                    {t(g.blurbKey)}
                  </p>
                  {isActive && (
                    <div className="mt-4 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--accent)] uppercase tracking-wider">
                      {t("home.open")}
                      <svg className="w-3 h-3 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {recentFolders.length > 0 && (
            <section className="mb-6">
              <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)] mb-2">
                {t("home.recent")}
              </h3>
              <div className="space-y-1">
                {recentFolders.slice(0, 5).map((p) => {
                  const short = p.split(/[\\/]/).slice(-2).join("/");
                  return (
                    <button
                      key={p}
                      onClick={() => onOpenFolder(p)}
                      className="w-full text-left px-3 py-1.5 rounded border border-[var(--border-soft)] bg-[var(--bg-surface)] hover:border-[var(--accent)] transition-colors flex items-center gap-2"
                      title={p}
                    >
                      <svg className="w-3.5 h-3.5 shrink-0 text-[var(--text-faint)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      <span className="font-mono text-[12px] text-[var(--text-muted)] truncate">{short}</span>
                      <span className="ml-auto text-[10px] text-[var(--text-faint)] truncate">{p}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <footer className="flex items-center justify-between pt-4 border-t border-[var(--border-soft)]">
            <p className="text-[11px] text-[var(--text-faint)]">
              {t("home.setup.prompt")}{" "}
              <button onClick={onOpenSetup} className="text-[var(--accent)] hover:underline">
                {t("home.setup.button")}
              </button>
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
