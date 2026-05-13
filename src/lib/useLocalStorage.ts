import { useEffect, useRef, useState } from "react";

const CHANNEL = "dp.localStorageBus";

interface BusDetail<T> { key: string; value: T }

function emit<T>(key: string, value: T) {
  window.dispatchEvent(new CustomEvent<BusDetail<T>>(CHANNEL, { detail: { key, value } }));
}

/**
 * Мінімалістичний хук: тримає стан у React + дзеркалить у localStorage.
 * Реактивний між компонентами — якщо один компонент set'нув, інший з тим же
 * key одразу отримує оновлення через custom event на window.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });
  const valRef = useRef(val);
  valRef.current = val;

  // Запис у LS + повідомлення інших компонентів через bus.
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
    emit(key, val);
  }, [key, val]);

  // Підписка на зміни цього ж ключа з інших компонентів.
  useEffect(() => {
    const onBus = (e: Event) => {
      const ce = e as CustomEvent<BusDetail<T>>;
      if (!ce.detail || ce.detail.key !== key) return;
      // Уникаємо петлі, якщо це наша власна зміна.
      try {
        if (JSON.stringify(ce.detail.value) === JSON.stringify(valRef.current)) return;
      } catch {}
      setVal(ce.detail.value);
    };
    window.addEventListener(CHANNEL, onBus as EventListener);
    return () => window.removeEventListener(CHANNEL, onBus as EventListener);
  }, [key]);

  return [val, setVal];
}
