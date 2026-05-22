// THE MISSING — Assembly-CSharp.dll string-літерали editor.
//
// Двох-режимна модалка:
//   1. "Quick fix" — кнопка «Виправити обрізання діалогів» (single-click IL
//      patch FixedBallon.SetText + TextExSettings..ctor). Не потребує
//      редагування рядків — це готовий шаблон, який знімає проблему типу
//      «Хочу покататися на тук-ту» (текст обрізається на bubble width).
//   2. "Strings table" — extract усіх ldstr з DLL, переклад у таблиці,
//      apply назад через Mono.Cecil. Sanity-check за `id+original`: якщо
//      DLL змінено між extract і apply, item пропускається.
//
// Зберігається у Documents/SWERY-Localization-Tool/MISSING/DLL/. .dll.bak
// створюється ОДИН РАЗ — наступні apply не перезаписують його.

import { useEffect, useMemo, useState } from "react";
import { confirm as dpConfirm, alert as dpAlert } from "../../lib/dialogs";
import { isInDllWhitelist, getDllUaHint, MISSING_DLL_TEXT_WHITELIST } from "./dll-text-whitelist";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface DllItem {
  id: number;
  type: string;
  method: string;
  offset: string;
  original: string;
  replacement?: string;
}

interface W {
  missingDllStringsExtract: () => Promise<{ ok: boolean; items?: DllItem[]; total?: number; error?: string }>;
  missingDllStringsApply: (p: { edits: Array<{ id: number; original: string; replacement: string }> }) => Promise<{ ok: boolean; summary?: { applied: number; skipped: unknown[] }; error?: string }>;
  missingDllDialogFix: () => Promise<{ ok: boolean; summary?: { applied: number; patches: Array<{ where: string; from: string; to: string }> }; error?: string }>;
  missingDllDialogFixRevert: () => Promise<{ ok: boolean; error?: string }>;
  missingDllDialogFixStatus: () => Promise<{ ok: boolean; summary?: { patched: boolean; ballon: boolean; ballonController: boolean; wordWrap: boolean; bakExists: boolean } }>;
}
const API = window.dp2 as unknown as W;

