// Lightbox-перегляд atlas PNG. Click thumbnail на картці шрифту → відкриває
// модалку з повним розміром (texture2ddecoder dump, 512×512 або 1024×1024).

import { useEffect } from "react";
import { useT } from "../../lib/i18n";

interface Props {
  open: boolean;
  src: string;
  name: string;
  format?: string;
  onClose: () => void;
}

export function D4FontPreviewModal({ open, src, name, format, onClose }: Props) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(8,0,0,0.85)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="rounded-sm flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "linear-gradient(180deg, #1a0508 0%, #0d0204 100%)",
          border: "1px solid rgba(220,38,38,0.5)",
          color: "#f5e6e6",
          maxWidth: "92vw",
          maxHeight: "92vh",
        }}
      >
        <header
          className="px-4 py-2.5 flex items-center justify-between shrink-0"
          style={{ borderBottom: "1px solid rgba(220,38,38,0.3)" }}
        >
          <div>
            <div className="text-[10px] font-bold tracking-[0.3em]" style={{ color: "#dc2626" }}>◆ {t("d4.fonts.preview.title")} ◆</div>
            <h2 className="font-mono text-[14px] font-semibold" style={{ color: "#fff" }}>{name}</h2>
          </div>
          <div className="flex items-center gap-2">
            {format && (
              <span
                className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-sm"
                style={{
                  background: format === "BC3" ? "rgba(220,38,38,0.6)" : "rgba(251,191,36,0.5)",
                  color: "#fff",
                }}
              >
                {format}
              </span>
            )}
            <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-sm" style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div
          className="p-4 overflow-auto flex items-center justify-center"
          style={{
            background: "repeating-conic-gradient(rgba(245,230,230,0.06) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px",
            minHeight: 240,
          }}
        >
          <img
            src={src}
            alt={name}
            style={{
              maxWidth: "100%",
              maxHeight: "75vh",
              display: "block",
              imageRendering: "pixelated",
              filter: "invert(1) hue-rotate(180deg)",
              opacity: 0.95,
            }}
          />
        </div>

        <footer className="px-4 py-2 text-[10px] font-mono shrink-0" style={{
          borderTop: "1px solid rgba(220,38,38,0.2)",
          color: "rgba(245,230,230,0.45)",
        }}>
          {t("d4.fonts.preview.hint")}
        </footer>
      </div>
    </div>
  );
}
