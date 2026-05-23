// Простий windowing для таблиці рядків MISSING. Без react-window — лиш
// scrollTop listener + buffer-aware рендер. Працює коли всі рядки мають
// приблизно однакову висоту (multiline допустимо — лімітуємо max-height
// клітинок до 3 рядків, overflow ellipsis).
//
// Інтерфейс: <VirtualRows items={...} renderRow={...} rowHeight={56} />
// rowHeight — приблизний фіксований розмір рядка у px. Можна underestimate'ити
// трохи (наприклад 52), тоді з'являється trailing-buffer.

import { useCallback, useEffect, useRef, useState } from "react";

interface Props<T> {
  items: T[];
  /** Опційно: render callback для одного елемента списку. */
  renderRow: (item: T, idx: number) => React.ReactNode;
  /** Висота одного рядка у px. Default 56. */
  rowHeight?: number;
  /** Кількість додаткових рядків зверху/знизу від viewport. Default 8. */
  overscan?: number;
  /** Якщо передано — індекс рядка, до якого треба скролитися при зміні. */
  scrollToIndex?: number | null;
  /** Опційно: callback при зміні видимого вікна. */
  onRangeChange?: (range: { start: number; end: number }) => void;
  /** Опційно: thead, який має лишатися sticky зверху. */
  header?: React.ReactNode;
  /** Опційно: className для root. */
  className?: string;
}

export function VirtualRows<T>({
  items,
  renderRow,
  rowHeight = 56,
  overscan = 8,
  scrollToIndex = null,
  onRangeChange,
  header,
  className,
}: Props<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });

  // Resize observer + scroll listener.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      setViewport((v) => ({ ...v, top: el.scrollTop }));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport({ top: el.scrollTop, height: el.clientHeight });
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // ScrollIntoView: коли активний рядок змінюється (наприклад через
  // глобальний пошук), стрибаємо до нього. Тільки якщо він поза viewport.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollToIndex == null) return;
    const target = scrollToIndex * rowHeight;
    const bottom = target + rowHeight;
    if (target < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, target - el.clientHeight / 3), behavior: "smooth" });
    }
  }, [scrollToIndex, rowHeight]);

  const totalHeight = items.length * rowHeight;
  const first = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewport.height / rowHeight) + overscan * 2;
  const last = Math.min(items.length, first + visibleCount);

  // Повідомляємо назовні видиме вікно (для preloading тощо).
  const lastRangeRef = useRef<{ start: number; end: number }>({ start: -1, end: -1 });
  useEffect(() => {
    if (!onRangeChange) return;
    if (lastRangeRef.current.start === first && lastRangeRef.current.end === last) return;
    lastRangeRef.current = { start: first, end: last };
    onRangeChange({ start: first, end: last });
  }, [first, last, onRangeChange]);

  const offsetTop = first * rowHeight;
  const slice = items.slice(first, last);

  const handleWheel = useCallback(() => { /* no-op, just to make React happy with passive */ }, []);

  return (
    <div
      ref={scrollRef}
      className={`flex-1 overflow-auto ${className ?? ""}`}
      onWheel={handleWheel}
    >
      {header}
      <div style={{ height: totalHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: offsetTop, left: 0, right: 0 }}>
          {slice.map((item, i) => renderRow(item, first + i))}
        </div>
      </div>
    </div>
  );
}
