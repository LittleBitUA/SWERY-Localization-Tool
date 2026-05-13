// Side-car статуси і закладки для рядків.
// Зберігаються у файлі поруч з даними:
//   • DP2 → <folder>/.dp-status.json (folder = JSON-теки корпусу)
//   • DP1 → <engPath>.status.json   (поруч з eng.json)
// Не зачіпають самих ігрових JSON — пакування .assets/.mes не змінюється.

export type StatusKind = "draft" | "review" | "approved";

export interface StatusEntry {
  status?: StatusKind;
  bookmark?: true;
  note?: string;
}

export interface StatusFile {
  version: 1;
  /** Мапа key → стан. Key — стабільний ідентифікатор запису у грі. */
  entries: Record<string, StatusEntry>;
}

export function emptyStatusFile(): StatusFile {
  return { version: 1, entries: {} };
}

export async function readStatusFile(path: string): Promise<StatusFile> {
  try {
    const raw = await window.dp2.readFile(path);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.entries) {
      return parsed as StatusFile;
    }
    return emptyStatusFile();
  } catch {
    return emptyStatusFile();
  }
}

export async function writeStatusFile(path: string, file: StatusFile): Promise<void> {
  await window.dp2.writeFile(path, JSON.stringify(file, null, 2));
}

/** Видалити запис якщо він "порожній" — щоб не накопичувати сміття. */
export function pruneEntry(file: StatusFile, key: string): StatusFile {
  const cur = file.entries[key];
  if (!cur) return file;
  const isEmpty = !cur.status && !cur.bookmark && !cur.note;
  if (!isEmpty) return file;
  const { [key]: _drop, ...rest } = file.entries;
  return { ...file, entries: rest };
}
