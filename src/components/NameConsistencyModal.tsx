// Перевірка консистентності імен героїв у DP2-корпусі. Сканує всі `charaName`,
// групує варіанти, що відрізняються лише регістром / на 1-2 символи (типос).
// Юзер обирає канонічний варіант → батч-перейменування по всіх файлах
// (exact equality, без substring-замін).

import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { useStore } from "../lib/store";
import { confirm as showConfirm, alert as showAlert } from "../lib/dialogs";
import { invalidateTm } from "../lib/tm";
import type { NameConsistencyResult, NameGroup, NameVariant } from "../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NameConsistencyModal({ open, onClose }: Props) {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const selectedFilePath = useStore((s) => s.selectedFilePath);
  const loadFile = useStore((s) => s.loadFile);
  const setActive = useStore((s) => s.setActive);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<NameConsistencyResult | null>(null);
  const [tick, setTick] = useState(0);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !folder) return;
    let cancelled = false;
    setLoading(true);
    setData(null);
    window.dp2.nameConsistencyWorker({ folder })
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, folder, tick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function rename(oldName: string, newName: string, expectedCount: number) {
    if (!folder || oldName === newName) return;
    const ok = await showConfirm(
      t("nc.confirmTitle"),
      t("nc.confirmBody", { oldName, newName, n: expectedCount }),
      { tone: "danger", okLabel: t("nc.applyBtn") }
    );
    if (!ok) return;
    setWorking(oldName);
    try {
      const res = await window.dp2.renameCharaWorker({ folder, oldName, newName });
      invalidateTm();
      // якщо поточний файл був серед змінених — перевантажити
      if (selectedFilePath && res.files.some((f) => f.path === selectedFilePath)) {
        await loadFile(selectedFilePath);
      }
      await showAlert(
        t("nc.doneTitle"),
        t("nc.doneBody", { n: res.totalEntries, files: res.files.length }),
        { tone: "success" }
      );
      setTick((x) => x + 1); // перебіг
    } catch (e: any) {
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    } finally {
      setWorking(null);
    }
  }

  async function jump(filePath: string, entryIndex: number) {
    await loadFile(filePath);
    setActive(entryIndex);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="dp-card w-[920px] max-w-[96vw] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("nc.title")}</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5 truncate">{t("nc.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setTick((x) => x + 1)} className="dp-btn" disabled={loading || !folder}>
              {t("nc.refresh")}
            </button>
            <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!folder ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("nc.noFolder")}</p>
          ) : loading || !data ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("nc.loading")}</p>
          ) : (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-3 p-5 border-b border-[var(--border-soft)]">
                <Box label={t("nc.totalNames")} value={data.totalNames} />
                <Box label={t("nc.totalEntries")} value={data.totalEntries} />
                <Box label={t("nc.groups")} value={data.groups.length} tone={data.groups.length > 0 ? "warning" : "success"} />
              </div>

              {data.groups.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-[var(--success)]">
                  ✓ {t("nc.allClean")}
                </p>
              ) : (
                <div>
                  {data.groups.map((g) => (
                    <Group
                      key={g.canonical}
                      group={g}
                      working={working}
                      onRename={rename}
                      onJump={jump}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Box({ label, value, tone }: { label: string; value: number; tone?: "warning" | "success" }) {
  const color = tone === "warning" ? "text-[var(--warning)]"
    : tone === "success" ? "text-[var(--success)]"
    : "text-[var(--text-strong)]";
  return (
    <div className="border border-[var(--border-soft)] rounded p-3 bg-[var(--bg)]">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{label}</p>
      <p className={`text-[20px] font-bold tabular-nums leading-none ${color}`}>
        {value.toLocaleString("uk-UA")}
      </p>
    </div>
  );
}

function Group({
  group, working, onRename, onJump,
}: {
  group: NameGroup;
  working: string | null;
  onRename: (oldName: string, newName: string, count: number) => Promise<void>;
  onJump: (filePath: string, entryIndex: number) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Канонічний (найчастіший) — група[0]; інші — кандидати до перейменування.
  const canonical = group.variants[0];

  return (
    <div className="border-b border-[var(--border-soft)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-5 py-2.5 flex items-center gap-3 hover:bg-[var(--row-hover)]"
      >
        <svg
          className={`w-3 h-3 shrink-0 text-[var(--text-faint)] transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor" viewBox="0 0 16 16"
        >
          <path d="M5 4l5 4-5 4V4z" />
        </svg>
        <span className="font-semibold text-[13px] text-[var(--text-strong)] truncate">
          {canonical.name}
        </span>
        <span className="text-[10px] text-[var(--success)] tabular-nums">
          ×{canonical.count}
        </span>
        <span className="text-[var(--text-faint)] text-[11px]">·</span>
        <span className="text-[12px] text-[var(--warning)] truncate">
          {t("nc.variants", { n: group.variants.length - 1 })}:{" "}
          {group.variants.slice(1).map((v) => `${v.name} (${v.count})`).join(", ")}
        </span>
      </button>

      {open && (
        <div className="bg-[var(--bg)] border-t border-[var(--border-soft)]">
          {group.variants.map((v, vi) => (
            <Variant
              key={v.name}
              variant={v}
              isCanonical={vi === 0}
              canonicalName={canonical.name}
              working={working}
              onRename={onRename}
              onJump={onJump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Variant({
  variant, isCanonical, canonicalName, working, onRename, onJump,
}: {
  variant: NameVariant;
  isCanonical: boolean;
  canonicalName: string;
  working: string | null;
  onRename: (oldName: string, newName: string, count: number) => Promise<void>;
  onJump: (filePath: string, entryIndex: number) => void;
}) {
  const t = useT();
  const busy = working === variant.name;
  return (
    <div className="px-5 py-2.5 pl-10 border-t border-[var(--border-soft)]">
      <div className="flex items-center gap-3 mb-1.5">
        <span className={`text-[13px] font-semibold ${isCanonical ? "text-[var(--success)]" : "text-[var(--text)]"}`}>
          {variant.name}
        </span>
        <span className="text-[11px] text-[var(--text-faint)] tabular-nums">×{variant.count}</span>
        {isCanonical ? (
          <span className="dp-pill dp-pill--success">{t("nc.canonical")}</span>
        ) : (
          <button
            onClick={() => onRename(variant.name, canonicalName, variant.count)}
            disabled={busy}
            className="dp-btn dp-btn--primary"
          >
            {busy ? t("nc.applying") : t("nc.renameTo", { name: canonicalName })}
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {variant.samples.map((s, i) => (
          <li
            key={i}
            onClick={() => onJump(s.filePath, s.entryIndex)}
            className="text-[11px] cursor-pointer hover:bg-[var(--row-hover)] rounded px-2 py-1 flex items-center gap-2"
          >
            <span className="font-mono text-[var(--text-faint)] shrink-0">{s.fileName}</span>
            <span className="font-mono text-[var(--text-muted)] truncate" title={s.entryId}>{s.entryId}</span>
            <span className="text-[var(--text-muted)] truncate flex-1" title={s.en}>· {s.en}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
