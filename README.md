<div align="center">

<img src="ico.png" alt="Deadly Premonition Localization Tool" width="96" height="96" />

# Deadly Premonition Localization Tool

**Універсальний редактор українізації для серії *Deadly Premonition*** &nbsp;·&nbsp;
**A unified Ukrainian-localization editor for the *Deadly Premonition* series**

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

**Deadly Premonition Localization Tool** — настільний редактор з відкритим кодом для українізації обох частин серії *Deadly Premonition* (Director's Cut та *A Blessing in Disguise*). Один інструмент замість трьох-чотирьох — від редагування JSON-дампів до запаковки готового патчу.

### ✨ Можливості

- 🎮 **Дві гри в одному**: Deadly Premonition (DPMsgTool by MrIkso) і Deadly Premonition 2 (UABEA-формат). Загальний хаб з вибором гри на старті.
- 💾 **Запаковка одним кліком**: для DP1 — підстановка кириличних гліфів і виклик `DPMsgTool.exe from-json`; для DP2 — `import-to-assets.ps1` через PowerShell 7 + UABEA. Готовий файл переноситься у директорію гри автоматично.
- 🧠 **Пам'ять перекладів (TM)** з обох корпусів одночасно — DP1↔DP2 cross-search, fuzzy-збіги через Jaccard.
- 📖 **Спільний глосарій** + автопідсвічування термінів у активному рядку.
- 🔍 **Глобальний пошук** по всьому корпусу: regex, case-sensitive, фільтр по полю (JP / EN / UA / ім'я). `Ctrl+Shift+F`.
- ✅ **Pre-flight перевірки** перед запаковкою: порожні переклади, невідповідність `\n`, втрачені inline-теги.
- 🏷️ **Статуси і закладки**: `draft / review / approved` + 🔖. Зберігаються у sidecar-файлах, JSON гри не зачіпається.
- 🎨 **Підсвічування плейсхолдерів** (`{NEXT_SEGMENT}`, `<color=red>`, `\n` тощо) у Monaco з live-діагностикою втрачених тегів.
- 📤 **Експорт у `.txt`** з round-trip safe форматом — переклад зовнішньому перекладачу і назад без втрат.
- 📊 **Метрики продуктивності**: рядки/слова за сесію + щоденний акумулятор.
- 🔧 **Bulk-операції**: масово копіювати оригінал, trim, позначити як approved.
- 🌐 **Інтерфейс UK / EN** з миттєвим перемиканням.
- ⚙️ **Майстер першого запуску**: автозавантажує UABEA Next з [github.com/nesrak1/UABEA](https://github.com/nesrak1/UABEA) і PowerShell 7 з [github.com/PowerShell/PowerShell](https://github.com/PowerShell/PowerShell) одним кліком.
- 🚀 **Worker-threads** для важких операцій (пошук, TM, валідація) — UI ніколи не блокується.

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

**Deadly Premonition Localization Tool** is an open-source desktop editor that bundles the entire translation workflow for both games in the *Deadly Premonition* series (Director's Cut and *A Blessing in Disguise*). One app instead of three or four — from editing JSON dumps to packing the final patch.

### ✨ Features

- 🎮 **Two games in one hub**: Deadly Premonition (via [DPMsgTool by MrIkso](https://github.com/MrIkso/DPMsgTool)) and Deadly Premonition 2 (UABEA format). Pick a game on launch.
- 💾 **One-click packing**: DP1 — cyrillic glyph substitution + `DPMsgTool.exe from-json`; DP2 — `import-to-assets.ps1` via PowerShell 7 + UABEA. Output is dropped into the game directory automatically.
- 🧠 **Translation Memory (TM)** across both corpora — DP1↔DP2 cross-search with Jaccard fuzzy match.
- 📖 **Shared glossary** with live highlighting in the active row.
- 🔍 **Global search** across the whole corpus: regex, case sensitive, field filter (JP / EN / UA / speaker). `Ctrl+Shift+F`.
- ✅ **Pre-flight checks** before packing: empty translations, `\n` mismatches, missing inline tags.
- 🏷️ **Statuses & bookmarks**: `draft / review / approved` + 🔖. Stored in sidecar files — game JSON stays untouched.
- 🎨 **Placeholder highlighting** (`{NEXT_SEGMENT}`, `<color=red>`, `\n` etc.) in Monaco with live diagnostics for missing/extra tags.
- 📤 **`.txt` round-trip export/import** — send to an external translator and get it back losslessly.
- 📊 **Session metrics**: rows/words per session + per-day accumulator.
- 🔧 **Bulk operations**: copy original into translation, trim, mark as approved — all multi-row.
- 🌐 **UK / EN interface** with instant switching.
- ⚙️ **First-run wizard**: auto-downloads UABEA Next from [github.com/nesrak1/UABEA](https://github.com/nesrak1/UABEA) and PowerShell 7 from [github.com/PowerShell/PowerShell](https://github.com/PowerShell/PowerShell).
- 🚀 **Worker threads** for heavy operations (search, TM, validation) — the UI never blocks.

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
