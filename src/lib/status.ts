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
  /** Manual override: рядок не змінювали (системний, plain `:)`, тощо), але
   *  користувач натиснув ПКМ → «Позначити перекладеним», щоб % рахувався. */
  markedTranslated?: true;
}

/** File-level marks (для DP2 ПКМ-меню на файл у sidebar). */
export interface FileMeta {
  /** «Перекладено» — усі рядки явно позначені перекладеними. Файл малюється зеленим. */
  allTranslated?: true;
  /** «Зредаговано» — файл прозвучаний пройдений редактором. Малюється помаранчевим. */
  edited?: true;
}

export interface StatusFile {
  version: 1;
  /** Мапа key → стан. Key — стабільний ідентифікатор запису у грі. */
  entries: Record<string, StatusEntry>;
  /** Файлові марки. Ключ — повний шлях до файлу. */
  files?: Record<string, FileMeta>;
}

export function emptyStatusFile(): StatusFile {
  return { version: 1, entries: {}, files: {} };
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
  const isEmpty = !cur.status && !cur.bookmark && !cur.note && !cur.markedTranslated;
  if (!isEmpty) return file;
  const { [key]: _drop, ...rest } = file.entries;
  return { ...file, entries: rest };
}

/** Видалити file-meta, якщо обидва прапорці зняті. */
export function pruneFileMeta(file: StatusFile, path: string): StatusFile {
  if (!file.files) return file;
  const cur = file.files[path];
  if (!cur) return file;
  if (cur.allTranslated || cur.edited) return file;
  const { [path]: _drop, ...rest } = file.files;
  return { ...file, files: rest };
}
