// Single source of truth для UI-текстів сайту. Усі компоненти отримують
// `lang: "uk" | "en"` як проп і читають strings[lang].<key>. Pages/uk та
// pages/en — це фактично та сама композиція з різним lang.

export type Lang = "uk" | "en";

export interface Strings {
  nav: { games: string; features: string; modding: string; download: string };
  hero: {
    bureau: string; title: string; subtitle: string; lede: string;
    download: string; viewSource: string;
    meta: { period: string; periodValue: string; license: string; licenseValue: string; platform: string; platformValue: string };
  };
  stats: { games: string; formats: string; strings: string; portable: string };
  cases: {
    tag: string; title1: string; title2: string; lede: string;
    label: { platform: string; format: string; editors: string; records: string; tools: string; engine: string; specific: string; risk: string; subject: string };
    stamp: { active: string; closed: string };
    items: Array<{
      no: string; region: string; title: string; altname: string;
      fields: Array<[keyof Strings["cases"]["label"], string]>;
      progress: number; note: string; stamp: "active" | "closed";
    }>;
  };
  caps: {
    tag: string; title1: string; title2: string; lede: string;
    items: Array<{ tag: string; title: string; body: string; featured?: boolean }>;
  };
  quote: { body: string; cite: string };
  modding: {
    tag: string; title1: string; title2: string; lede: string;
    open: string;
    items: Array<{ href: string; tag: string; title: string; body: string }>;
  };
  footer: {
    license: string; credits: string;
    made: string; disclaimer: string;
  };
  scrollTop: string;
}

const uk: Strings = {
  nav: { games: "Ігри", features: "Можливості", modding: "Reverse", download: "Завантажити" },
  hero: {
    bureau: "Federal Bureau of Localization",
    title: "SWERY Localization Tool",
    subtitle: "Investigation log · case files · build manuals",
    lede: "Один настільний інструмент, який обʼєднує перекладацький pipeline для п'яти ігор Hidetaka Suehiro (SWERY) та White Owls — від редагування JSON-дампів до запаковки фінального патчу, з вбудованими редакторами шрифтів, текстур і per-string box-sizes.",
    download: "Завантажити v{version} portable",
    viewSource: "Дивитись на GitHub",
    meta: {
      period: "Investigation period:", periodValue: "2026 — current",
      license: "License:", licenseValue: "MIT",
      platform: "Platform:", platformValue: "Windows portable",
    },
  },
  stats: {
    games: "Підтримуваних ігор",
    formats: "Реверс-розкритих форматів",
    strings: "Перекладних рядків",
    portable: "Portable, без installer-а",
  },
  cases: {
    tag: "Active casefiles · 001 — 005",
    title1: "П'ять ігор Swery / White Owls.",
    title2: "Один pipeline.",
    lede: "Кожна гра приносить власний неповторний бінарний формат. Інструмент реверсує їх so you can translate, not fight files.",
    label: {
      platform: "Платформа", format: "Формат", editors: "Редактори",
      records: "Записи", tools: "Тулкіт", engine: "Двигун",
      specific: "Особливе", risk: "Ризик", subject: "Subject dossier",
    },
    stamp: { active: "Активна", closed: "Закрита" },
    items: [
      {
        no: "001", region: "NA",
        title: "Deadly Premonition", altname: "— The Director's Cut, 2013 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", ".mes / DPMsgTool"],
          ["editors", "Текст · Шрифти · Текстури"],
          ["records", "~20 000 у mes_all.json"],
        ],
        progress: 8,
        note: "Greenvale's coffee dialogues, FONTWIDE.DDS atlas, custom XPC2 textures.",
        stamp: "active",
      },
      {
        no: "002", region: "NA",
        title: "Deadly Premonition 2", altname: "— A Blessing in Disguise, 2020 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "sharedassets / .assets"],
          ["editors", "Текст · Шрифти · Текстури"],
          ["tools", "UABEA + PowerShell 7"],
        ],
        progress: 9,
        note: "Le Carré, bloody sky. Сім asset-шрифтів, 22 текстури, cross-game TM.",
        stamp: "active",
      },
      {
        no: "005", region: "JP",
        title: "THE MISSING", altname: "— J.J. Macfield and the Island of Memories, 2018 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "MSG.* + IMHeightInfo"],
          ["editors", "Текст · Шрифти · Текстури · Box-sizes"],
          ["risk", "int16 overflow trap"],
        ],
        progress: 10,
        note: "Незалежний reverse — без TF2 source. Box-sizes auto-fit включено.",
        stamp: "closed",
      },
      {
        no: "003", region: "JP",
        title: "The Good Life", altname: "— Rainy Woods, 2021 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "loc/English (binary)"],
          ["editors", "Текст · Шрифти"],
          ["engine", "Unity 2020.1.17f1"],
        ],
        progress: 7,
        note: "Custom binary container, bitmap-font з atlas-painting + glyph injection.",
        stamp: "active",
      },
      {
        no: "004", region: "INT",
        title: "Hotel Barcelona", altname: "— Suda × Swery, 2025 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "Unity Addressables bundle"],
          ["editors", "Текст · Шрифти"],
          ["specific", "Patch-aware hash migration"],
        ],
        progress: 8,
        note: "Bundle-hash змінюється з кожним патчем — авто-міграція перекладу.",
        stamp: "active",
      },
    ],
  },
  caps: {
    tag: "Можливості",
    title1: "Зроблено перекладачами",
    title2: "для перекладачів.",
    lede: "Шість речей, які додаток робить добре — решта є, але це головне.",
    items: [
      { tag: "Memory", title: "Translation Memory", body: "Спільний корпус по всіх іграх SWERY: знайди exact-match переклад і застосуй одним кліком. Без вгадування за substring.", featured: true },
      { tag: "Editor", title: "Monaco з підсвічуванням тегів", body: "Той самий редактор, що у VS Code. Live діагностика плейсхолдерів, diff EN↔UA, стабільна модель без remount-лагу." },
      { tag: "Fonts",  title: "Редактор атласу шрифтів", body: "Малюй кириличні гліфи прямо на DDS поверх латинських — з snap-to-grid, Ctrl+Z і авто-оновленням glyphmap." },
      { tag: "Layout", title: "Per-string box-sizes", body: "У THE MISSING кожен рядок має W×H у IMHeightInfo. Auto-fit рахує від оригіналу — повторні apply не нарощують ширину." },
      { tag: "Safety", title: "Захист від тихої корупції", body: "Race-free saves, integrity checks перед write, int16-overflow guard. Якщо щось не так — toast, не битий патч." },
      { tag: "Workflow", title: "Все під рукою", body: "Auto-save, .txt round-trip для офлайн-перекладачів, status/bookmark side-cars, UK/EN UI, auto-update." },
    ],
  },
  quote: {
    body: "We're translating SWERY into Ukrainian.<br>The tools should respect that the work is the translation.",
    cite: "— Little Bit UA, project journal",
  },
  modding: {
    tag: "Field reports",
    title1: "Reverse-engineering",
    title2: "write-ups.",
    lede: "Складні частини форматів задокументовано простою англійською. Навіть якщо ти не користуєшся додатком — нотатки твої.",
    open: "Open write-up →",
    items: [
      {
        href: "https://github.com/LittleBitUA/SWERY-Localization-Tool/blob/main/docs/TGL-modding-notes.txt",
        tag: "Modding · The Good Life",
        title: "Custom loc/English container + bitmap font",
        body: "Text container layout, font bundle (<code>c0718fc478f6943d</code>), <code>flipped</code> + negative-<code>uv.height</code> convention, atlas write-back, 64-bit PathID precision pitfalls, Unity 2020.1.17f1 specifics.",
      },
      {
        href: "https://github.com/LittleBitUA/SWERY-Localization-Tool/blob/main/docs/THE-MISSING-modding-notes.txt",
        tag: "Modding · THE MISSING",
        title: "MSG payload + IMHeightInfo MonoBehaviour",
        body: "Full MSG layout, length-table semantics, the int16 overflow trap that breaks Cyrillic, IMHeightInfo box-sizes structure, 4-language slot convention, Auto-fit algorithm з idempotency-notes, write-back pipeline через UABEANext, шість common pitfalls. Independent implementation — без TF2 source code.",
      },
    ],
  },
  footer: {
    license: "MIT license",
    credits: "Credits:",
    made: "Made with ☕ and 🇺🇦 by",
    disclaimer: "Вміст ігор належить їхнім видавцям і цим інструментом не розповсюджується.",
  },
  scrollTop: "Наверх",
};

