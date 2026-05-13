import { useEffect, useState } from "react";
import { readGlossary, writeGlossary, type GlossaryEntry } from "../lib/glossary";
import { useT } from "../lib/i18n";

interface GlossaryModalProps {
  open: boolean;
  folder: string | null;
  onClose: (saved: GlossaryEntry[] | null) => void;
}

export function GlossaryModal({ open, folder, onClose }: GlossaryModalProps) {
  const t = useT();
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !folder) return;
    setLoading(true);
    readGlossary(folder)
      .then(setEntries)
      .finally(() => setLoading(false));
  }, [open, folder]);

  if (!open) return null;

  const filtered = filter.trim()
    ? entries.filter(
        (e) =>
          e.src.toLowerCase().includes(filter.toLowerCase()) ||
          e.tgt.toLowerCase().includes(filter.toLowerCase())
      )
    : entries;

  function update(i: number, patch: Partial<GlossaryEntry>) {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }

  function remove(i: number) {
    setEntries((prev) => prev.filter((_, idx) => idx !== i));
  }

  function add() {
    setEntries((prev) => [{ src: "", tgt: "" }, ...prev]);
  }

  async function save() {
    if (!folder) return;
    const cleaned = entries
      .map((e) => ({ src: e.src.trim(), tgt: e.tgt.trim(), note: e.note?.trim() || undefined }))
      .filter((e) => e.src && e.tgt);
    await writeGlossary(folder, cleaned);
    onClose(cleaned);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => onClose(null)}>
      <div
        className="dp-card w-[720px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("gl.title")}</h2>
          <span className="text-[11px] text-[var(--text-faint)]">{t("gl.savedAt")}</span>
        </div>

        <div className="px-5 py-2 border-b border-[var(--border-soft)] flex items-center gap-2">
          <input
            className="dp-input flex-1"
            placeholder={t("gl.filter")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="dp-btn" onClick={add}>{t("gl.add")}</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("gl.loading")}</p>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">
              {entries.length === 0 ? t("gl.empty") : t("gl.emptyFilter")}
            </p>
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[var(--bg-surface)] border-b border-[var(--border-soft)] text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                <tr>
                  <th className="text-left px-3 py-1.5 w-[40%]">{t("gl.col.src")}</th>
                  <th className="text-left px-3 py-1.5 w-[40%]">{t("gl.col.tgt")}</th>
                  <th className="text-left px-3 py-1.5">{t("gl.col.note")}</th>
                  <th className="w-[40px]"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const i = entries.indexOf(e);
                  return (
                    <tr key={i} className="border-b border-[var(--border-soft)]">
                      <td className="px-2 py-1">
                        <input
                          className="dp-input"
                          value={e.src}
                          onChange={(ev) => update(i, { src: ev.target.value })}
                          placeholder="Francis York Morgan"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          className="dp-input"
                          value={e.tgt}
                          onChange={(ev) => update(i, { tgt: ev.target.value })}
                          placeholder={t("gl.placeholder.tgt")}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          className="dp-input"
                          value={e.note ?? ""}
                          onChange={(ev) => update(i, { note: ev.target.value })}
                          placeholder="—"
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <button
                          className="dp-btn dp-btn--ghost text-[var(--danger)]"
                          onClick={() => remove(i)}
                          title={t("gl.delete")}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
          <button className="dp-btn" onClick={() => onClose(null)}>{t("btn.cancel")}</button>
          <button className="dp-btn dp-btn--primary" onClick={save}>{t("btn.save")}</button>
        </div>
      </div>
    </div>
  );
}
