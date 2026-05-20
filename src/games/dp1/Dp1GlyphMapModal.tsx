import { useEffect, useMemo, useState } from "react";
import { alert as showAlert, confirm as showConfirm } from "../../lib/dialogs";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface MapEntry { from: string; to: string }

// Заміна гліфів для пакування у гру. Кастомний шрифт DP1 використовує
// латинські слоти для кирилиці — без цієї підміни український текст у грі
// не намалюється. Мапа застосовується автоматично у dp2:dp1-pack ПЕРЕД
// викликом DPMsgTool, тому редактор показує/зберігає Done JSON у нормальній
// кирилиці, а на диск гри летить підмінений варіант.
export function Dp1GlyphMapModal({ open, onClose }: Props) {
  const [entries, setEntries] = useState<MapEntry[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await window.dp2.dp1GlyphMapRead();
      if (!r.ok) { setError("Не вдалося прочитати мапу"); return; }
      const list: MapEntry[] = Object.entries(r.map).map(([from, to]) => ({ from, to }));
      setEntries(list);
      setDefaults(r.defaults);
    } finally { setLoading(false); }
  }
  useEffect(() => { if (open) load(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries.map((e, i) => ({ ...e, _i: i }));
    return entries.map((e, i) => ({ ...e, _i: i })).filter((e) => e.from.toLowerCase().includes(q) || e.to.toLowerCase().includes(q));
  }, [entries, filter]);

  function updateAt(i: number, patch: Partial<MapEntry>) {
    setEntries((arr) => arr.map((e, idx) => idx === i ? { ...e, ...patch } : e));
  }
  function removeAt(i: number) {
    setEntries((arr) => arr.filter((_, idx) => idx !== i));
  }
  function addRow() {
    setEntries((arr) => [{ from: "", to: "" }, ...arr]);
  }
  async function restoreDefaults() {
    const ok = await showConfirm(
      "Відновити стандартну мапу?",
      "Усі поточні правила будуть замінені на типовий набір (66 пар). Незбережені правки втратяться.",
      { tone: "warning" }
    );
    if (!ok) return;
    setEntries(Object.entries(defaults).map(([from, to]) => ({ from, to })));
  }

  async function handleSave() {
    // Валідація: from має бути 1 символ; to має бути >=1 символ.
    const seen = new Set<string>();
    const dupe: string[] = [];
    const bad: string[] = [];
    const map: Record<string, string> = {};
    for (const e of entries) {
      const f = e.from;
      const t = e.to;
      if (!f) { bad.push("(порожнє From)"); continue; }
      if (!t) { bad.push(`${f} → (порожнє To)`); continue; }
      if (seen.has(f)) { dupe.push(f); continue; }
      seen.add(f);
      map[f] = t;
    }
    if (bad.length > 0 || dupe.length > 0) {
      let msg = "";
      if (bad.length > 0) msg += `Невалідні рядки:\n${bad.slice(0, 8).join("\n")}\n\n`;
      if (dupe.length > 0) msg += `Дублікати From:\n${dupe.slice(0, 8).join(", ")}`;
      await showAlert("Перевір мапу", msg, { tone: "warning" });
      return;
    }
    setSaving(true);
    try {
      const r = await window.dp2.dp1GlyphMapWrite({ map });
      if (!r.ok) { await showAlert("Помилка збереження", r.error ?? ""); return; }
      onClose();
    } finally { setSaving(false); }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-3xl flex flex-col"
        style={{ maxHeight: "88vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">Мапа підміни гліфів (пак у гру)</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              Перед пакуванням у `mes_all.mes` кожен символ із колонки From замінюється на відповідний To.
              У редакторі ти бачиш звичайну кирилицю; ця підміна застосовується автоматично у момент паку.
            </p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-2 flex-wrap">
          <input
            type="text"
            className="dp-input flex-1 min-w-[160px]"
            placeholder="Пошук по From / To…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="dp-btn" onClick={addRow} title="Додати порожній рядок зверху">+ Правило</button>
          <button className="dp-btn dp-btn--ghost" onClick={restoreDefaults}>↺ Стандарт</button>
          <span className="text-[10.5px] tabular-nums text-[var(--text-faint)] ml-auto">
            Правил: {entries.length} · показано: {filtered.length}
          </span>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">Завантаження…</p>
          )}
          {error && !loading && (
            <p className="py-10 text-center text-[13px] text-[var(--danger)]">{error}</p>
          )}
          {!loading && !error && (
            <table className="w-full text-[12.5px] border-collapse">
              <thead className="sticky top-0 bg-[var(--bg-surface)] z-10 border-b border-[var(--border-soft)]">
                <tr>
                  <th className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold w-[80px]">From</th>
                  <th className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold w-[80px]">To</th>
                  <th className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">U+ (info)</th>
                  <th className="px-1 py-1.5 w-[40px]" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e._i} className="border-b border-[var(--border-soft)]">
                    <td className="px-3 py-1.5">
                      <input
                        type="text"
                        className="dp-input w-full font-mono text-center"
                        value={e.from}
                        maxLength={2}
                        onChange={(ev) => updateAt(e._i, { from: ev.target.value })}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="text"
                        className="dp-input w-full font-mono text-center"
                        value={e.to}
                        maxLength={2}
                        onChange={(ev) => updateAt(e._i, { to: ev.target.value })}
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[10.5px] text-[var(--text-faint)] tabular-nums">
                      {e.from ? "U+" + e.from.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0") : ""}
                      {e.to ? "  →  U+" + e.to.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0") : ""}
                    </td>
                    <td className="px-1 py-1.5 text-center">
                      <button
                        className="text-[var(--text-faint)] hover:text-[var(--danger)] text-[14px]"
                        onClick={() => removeAt(e._i)}
                        title="Видалити правило"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-10 text-center text-[12px] text-[var(--text-faint)]">Нічого не знайдено.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--border-soft)]">
          <p className="text-[11px] text-[var(--text-muted)] flex-1">
            Зберігається у <span className="font-mono">Documents\SWERY-Localization-Tool\DP1\Text\Meta\glyphmap.json</span>.
          </p>
          <button className="dp-btn dp-btn--ghost" onClick={onClose}>Скасувати</button>
          <button className="dp-btn dp-btn--primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? "Збереження…" : "Зберегти"}
          </button>
        </div>
      </div>
    </div>
  );
}
