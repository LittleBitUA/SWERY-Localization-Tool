// Pre-flight перевірки — тонка обгортка над main-side worker_threads.
// Парсинг JSON і обробка винесені у Node worker, щоб renderer не блокувався.

export type IssueKind = "empty" | "newline" | "tag";

export interface Issue {
  kind: IssueKind;
  filePath: string;
  entryIndex: number;
  id: string;
  detail: string;
}

export interface ScanResult {
  totalEntries: number;
  totalTranslated: number;
  issues: Issue[];
}

export async function scanAll(folder: string): Promise<ScanResult> {
  const raw = await window.dp2.scanAll(folder);
  return {
    totalEntries: raw.totalEntries,
    totalTranslated: raw.totalTranslated,
    issues: raw.issues
      .filter((i): i is Issue & { kind: IssueKind } =>
        i.kind === "empty" || i.kind === "newline" || i.kind === "tag")
      .map((i) => ({
        kind: i.kind as IssueKind,
        filePath: i.filePath,
        entryIndex: i.entryIndex,
        id: i.id,
        detail: i.detail,
      })),
  };
}
