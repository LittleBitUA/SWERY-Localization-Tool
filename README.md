<div align="center">

<img src="ico.png" alt="Deadly Premonition Localization Tool" width="96" height="96" />

# Deadly Premonition Localization Tool

**Універсальний редактор українізації для серії *Deadly Premonition* і *The Good Life*** &nbsp;·&nbsp;
**A unified Ukrainian-localization editor for the *Deadly Premonition* series and *The Good Life***

[![Latest Release](https://img.shields.io/github/v/release/LittleBitUA/Deadly-Premonition-Localization-Tool?style=flat-square&color=58a6ff&label=release)](https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/LittleBitUA/Deadly-Premonition-Localization-Tool/total?style=flat-square&color=3fb950)](https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases)
[![License](https://img.shields.io/badge/license-MIT-d29922?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0d1117?style=flat-square)](https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases/latest)
[![Electron](https://img.shields.io/badge/Electron-33.4-9feaf9?style=flat-square&logo=electron&logoColor=black)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square&logo=react&logoColor=black)](https://react.dev/)

### [⬇️ Завантажити останню версію / Download latest release ⬇️](https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases/latest)

</div>

---

> 🇺🇦 [**Українська**](#-українська) &nbsp;·&nbsp; 🇬🇧 [**English**](#-english)

## 🇺🇦 Українська

**Deadly Premonition Localization Tool** — настільний редактор з відкритим кодом для українізації трьох ігор Swery / White Owls: **Deadly Premonition** (Director's Cut), **Deadly Premonition 2: A Blessing in Disguise** та **The Good Life**. Один інструмент замість п'яти — від редагування JSON-дампів до запаковки готового патчу, з вбудованим редактором шрифтів і текстур.

### ✨ Можливості

**Робота з текстом**
- 🎮 **Три гри в одному хабі**: Deadly Premonition (DPMsgTool by MrIkso), Deadly Premonition 2 (UABEA-формат) і **The Good Life** (власний бінарний формат `loc/English`). Тематичний головний екран у стилі FBI-дозьє з лічильниками прогресу.
- 💾 **Запаковка одним кліком**: для DP1 — підстановка кириличних гліфів і `DPMsgTool.exe from-json`; для DP2 — `import-to-assets.ps1` через PowerShell 7 + UABEA. Готовий файл одразу у директорії гри.
- 🧠 **Пам'ять перекладів (TM)** з обох корпусів — cross-search DP1↔DP2, Jaccard fuzzy. **Bulk TM auto-fill (1:1)** — авто-заповнення неперекладених рядків з exact-match source (без substring-замін).
- 📖 **Спільний глосарій** + **перевірка термінологічної консистентності** — всюди де `src` зустрічається, `tgt` має бути присутній.
- 👤 **Перевірка консистентності імен героїв** (DP2): шукає типос-варіанти (`Йорк / Йорг`), one-click exact-equality перейменування по всіх файлах.
- 🔍 **Глобальний пошук** по корпусу: regex, case-sensitive, фільтр по полю. `Ctrl+Shift+F`.
- ♻️ **Cross-file Find & Replace** (DP2): pre-flight з прев'ю кожної заміни → confirm → execute по всіх файлах із автоматичним `.bak`.

**Якість і навігація**
- 🏷️ **Статуси і закладки**: `draft / review / approved` + 🔖. Sidecar-файли, JSON гри не чіпається.
- 📐 **Smart subtitle break ("Драбинка")**: балансує переклад у симетричні рядки без розривів слів і сирітських прийменників — per-entry та **cross-file batch** для всього корпусу.
- 🎨 **Підсвічування плейсхолдерів** (`{NEXT_SEGMENT}`, `<color=red>`, `\n`) у Monaco + live-діагностика втрачених/зайвих тегів.
- 🔤 **DP1 glyph audit**: позначає символи поза мапою підміни (74 гліфи) у редакторі + загальний аудит — production-баги до запаковки.
- 📺 **In-game preview**: рендерить активний рядок у стилі реальних субтитрів DP2 — використовується **справжній шрифт гри** (`FOT-NewCinemaAStd-D`), з курсивом `[i]…[/i]`, плейсхолдер-чіпами і ▽-маркером.
- 📊 **Огляд готовності корпусу**: підсумок % завершеності, UA/EN слова й символи, топ-15 файлів за обсягом.

**Робота зі шрифтами (DP2)**
- 🔠 **Font workshop**: окрема вкладка "Шрифти" на DP2-картці — експорт 7 ассетних шрифтів (`FOT-NewRodinProN-DB`, `FOT-NewCezannePro-DB`, `FOT-NewCezannePro-M`, `FOT-NewCinemaAStd-D`, `FOT-Wentworth`, `FOT-UDKakugo_LargePro-R`, `FOT-MatisseProN-UB`) з `resources.assets` і `sharedassets0.assets` як TTF/OTF, заміна на свій + repack у відповідний `.assets` файл із `.bak`.
- 🔬 **Live preview**: щойно експортовано — шрифт реєструється через FontFace API. Після заміни — миттєвий cache-bust і preview оновлюється без re-export з гри.

**Робота з текстурами (DP2)**
- 🖼️ **Texture workshop**: експорт PNG обличчя персонажів з `resources.assets` (DXT5/BC3 → PNG), заміна на свій + in-place patching `.assets` + `.resS` (зі збереженням offset table). 22 текстури в готовому списку (Френсіс, Сімон, родини Кларксонів, Вудс, Девіс і т.д.).
- 📦 **Export all одним кліком**: масово витягуємо всі прев'ю у `Documents\DP2-Localization-Tools\dp2-textures\`.

**Шрифти The Good Life**
- 🔡 **Bitmap-font editor**: розпаковка bundle-файлу `c0718fc478f6943d` (Unity Asset Bundle із Font + Texture2D), правка `m_CharacterRects.Array`, додавання/видалення гліфів просто на атласі.
- ✏️ **AddGlyph модалка**: вибираєш TTF з відсутніми літерами (Є є І і Ї ї Ґ ґ), задаєш ціль "Є, є, і, ..." — програма знаходить вільне місце на атласі, малює гліф з правильним Y-flip-ом, оновлює `uv`/`vert`/`advance` і запаковує назад у CAB-bundle.
- 🎯 **In-game preview** з реального атласу та `vert.x/y`-метрик — бачиш точно те, що покаже рушій.
- 🗑️ **Delete-клавіша** на вибраному гліфі: видаляє запис + затирає bitmap-ділянку прозорим прямокутником, щоб не "залипало" на атласі.
- 🌐 **Зовнішні файли локалізації**: `userData/locales/{uk,en}.json` мерджаться поверх вбудованих — інші перекладачі можуть правити рядки без перебудови програми.

**Workflow і безпека**
- 💼 **Auto-save + crash recovery**: незбережені правки скидаються у `.autosave.json` через 30с; при наступному відкритті — пропонує відновити.
- 📤 **`.txt` round-trip** для зовнішніх перекладачів (ID-based mapping, preserve-translated).
- 🔧 **Bulk-операції**: copy-original, trim, mark-approved — масово.
- 🍞 **Toast-сповіщення** у правому нижньому куті — статус-меседжі не ламають layout.
- 🌐 **Інтерфейс UK / EN** з миттєвим перемиканням.
- ⚙️ **Майстер першого запуску**: автозавантажує UABEA Next і PowerShell 7.
- 🚀 **Worker-threads + JSON cache** (LRU 300 файлів, mtime-валідація) — повторні cross-file операції миттєві.

### 📦 Швидкий старт

1. Завантаж portable `.exe` з [Releases](https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases/latest).
2. Запусти — пройди майстер налаштування (вкаже шлях до гри і автоматично завантажить інструменти).
3. На головному екрані обери гру:
   - **Deadly Premonition** → вкажи `eng.json` від DPMsgTool.
   - **Deadly Premonition 2** → відкрий теку з JSON-дампами `sharedassets0.assets`.
4. Перекладай. Натисни **Запакувати .mes** (DP1) або **Зберегти та зібрати** (DP2) — готовий файл одразу опиняється у грі.

### 🛠️ Шорткати

| Дія | Шорткат |
| --- | --- |
| Зберегти + наступний неперекладений | `Ctrl+Enter` |
| Наступний неперекладений | `Ctrl+J` |
| Між рядками таблиці | `Alt+↑/↓` |
| Копіювати оригінал | `Ctrl+D` |
| Зберегти | `Ctrl+S` |
| Find & Replace у файлі | `Ctrl+H` |
| Глобальний пошук | `Ctrl+Shift+F` |
| Глосарій | `Ctrl+G` |
| TM-панель (toggle) | `Ctrl+Shift+T` |
| Focus mode | `Ctrl+\` |
| Закладка | `Ctrl+B` |
| Статус draft / review / approved | `Alt+1` / `Alt+2` / `Alt+3` |

### 🧩 Збірка з джерел

```bash
git clone https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool.git
cd Deadly-Premonition-Localization-Tool
npm install
npm run dev          # Vite + Electron у dev-режимі
npm run build:exe    # Portable .exe → release/
```

Потрібно: Node.js 18+ та Windows для збірки портативного `.exe`.

---

## 🇬🇧 English

**Deadly Premonition Localization Tool** is an open-source desktop editor that bundles the entire translation workflow for three Swery / White Owls titles: **Deadly Premonition** (Director's Cut), **Deadly Premonition 2: A Blessing in Disguise** and **The Good Life**. One app instead of five — from editing JSON dumps to packing the final patch, with a built-in font and texture workshop.

### ✨ Features

**Text workflow**
- 🎮 **Three games in one hub**: Deadly Premonition (via [DPMsgTool by MrIkso](https://github.com/MrIkso/DPMsgTool)), Deadly Premonition 2 (UABEA format) and **The Good Life** (custom binary `loc/English` container). Themed FBI-dossier home screen with progress counters.
- 💾 **One-click packing**: DP1 — cyrillic glyph substitution + `DPMsgTool.exe from-json`; DP2 — `import-to-assets.ps1` via PowerShell 7 + UABEA. Output goes straight into the game directory.
- 🧠 **Translation Memory (TM)** across both corpora — DP1↔DP2 cross-search with Jaccard fuzzy match. **Bulk TM auto-fill (1:1)** — auto-applies exact source matches (no substring guesswork).
- 📖 **Shared glossary** + **terminology consistency check**: where `src` appears, `tgt` must be present.
- 👤 **Character name consistency** (DP2): detects typo variants (`Йорк / Йорг`), one-click exact-equality rename across all files.
- 🔍 **Global search** across the corpus: regex, case sensitive, field filter (JP / EN / UA / speaker). `Ctrl+Shift+F`.
- ♻️ **Cross-file Find & Replace** (DP2): preview each change → confirm → batch-apply across all files with automatic `.bak`.

**Quality & navigation**
- 🏷️ **Statuses & bookmarks**: `draft / review / approved` + 🔖. Stored in sidecar files — game JSON stays untouched.
- 📐 **Smart subtitle break ("Драбинка")**: balances translation into symmetric lines — no word splits, no orphan prepositions. Per-entry button + cross-file batch.
- 🎨 **Placeholder highlighting** (`{NEXT_SEGMENT}`, `<color=red>`, `\n` etc.) in Monaco + live diagnostics for missing/extra tags.
- 🔤 **DP1 glyph audit**: flags characters outside the 74-glyph substitution map in the editor + corpus-wide audit — catches production bugs before packing.
- 📺 **In-game preview**: renders the active row in DP2 subtitle style — uses the **real game font** (`FOT-NewCinemaAStd-D`) with italic `[i]…[/i]`, placeholder chips and ▽ marker.
- 📊 **Corpus readiness overview**: % completion, UA/EN word & char counts, top-15 files by volume.

**Font workshop (DP2)**
- 🔠 **Font workshop**: dedicated "Fonts" tab on the DP2 card — export 7 asset fonts (`FOT-NewRodinProN-DB`, `FOT-NewCezannePro-DB`, `FOT-NewCezannePro-M`, `FOT-NewCinemaAStd-D`, `FOT-Wentworth`, `FOT-UDKakugo_LargePro-R`, `FOT-MatisseProN-UB`) from `resources.assets` and `sharedassets0.assets` as TTF/OTF, replace with your own + repack into the matching `.assets` file with `.bak`.
- 🔬 **Live preview**: as soon as exported, fonts are registered via FontFace API. After Replace — instant cache-bust so the new font shows up without a re-export from the game.

**Texture workshop (DP2)**
- 🖼️ **Texture workshop**: export PNG character portraits from `resources.assets` (DXT5/BC3 → PNG), replace + in-place patch the `.assets` + `.resS` pair (offset table preserved). 22 textures shipped in the list (Francis, Simon, Clarkson family, Woods, Davis etc.).
- 📦 **Export all in one click**: dumps all previews into `Documents\DP2-Localization-Tools\dp2-textures\`.

**The Good Life fonts**
- 🔡 **Bitmap-font editor**: unpacks the `c0718fc478f6943d` bundle (Unity Asset Bundle with Font + Texture2D), edits `m_CharacterRects.Array`, add/remove glyphs directly on the atlas.
- ✏️ **AddGlyph modal**: pick a TTF that has the missing letters (Є є І і Ї ї Ґ ґ), enter a target list "Є, є, і, …" — the app locates a free atlas region, Y-flips the bitmap correctly, fills in `uv` / `vert` / `advance` and re-packs into the CAB bundle.
- 🎯 **In-game preview** uses the real atlas and `vert.x/y` metrics — you see exactly what the engine renders.
- 🗑️ **Delete key** on a selected glyph: removes the record and clears the bitmap region with a transparent rectangle so leftover pixels don't bleed.
- 🌐 **External locale files**: `userData/locales/{uk,en}.json` are merged on top of the built-in dictionary, so translators can edit strings without rebuilding the app.

**Workflow & safety**
- 💼 **Auto-save + crash recovery**: unsaved edits flush to `.autosave.json` every 30s; on reload, the app offers to restore.
- 📤 **`.txt` round-trip** for external translators (ID-based mapping, preserve-translated).
- 🔧 **Bulk operations**: copy-original, trim, mark-approved — across selection.
- 🍞 **Toast notifications** in the bottom-right corner — status messages never break header layout.
- 🌐 **UK / EN UI** with instant switching.
- ⚙️ **First-run wizard**: auto-downloads UABEA Next and PowerShell 7.
- 🚀 **Worker threads + JSON cache** (LRU 300 files, mtime validation) — repeated cross-file ops are instant.

### 📦 Quick start

1. Download the portable `.exe` from [Releases](https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases/latest).
2. Launch — the first-run wizard will set paths and download dependencies.
3. On the home screen pick a game:
   - **Deadly Premonition** → point to DPMsgTool's `eng.json`.
   - **Deadly Premonition 2** → open the folder with `sharedassets0.assets` JSON dumps.
4. Translate. Press **Build .mes** (DP1) or **Save & build** (DP2) — the file lands in the game directory.

### 🛠️ Shortcuts

| Action | Shortcut |
| --- | --- |
| Save + jump to next untranslated | `Ctrl+Enter` |
| Next untranslated | `Ctrl+J` |
| Move between rows | `Alt+↑/↓` |
| Copy original | `Ctrl+D` |
| Save | `Ctrl+S` |
| Find & Replace in file | `Ctrl+H` |
| Global search | `Ctrl+Shift+F` |
| Glossary | `Ctrl+G` |
| TM panel (toggle) | `Ctrl+Shift+T` |
| Focus mode | `Ctrl+\` |
| Bookmark | `Ctrl+B` |
| Status draft / review / approved | `Alt+1` / `Alt+2` / `Alt+3` |

### 🧩 Build from source

```bash
git clone https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool.git
cd Deadly-Premonition-Localization-Tool
npm install
npm run dev          # Vite + Electron in dev mode
npm run build:exe    # Portable .exe → release/
```

Requires Node.js 18+ and Windows for the portable `.exe` artifact.

---

## 📚 Modding notes

- [`docs/TGL-modding-notes.txt`](docs/TGL-modding-notes.txt) — reverse-engineering write-up for The Good Life: text container layout (`loc/English`), font bundle structure (`c0718fc478f6943d`), the `flipped` + negative-`uv.height` convention that catches every home-grown tool, atlas write-back pipeline, 64-bit PathID precision pitfalls, and Unity 2020.1.17f1 specifics. Useful even if you don't use this app — written for anyone building their own modding tools.

## 🧱 Tech Stack

- [Electron](https://www.electronjs.org/) 33 (portable build via `electron-builder`)
- [React](https://react.dev/) 18 + [Zustand](https://zustand-demo.pmnd.rs/) for state
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) (VS Code's engine) as the translation editor
- [Tailwind CSS](https://tailwindcss.com/) — GitHub-inspired dark theme
- [Vite](https://vitejs.dev/) for blazing-fast dev cycles
- Node `worker_threads` for heavy JSON parsing / searches

## 🙏 Credits

- [MrIkso/DPMsgTool](https://github.com/MrIkso/DPMsgTool) — the `.mes`↔JSON CLI for DP1, used as-is for packing.
- [nesrak1/UABEA](https://github.com/nesrak1/UABEA) — Unity asset editor whose libraries (`AssetsTools.NET.dll`, `classdata.tpk`) drive DP2 packing.
- [PowerShell/PowerShell](https://github.com/PowerShell/PowerShell) — PS7 portable bundled at first run.
- Команда **Little Bit UA** — за ідеї, фідбек і нескінченні підказки в процесі розробки.

## 📜 License

[MIT](LICENSE) — free for personal and team use. Game content (`.assets`, `.mes`) belongs to the respective publishers and is **not** redistributed by this tool.

---

<div align="center">

Made with ☕ and 🇺🇦 by **Little Bit UA**

</div>
