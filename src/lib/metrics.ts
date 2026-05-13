// Сесійні метрики: підрахунок рядків/слів, перекладених за цей запуск
// додатка, плюс щоденна історія (зберігається в localStorage).

import { useEffect, useState } from "react";

const SESSION_KEY = "dp.metrics.session.v1";
const DAILY_KEY = "dp.metrics.daily.v1";

export interface SessionMetrics {
  startedAt: number;
  rows: number;
  words: number;
}

export interface DailyEntry { rows: number; words: number; }
export type Daily = Record<string, DailyEntry>; // "YYYY-MM-DD" → {rows, words}

const listeners = new Set<() => void>();

function loadSession(): SessionMetrics {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.startedAt === "number") return { startedAt: p.startedAt, rows: p.rows | 0, words: p.words | 0 };
    }
  } catch {}
  const fresh: SessionMetrics = { startedAt: Date.now(), rows: 0, words: 0 };
  saveSession(fresh);
  return fresh;
}

function saveSession(s: SessionMetrics) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}

function loadDaily(): Daily {
  try {
    const raw = localStorage.getItem(DAILY_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p as Daily;
    }
  } catch {}
  return {};
}

function saveDaily(d: Daily) {
  try { localStorage.setItem(DAILY_KEY, JSON.stringify(d)); } catch {}
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function countWords(s: string): number {
  if (!s) return 0;
  // Залишаємо літери і цифри як токени.
  const m = s.match(/[\p{L}\p{N}]+/gu);
  return m ? m.length : 0;
}

let sessionCache: SessionMetrics = loadSession();
let dailyCache: Daily = loadDaily();

/** Викликати при підтвердженні нового перекладу: збільшує лічильники. */
export function recordTranslation(uaText: string, prevText: string = "") {
  // Рахуємо як "1 рядок", додаємо різницю слів (нові - старі), мін 0.
  const w = Math.max(0, countWords(uaText) - countWords(prevText));
  sessionCache = {
    ...sessionCache,
    rows: sessionCache.rows + 1,
    words: sessionCache.words + w,
  };
  saveSession(sessionCache);

  const day = todayKey();
  const cur = dailyCache[day] ?? { rows: 0, words: 0 };
  dailyCache = {
    ...dailyCache,
    [day]: { rows: cur.rows + 1, words: cur.words + w },
  };
  saveDaily(dailyCache);

  for (const fn of listeners) fn();
}

/** Скинути сесійні метрики (новий запуск). */
export function resetSession() {
  sessionCache = { startedAt: Date.now(), rows: 0, words: 0 };
  saveSession(sessionCache);
  for (const fn of listeners) fn();
}

export function getSession(): SessionMetrics {
  return sessionCache;
}

export function getToday(): DailyEntry {
  return dailyCache[todayKey()] ?? { rows: 0, words: 0 };
}

export function useMetrics() {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((x) => x + 1);
    listeners.add(cb);
    // Періодичний тик для оновлення тривалості сесії.
    const id = window.setInterval(cb, 30000);
    return () => {
      listeners.delete(cb);
      window.clearInterval(id);
    };
  }, []);
  return { session: getSession(), today: getToday() };
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
