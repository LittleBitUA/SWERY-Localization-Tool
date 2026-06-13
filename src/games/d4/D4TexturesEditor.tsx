// D4 — редактор текстур (Texture2D у .upk). Каркас з hero-фоном.

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { D4Hero } from "./D4Hero";

interface Props { onHome: () => void; }

export function D4TexturesEditor({ onHome }: Props) {
  const t = useT();
  const [d4Root, setD4Root] = useState<string>("");

  useEffect(() => {
    window.dp2.getSettings().then((s) => {
      const ss = s as { d4Root?: string };
      setD4Root(ss.d4Root ?? "");
    });
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden" style={{ background: "#0d0204" }}>
      <D4Hero />

      <header
        className="h-12 px-4 flex items-center gap-3 shrink-0 relative"
        style={{
          background: "rgba(13, 2, 4, 0.75)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(220, 38, 38, 0.25)",
          zIndex: 2,
        }}
      >
        <button
          onClick={onHome}
          className="px-2 py-1 text-[11px] flex items-center gap-1 rounded-sm transition-colors"
          style={{
            background: "rgba(220, 38, 38, 0.15)",
            border: "1px solid rgba(220, 38, 38, 0.3)",
            color: "#f5e6e6",
          }}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          {t("btn.home")}
        </button>
        <span className="text-[10px] tracking-[0.3em] uppercase font-semibold" style={{ color: "#dc2626" }}>
          {t("d4.case")}
        </span>
        <span className="text-[13px]" style={{ color: "rgba(245,230,230,0.75)" }}>
          {t("d4.text.title", { brand: t("d4.brand"), mode: t("d4.mode.textures") })}
        </span>
        <div className="flex-1" />
        {d4Root && (
          <span className="text-[10.5px] font-mono" style={{ color: "rgba(245,230,230,0.55)" }}>
            {d4Root.split(/[\\/]/).slice(-2).join("/")}
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto relative" style={{ zIndex: 1 }}>
        <div className="max-w-[900px] mx-auto px-8 py-10 space-y-6">
          <section className="text-center">
            <div className="text-[10px] font-bold tracking-[0.4em] mb-3" style={{ color: "#dc2626" }}>
              {t("d4.tex.brandFull")}
            </div>
            <h1 className="text-[28px] font-light tracking-wider mb-2" style={{ color: "#fff", textShadow: "0 0 25px rgba(220,38,38,0.4)" }}>
              {t("d4.tex.title")}
            </h1>
          </section>

          <section
            className="rounded-sm p-6"
            style={{
              background: "rgba(13, 2, 4, 0.6)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(220, 38, 38, 0.2)",
            }}
          >
            <h2 className="text-[11px] font-semibold tracking-[0.3em] uppercase mb-3" style={{ color: "#dc2626" }}>
              {t("d4.tex.pipeline.title")}
            </h2>
            <p className="text-[12px] leading-relaxed" style={{ color: "rgba(245,230,230,0.7)" }}>
              {t("d4.tex.pipeline.body")}
            </p>
          </section>

          <section
            className="rounded-sm p-8 text-center"
            style={{
              background: "rgba(13, 2, 4, 0.5)",
              border: "1px dashed rgba(220, 38, 38, 0.3)",
            }}
          >
            <p className="text-[11.5px]" style={{ color: "rgba(245,230,230,0.55)" }}>
              {t("d4.tex.todo")}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
