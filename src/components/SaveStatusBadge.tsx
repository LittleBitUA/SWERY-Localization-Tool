// Візуальний індикатор стану збереження поточного файла. Спільний для всіх
// редакторів: DP2 Header, HBR/DP1/MISSING/TGL топ-бари. Замість тихого dirty
// = boolean, користувач завжди бачить чи його робота на диску.
//
// Стани (визначаються props автоматично):
//   • saved      → файл чистий, нічого не редагували
//   • dirty      → є незбережені правки, autosave не запускався
//   • autosaved  → є правки, але autosave щойно записав sidecar (recover-able)
//   • error      → останній saveFile упав (анти-вірус, lock, etc)

import { useEffect, useState } from "react";

interface Props {
  /** Є незбережені правки у поточному файлі. */
  dirty: boolean;
  /** ms unix-таймстамп останнього успішного autosave або null. */
  lastAutosaveAt?: number | null;
  /** Текст помилки останньої спроби збереження, або null. */
  saveError?: string | null;
  /** Підпис для tooltip-у з ім'ям файла (опціонально). */
  fileName?: string | null;
}

export function SaveStatusBadge({ dirty, lastAutosaveAt, saveError, fileName }: Props) {
  // Перебудовується раз на 15с, щоб "автозбережено 3 хв тому" оновлювалось.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const state: "error" | "dirty" | "autosaved" | "saved" = saveError
    ? "error"
    : dirty
      ? (lastAutosaveAt && Date.now() - lastAutosaveAt < 60_000 ? "autosaved" : "dirty")
      : "saved";

  const color =
    state === "error" ? "var(--danger)"
    : state === "dirty" ? "var(--warning, #d97706)"
    : state === "autosaved" ? "var(--accent)"
    : "var(--success)";

  const label =
    state === "error" ? "помилка збереження"
    : state === "dirty" ? "не збережено"
    : state === "autosaved" ? "автозбережено"
    : "збережено";

  const tipParts: string[] = [];
  if (fileName) tipParts.push(fileName);
  tipParts.push(label);
  if (state === "autosaved" && lastAutosaveAt) {
    const ago = Math.max(0, Math.round((Date.now() - lastAutosaveAt) / 1000));
    tipParts.push(ago < 60 ? `${ago}с тому` : `${Math.round(ago / 60)} хв тому`);
  }
  if (state === "error" && saveError) {
    tipParts.push(saveError);
  }
  const tip = tipParts.join(" · ");

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10.5px] text-[var(--text-faint)] tabular-nums whitespace-nowrap select-none"
      title={tip}
    >
      <span
        aria-hidden
        className={state === "autosaved" ? "animate-pulse" : ""}
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: color,
          boxShadow: state === "error" ? `0 0 0 2px ${color}33` : undefined,
          display: "inline-block",
        }}
      />
      <span className="hidden md:inline">{label}</span>
    </span>
  );
}
