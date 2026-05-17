// DP2 prep wizard: список текстових MonoBehaviour-asset'ів, які треба витягти
// з sharedassets0.assets для перекладу. Імена файлів — як їх створює UABEA
// при сериалізації MonoBehaviour: <m_Name>-<bundleName>-<pathId>.json.

export interface Dp2TextFile {
  pathId: number;
  name: string;     // m_Name field у asset'і
  category: "Common" | "Daily" | "Display" | "Episode" | "Talk" | "SideQuest";
}

export const DP2_TEXT_FILES: Dp2TextFile[] = [
  { pathId: 1799, name: "Common_05", category: "Common" },
  { pathId: 1805, name: "Common_19", category: "Common" },

  { pathId: 1819, name: "C022_Daily", category: "Daily" },
  { pathId: 1822, name: "C025_Daily", category: "Daily" },
  { pathId: 1820, name: "C023_Daily", category: "Daily" },
  { pathId: 1821, name: "C024_Daily", category: "Daily" },
  { pathId: 1823, name: "C026_Daily", category: "Daily" },
  { pathId: 1811, name: "C012_Daily", category: "Daily" },
  { pathId: 1810, name: "C006_Daily", category: "Daily" },
  { pathId: 1818, name: "C021_Daily", category: "Daily" },
  { pathId: 1817, name: "C020_Daily", category: "Daily" },
  { pathId: 1816, name: "C019_Daily", category: "Daily" },
  { pathId: 1815, name: "C018_Daily", category: "Daily" },
  { pathId: 1814, name: "C017_Daily", category: "Daily" },
  { pathId: 1813, name: "C016_Daily", category: "Daily" },
  { pathId: 1812, name: "C013_Daily", category: "Daily" },

  { pathId: 1763, name: "Display", category: "Display" },

  { pathId: 1804, name: "Episode0", category: "Episode" },
  { pathId: 1800, name: "Episode1_05", category: "Episode" },
  { pathId: 1806, name: "Episode1_19", category: "Episode" },
  { pathId: 1801, name: "Episode2_05", category: "Episode" },
  { pathId: 1807, name: "Episode2_19", category: "Episode" },
  { pathId: 1802, name: "Episode3_05", category: "Episode" },
  { pathId: 1808, name: "Episode3_19", category: "Episode" },
  { pathId: 1809, name: "Episode4_19", category: "Episode" },

  { pathId: 1803, name: "Talk_05", category: "Talk" },

  { pathId: 1824, name: "C006_SideQuest", category: "SideQuest" },
  { pathId: 1825, name: "C012_SideQuest", category: "SideQuest" },
  { pathId: 1826, name: "C013_SideQuest", category: "SideQuest" },
  { pathId: 1827, name: "C016_SideQuest", category: "SideQuest" },
  { pathId: 1828, name: "C017_SideQuest", category: "SideQuest" },
  { pathId: 1829, name: "C018_SideQuest", category: "SideQuest" },
  { pathId: 1830, name: "C019_SideQuest", category: "SideQuest" },
  { pathId: 1831, name: "C020_SideQuest", category: "SideQuest" },
  { pathId: 1832, name: "C021_SideQuest", category: "SideQuest" },
  { pathId: 1833, name: "C022_SideQuest", category: "SideQuest" },
  { pathId: 1834, name: "C023_SideQuest", category: "SideQuest" },
  { pathId: 1835, name: "C024_SideQuest", category: "SideQuest" },
  { pathId: 1836, name: "C025_SideQuest", category: "SideQuest" },
  { pathId: 1837, name: "C026_SideQuest", category: "SideQuest" },
];

export function dp2TextFilename(f: Dp2TextFile): string {
  return `${f.name}-sharedassets0.assets-${f.pathId}.json`;
}

export interface Dp2TextEntry {
  file: string;     // base filename (no category prefix)
  category: string; // папка усередині TEXT/ORIGINAL та TEXT/DONE
  pathId: number;
}

export function dp2TextRequiredEntries(): Dp2TextEntry[] {
  return DP2_TEXT_FILES.map((f) => ({
    file: dp2TextFilename(f),
    category: f.category,
    pathId: f.pathId,
  }));
}
