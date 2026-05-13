import { useEffect, useRef } from "react";

interface ColResizerProps {
  width: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
}

/**
 * Маленький resize-handle для таблиць — кладеться у `<th>` як абсолютний
 * елемент на правому краю. `<th>` має мати position:relative.
 */
export function ColResizer({ width, onChange, min = 40, max = 1600 }: ColResizerProps) {
  const startX = useRef(0);
  const startW = useRef(0);
  const dragging = useRef(false);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // НЕ запускаємо сортування/клік по th
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const delta = e.clientX - startX.current;
    const next = Math.max(min, Math.min(max, startW.current + delta));
    onChange(next);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="absolute top-0 right-0 h-full w-[5px] cursor-col-resize hover:bg-[var(--accent)]/50 active:bg-[var(--accent)] transition-colors z-20"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Не даємо клікам "провалитись" у th і викликати select row.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}