export function MissingDllEditor({ open, onClose }: Props) {
  const [phase, setPhase] = useState<"idle" | "extracting" | "ready" | "applying">("idle");
  const [items, setItems] = useState<DllItem[]>([]);
  const [edits, setEdits] = useState<Map<number, string>>(new Map());
  const [search, setSearch] = useState("");
  const [onlyEdited, setOnlyEdited] = useState(false);
  // Default ON: показуємо лише позиції з whitelist'у (built-in список 17-ти
  // user-facing ldstr). DLL має 6500+ ldstr, без фільтра таблиця нечитабельна,
  // а cyrillic-фільтр не годиться для оригінальної EN-DLL (там кирилиці нема).
  // Whitelist стабільний по `type+method+offset` — спрацює і на чистій DLL.
  const [onlyWhitelist, setOnlyWhitelist] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [busyFix, setBusyFix] = useState(false);
  const [fixStatus, setFixStatus] = useState<{ patched: boolean; ballon: boolean; ballonController: boolean; wordWrap: boolean; bakExists: boolean } | null>(null);

  async function refreshFixStatus() {
    const r = await API.missingDllDialogFixStatus();
    if (r.ok && r.summary) setFixStatus(r.summary);
  }

  useEffect(() => {
    if (!open) return;
    refreshFixStatus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function extract() {
    setPhase("extracting"); setErrMsg(null);
    const r = await API.missingDllStringsExtract();
    if (!r.ok) { setErrMsg(r.error || "extract failed"); setPhase("idle"); return; }
    setItems(r.items || []);
    setPhase("ready");
  }

  async function apply() {
    if (edits.size === 0) {
      await dpAlert("Нема правок", "Спочатку відредагуйте хоча б один рядок у таблиці.", { tone: "warning" });
      return;
    }
    const ok = await dpConfirm(
      "Записати у Assembly-CSharp.dll?",
      `Будуть змінені ${edits.size} string-літералів у DLL. Перед записом створюється Assembly-CSharp.dll.bak (один раз). Якщо щось піде не так — можна повернутися кнопкою «Відкотити DLL».\n\nГру треба буде ПЕРЕЗАПУСТИТИ, щоб зміни підхопилися.`,
      { okLabel: "Записати", cancelLabel: "Скасувати", tone: "warning" }
    );
    if (!ok) return;
    setPhase("applying"); setErrMsg(null);
    const payload = Array.from(edits.entries()).map(([id, replacement]) => {
      const it = items.find((x) => x.id === id)!;
      return { id, original: it.original, replacement };
    });
    const r = await API.missingDllStringsApply({ edits: payload });
    if (!r.ok) { setErrMsg(r.error || "apply failed"); setPhase("ready"); return; }
    const skipped = r.summary?.skipped?.length ?? 0;
    await dpAlert(
      "DLL оновлено",
      `Записано ${r.summary?.applied ?? 0} рядків. Пропущено: ${skipped}. Перезапусти гру.`,
      { tone: skipped > 0 ? "warning" : "success" }
    );
    setEdits(new Map());
    setPhase("ready");
  }

  async function runQuickFix() {
    const ok = await dpConfirm(
      "Виправити обрізання діалогів?",
      "IL-патчі у Assembly-CSharp.dll:\n\n• Ballon.CheckProperties: SizeControlType примусово UseTextInfo (2) — pухир адаптує ширину під UA-текст (без цього обрізає по character-count).\n• BallonController.CheckProperties: те саме.\n• TextExGenerator.get_WordWrapType: завжди 1 (Default) — wrap йде по пробілах між словами (без цього wrap посеред слова: «потре|бувала», «психологічн|ий»).\n\n.dll.bak створиться (якщо ще нема). Перезапусти TheMISSING.exe.",
      { okLabel: "Виправити", cancelLabel: "Скасувати", tone: "warning" }
    );
    if (!ok) return;
    setBusyFix(true);
    const r = await API.missingDllDialogFix();
    setBusyFix(false);
    if (!r.ok) {
      await dpAlert("Не вдалося застосувати fix", r.error || "?", { tone: "danger" });
      return;
    }
    const n = r.summary?.applied ?? 0;
    await dpAlert(
      "Готово",
      `Застосовано ${n} IL-патчів. Перезапусти гру і перевір сцену з Емілі.`,
      { tone: "success" }
    );
    await refreshFixStatus();
  }

  async function revertFix() {
    const ok = await dpConfirm(
      "Відкотити DLL до оригіналу?",
      "Файл Assembly-CSharp.dll буде відновлено з .dll.bak. Усі правки (і Quick Fix, і Strings) втратяться.",
      { okLabel: "Відкотити", cancelLabel: "Скасувати", tone: "danger" }
    );
    if (!ok) return;
    setBusyFix(true);
    const r = await API.missingDllDialogFixRevert();
    setBusyFix(false);
    if (!r.ok) { await dpAlert("Не вдалося відкотити", r.error || "?", { tone: "danger" }); return; }
    await dpAlert("Готово", "DLL повернено до резервної копії.", { tone: "success" });
    // Скидаємо стан — items застаріли.
    setItems([]); setEdits(new Map()); setPhase("idle");
    await refreshFixStatus();
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (onlyEdited && !edits.has(it.id)) return false;
      if (onlyWhitelist && !isInDllWhitelist(it.type, it.method, it.offset)) return false;
      if (!q) return true;
      return it.type.toLowerCase().includes(q)
        || it.method.toLowerCase().includes(q)
        || it.original.toLowerCase().includes(q)
        || (edits.get(it.id) || "").toLowerCase().includes(q);
    });
  }, [items, edits, search, onlyEdited, onlyWhitelist]);

  // Скільки позицій у поточному extract'і збігаються з whitelist'ом.
  const whitelistCount = useMemo(
    () => items.filter((it) => isInDllWhitelist(it.type, it.method, it.offset)).length,
    [items]
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="dp-card w-full max-w-5xl flex flex-col" style={{ maxHeight: "92vh" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">DLL · Assembly-CSharp</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              Швидкий fix обрізання діалогів + редактор string-літералів з гри (Mono.Cecil).
            </p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] grid gap-3" style={{ gridTemplateColumns: "1fr auto" }}>
          <div>
            <p className="text-[12.5px] font-semibold text-[var(--text-strong)] flex items-center gap-2">
              Виправити обрізання діалогів
              {fixStatus && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-normal ${
                    fixStatus.patched
                      ? "bg-[var(--success)]/15 text-[var(--success)]"
                      : "bg-[var(--warning,#d97706)]/15 text-[var(--warning,#d97706)]"
                  }`}
                  title={`Ballon: ${fixStatus.ballon ? "✓" : "✗"} · BallonController: ${fixStatus.ballonController ? "✓" : "✗"} · WordWrapType: ${fixStatus.wordWrap ? "✓" : "✗"}`}
                >
                  {fixStatus.patched ? "✓ застосовано" : "⚠ не застосовано"}
                </span>
              )}
            </p>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              3 IL-патчі: <span className="font-mono">Ballon</span> + <span className="font-mono">BallonController</span> → <span className="font-mono">SizeControlType=UseTextInfo</span> (chat-bubble адаптує ширину).
              Плюс <span className="font-mono">TextExGenerator.get_WordWrapType</span> → завжди <span className="font-mono">Default</span> (wrap йде по пробілах між словами, а не посеред слова).
              Після patch перезапусти гру.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <button className="dp-btn dp-btn--success" disabled={busyFix || fixStatus?.patched === true} onClick={runQuickFix}>
              {busyFix ? "…" : fixStatus?.patched === true ? "✓ Вже застосовано" : "Виправити"}
            </button>
            <button className="dp-btn dp-btn--ghost" disabled={busyFix || !fixStatus?.bakExists} onClick={revertFix} title="Повернути DLL з .dll.bak">
              ↺ Відкотити
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex flex-wrap items-center gap-3">
          <button className="dp-btn dp-btn--primary" disabled={phase === "extracting" || phase === "applying"} onClick={extract}>
            {phase === "extracting" ? "Витягую…" : (items.length ? "Перевитягти" : "Витягнути всі рядки")}
          </button>
          {items.length > 0 && (
            <>
              <input
                type="search"
                className="dp-input flex-1 max-w-md"
                placeholder="Пошук за type / method / текстом…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]" title={`Built-in whitelist із ${MISSING_DLL_TEXT_WHITELIST.length} user-facing ldstr-позицій (меню якості графіки, мова, ON/OFF тригери). Стабільний по type+method+offset — спрацює і на оригінальній EN-DLL.`}>
                <input type="checkbox" checked={onlyWhitelist} onChange={(e) => setOnlyWhitelist(e.target.checked)} />
                <span>Лише UI-кандидати ({whitelistCount}/{MISSING_DLL_TEXT_WHITELIST.length})</span>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <input type="checkbox" checked={onlyEdited} onChange={(e) => setOnlyEdited(e.target.checked)} />
                <span>Лише відредаговані ({edits.size})</span>
              </label>
              <span className="ml-auto text-[11px] text-[var(--text-faint)] tabular-nums">{filtered.length}/{items.length}</span>
              <button className="dp-btn dp-btn--success" disabled={edits.size === 0 || phase === "applying"} onClick={apply}>
                {phase === "applying" ? "Записую…" : `Записати у DLL (${edits.size})`}
              </button>
            </>
          )}
        </div>

        {errMsg && (
          <div className="px-5 py-2 bg-[var(--danger)]/10 border-b border-[var(--danger)]/30 text-[11.5px] text-[var(--danger)] font-mono whitespace-pre-wrap">
            {errMsg}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto">
          {phase === "idle" && items.length === 0 && (
            <p className="py-10 text-center text-[12.5px] text-[var(--text-muted)]">
              Натисни «Витягнути всі рядки», щоб побачити string-літерали з Assembly-CSharp.dll.
            </p>
          )}
          {items.length > 0 && (
            <table className="w-full text-[11.5px] border-collapse">
              <thead className="sticky top-0 bg-[var(--bg-surface)] z-10 border-b border-[var(--border-soft)]">
                <tr className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  <th className="text-left px-3 py-1.5 w-[40%]">Type / Method · Offset</th>
                  <th className="text-left px-2 py-1.5">Original (EN)</th>
                  <th className="text-left px-2 py-1.5">Переклад (UA)</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((it) => {
                  const editVal = edits.get(it.id);
                  const uaHint = getDllUaHint(it.type, it.method, it.offset);
                  // Placeholder показує uaHint, якщо позиція у whitelist'і. Це
                  // дає перекладачеві старт із готового UA-варіанта (з нашого
                  // built-in словника), а не «(не редаговано)».
                  const placeholder = uaHint ?? "(не редаговано)";
                  return (
                    <tr key={it.id} className="border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]">
                      <td className="px-3 py-1 font-mono text-[10.5px] text-[var(--text-muted)] align-top">
                        <div className="truncate" title={it.type}>{it.type}</div>
                        <div className="text-[var(--text-faint)]">.{it.method} · {it.offset}</div>
                      </td>
                      <td className="px-2 py-1 align-top">
                        <p className="text-[11.5px] text-[var(--text)] whitespace-pre-wrap break-words">{it.original}</p>
                      </td>
                      <td className="px-2 py-1 align-top">
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            className="dp-input w-full !text-[11.5px]"
                            value={editVal ?? ""}
                            placeholder={placeholder}
                            onChange={(e) => {
                              const v = e.target.value;
                              setEdits((prev) => {
                                const next = new Map(prev);
                                if (v === "") next.delete(it.id);
                                else next.set(it.id, v);
                                return next;
                              });
                            }}
                          />
                          {uaHint && uaHint !== editVal && uaHint !== it.original && (
                            <button
                              type="button"
                              className="dp-btn dp-btn--ghost !px-1.5 !py-0.5 text-[10px] shrink-0"
                              onClick={() => setEdits((prev) => new Map(prev).set(it.id, uaHint))}
                              title={`Вставити: «${uaHint}»`}
                            >
                              ↧
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length > 500 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-center text-[10.5px] text-[var(--text-faint)] italic">
                      Показано перші 500 з {filtered.length}. Уточни пошук, щоб побачити інші.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center gap-2 text-[10.5px] text-[var(--text-faint)]">
          <span>DLL: <span className="font-mono">…\TheMISSING_Data\Managed\Assembly-CSharp.dll</span></span>
          <span className="ml-auto">Backup: <span className="font-mono">Assembly-CSharp.dll.bak</span></span>
        </div>
      </div>
    </div>
  );
}
