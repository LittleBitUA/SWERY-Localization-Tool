// Простий глосарій термінів: { src: "Francis York Morgan", tgt: "Френсіс Йорк Морган" }.
// Зберігається у файлі .dp2-glossary.json у корені робочої теки.

export interface GlossaryEntry {
  src: string;
  tgt: string;
  note?: string;
}

const FILE_NAME = ".dp2-glossary.json";

function glossaryPath(folder: string): string {
  // Шлях рахуємо у frontend, бо folder уже абсолютний; розділювач "/" працює в Windows fs API.
  const sep = folder.includes("\\") ? "\\" : "/";
  return folder.endsWith(sep) ? folder + FILE_NAME : folder + sep + FILE_NAME;
}

export async function readGlossary(folder: string): Promise<GlossaryEntry[]> {
  try {
    const raw = await window.dp2.readFile(glossaryPath(folder));
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x.src === "string" && typeof x.tgt === "string");
    return [];
  } catch {
    return [];
  }
}

export async function writeGlossary(folder: string, entries: GlossaryEntry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.src.localeCompare(b.src));
  await window.dp2.writeFile(glossaryPath(folder), JSON.stringify(sorted, null, 2));
}

/** Знайти всі терміни глосарія, що зустрічаються в src-тексті (case-insensitive). */
export function findGlossaryHits(text: string, glossary: GlossaryEntry[]): GlossaryEntry[] {
  if (!text || glossary.length === 0) return [];
  const t = text.toLowerCase();
  return glossary.filter((g) => g.src && t.includes(g.src.toLowerCase()));
}
