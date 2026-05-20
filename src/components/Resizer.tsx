import { useEffect, useRef } from "react";

interface ResizerProps {
  /** Поточна ширина "лівої" панелі. */
  value: number;
  /** Callback при drag. */
  onChange: (next: number) => void;
  /** Якщо true — value є ширина ПРАВОЇ панелі (інвертуємо delta). */
  invert?: boolean;
  min?: number;
  max?: number;
}

export function Resizer({ value, onChange, invert = false, min = 160, max = 1200 }: ResizerProps) {
  const startX = useRef(0);
  const startVal = useRef(0);
  const dragging = useRef(false);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    startX.current = e.clientX;
    startVal.current = value;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const delta = e.clientX - startX.current;
    const next = invert ? startVal.current - delta : startVal.current + delta;
    onChange(Math.max(min, Math.min(max, next)));
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  // Подвійний клік — скинути до дефолту (callback приймає -1 як сигнал? Простіше: викликаємо onChange(min))
  // Не реалізуємо тут, тримаємо мінімалізм.

  // Cleanup на випадок unmount під час drag
  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  return (
    <div
      role="separator"
      // Wide hit-target (8px) — користувач не промахується. Visible separator
      // лишається тонкий (2px) у центрі, стає accent на hover/drag для
      // зворотного зв'язку.
      className="shrink-0 w-2 cursor-col-resize group flex items-center justify-center"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="h-full w-[2px] bg-[var(--border-soft)] group-hover:bg-[var(--accent)] group-active:bg-[var(--accent)] transition-colors" />
    </div>
  );
}