const en: Strings = {
  nav: { games: "Games", features: "Features", modding: "Reverse", download: "Download" },
  hero: {
    bureau: "Federal Bureau of Localization",
    title: "SWERY Localization Tool",
    subtitle: "Investigation log · case files · build manuals",
    lede: "One open-source desktop tool that bundles the entire translation workflow for five Hidetaka Suehiro (SWERY) / White Owls titles — from editing JSON dumps to packing the final patch, with built-in font, texture and per-string box-size editors.",
    download: "Download v{version} portable",
    viewSource: "View source on GitHub",
    meta: {
      period: "Investigation period:", periodValue: "2026 — current",
      license: "License:", licenseValue: "MIT",
      platform: "Platform:", platformValue: "Windows portable",
    },
  },
  stats: {
    games: "Games supported",
    formats: "Custom binary formats reversed",
    strings: "Translatable strings indexed",
    portable: "Portable, no installer",
  },
  cases: {
    tag: "Active casefiles · 001 — 005",
    title1: "Five Swery / White Owls games.",
    title2: "One workflow.",
    lede: "Each title ships with its own beautiful idiosyncratic binary format. The toolkit reverse-engineers them so you can translate, not fight files.",
    label: {
      platform: "Platform", format: "Format", editors: "Editors",
      records: "Records", tools: "Tools", engine: "Engine",
      specific: "Specific", risk: "Risk", subject: "Subject dossier",
    },
    stamp: { active: "Active", closed: "Closed" },
    items: [
      {
        no: "001", region: "NA",
        title: "Deadly Premonition", altname: "— The Director's Cut, 2013 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", ".mes / DPMsgTool"],
          ["editors", "Text · Fonts · Textures"],
          ["records", "~20,000 in mes_all.json"],
        ],
        progress: 8,
        note: "Greenvale's coffee dialogues, FONTWIDE.DDS atlas, custom XPC2 textures.",
        stamp: "active",
      },
      {
        no: "002", region: "NA",
        title: "Deadly Premonition 2", altname: "— A Blessing in Disguise, 2020 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "sharedassets / .assets"],
          ["editors", "Text · Fonts · Textures"],
          ["tools", "UABEA + PowerShell 7"],
        ],
        progress: 9,
        note: "Le Carré, bloody sky. Seven asset fonts, 22 textures, cross-game TM.",
        stamp: "active",
      },
      {
        no: "005", region: "JP",
        title: "THE MISSING", altname: "— J.J. Macfield and the Island of Memories, 2018 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "MSG.* + IMHeightInfo"],
          ["editors", "Text · Fonts · Textures · Box-sizes"],
          ["risk", "int16 overflow trap"],
        ],
        progress: 10,
        note: "Independent reverse — no TF2 source reused. Box-sizes auto-fit included.",
        stamp: "closed",
      },
      {
        no: "003", region: "JP",
        title: "The Good Life", altname: "— Rainy Woods, 2021 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "loc/English (binary)"],
          ["editors", "Text · Fonts"],
          ["engine", "Unity 2020.1.17f1"],
        ],
        progress: 7,
        note: "Custom binary container, bitmap-font with atlas painting + glyph injection.",
        stamp: "active",
      },
      {
        no: "004", region: "INT",
        title: "Hotel Barcelona", altname: "— Suda × Swery, 2025 —",
        fields: [
          ["platform", "PC · Steam"],
          ["format", "Unity Addressables bundle"],
          ["editors", "Text · Fonts"],
          ["specific", "Patch-aware hash migration"],
        ],
        progress: 8,
        note: "Bundle hash changes per patch — auto-migration of translations.",
        stamp: "active",
      },
    ],
  },
  caps: {
    tag: "What it does",
    title1: "Made by translators",
    title2: "for translators.",
    lede: "Six things the app does well — the rest is there, but this is the core.",
    items: [
      { tag: "Memory", title: "Translation Memory", body: "Shared corpus across the SWERY catalog. Exact-match lookups, apply with one click. No substring guesswork.", featured: true },
      { tag: "Editor", title: "Monaco with tag diagnostics", body: "The VS Code engine inside the app. Live placeholder diagnostics, EN↔UA diff, stable model with no remount lag." },
      { tag: "Fonts",  title: "Font atlas editor", body: "Paint Cyrillic glyphs over Latin DDS positions — snap-to-grid, Ctrl+Z, automatic glyphmap update." },
      { tag: "Layout", title: "Per-string box-sizes", body: "Each line in THE MISSING has W×H in IMHeightInfo. Auto-fit computes from the original — repeated applies don't snowball." },
      { tag: "Safety", title: "Silent corruption guards", body: "Race-free saves, integrity checks before write, int16-overflow guard. If something is off — you get a toast, not a corrupted patch." },
      { tag: "Workflow", title: "Everything at hand", body: "Auto-save, .txt round-trip for offline translators, status/bookmark sidecars, UK/EN UI, auto-update." },
    ],
  },
  quote: {
    body: "We're translating SWERY into Ukrainian.<br>The tools should respect that the work is the translation.",
    cite: "— Little Bit UA, project journal",
  },
  modding: {
    tag: "Field reports",
    title1: "Reverse-engineering",
    title2: "write-ups.",
    lede: "The hard parts of these formats are documented in plain English. Even if you don't use the app, the notes are yours.",
    open: "Open write-up →",
    items: [
      {
        href: "https://github.com/LittleBitUA/SWERY-Localization-Tool/blob/main/docs/TGL-modding-notes.txt",
        tag: "Modding · The Good Life",
        title: "Custom loc/English container + bitmap font",
        body: "Text container layout, font bundle (<code>c0718fc478f6943d</code>), <code>flipped</code> + negative-<code>uv.height</code> convention, atlas write-back, 64-bit PathID precision pitfalls, Unity 2020.1.17f1 specifics.",
      },
      {
        href: "https://github.com/LittleBitUA/SWERY-Localization-Tool/blob/main/docs/THE-MISSING-modding-notes.txt",
        tag: "Modding · THE MISSING",
        title: "MSG payload + IMHeightInfo MonoBehaviour",
        body: "Full MSG layout, length-table semantics, the int16 overflow trap that breaks Cyrillic, IMHeightInfo box-sizes structure, 4-language slot convention, Auto-fit algorithm with idempotency notes, write-back pipeline through UABEANext, six common pitfalls. Independent implementation — no TF2 source reused.",
      },
    ],
  },
  footer: {
    license: "MIT license",
    credits: "Credits:",
    made: "Made with ☕ and 🇺🇦 by",
    disclaimer: "Game content belongs to its respective publishers and is not redistributed by this tool.",
  },
  scrollTop: "Top",
};

export const strings: Record<Lang, Strings> = { uk, en };
