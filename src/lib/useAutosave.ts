import { useEffect, useRef } from "react";

/**
 * Debounce-таймер: після кожної зміни `dirty=true` через `delayMs` (за замовч. 30с)
 * викликає `autosave`. Якщо за цей час прилетіла нова зміна — таймер reset.
 * Коли `dirty=false` (юзер натиснув Save) — таймер вимикається.
 *
 * Викликати в редакторах: useAutosave(dirty, store.autosave).
 */
export function useAutosave(dirty: boolean, autosave: () => Promise<void> | void, delayMs = 30_000) {
  const cbRef = useRef(autosave);
  cbRef.current = autosave;

  useEffect(() => {
    if (!dirty) return;
    const id = setTimeout(() => { cbRef.current(); }, delayMs);
    return () => clearTimeout(id);
  }, [dirty, delayMs]);
}
