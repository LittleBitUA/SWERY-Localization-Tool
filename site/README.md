# SWERY Localization Tool — landing site

Astro 4 static site, served on GitHub Pages as the project landing page.

## Layout

```
site/
  src/
    pages/index.astro          ← entry point (composition only)
    layouts/BaseLayout.astro   ← <html>, <head>, scroll/tab scripts
    components/                ← every section is its own .astro file
      Nav.astro
      Hero.astro
      Stats.astro
      Cases.astro              ← 5 dossier folders (Deadly Premonition … THE MISSING)
      Capabilities.astro       ← 12 feature cards
      Quote.astro
      Workshop.astro           ← tabbed code samples (text pipeline / fonts / MSG / architecture)
      Workflow.astro           ← 4 daily-workflow panels
      Modding.astro            ← 2 reverse-engineering writeups
      Shortcuts.astro          ← keyboard table
      TechStack.astro
      FinalCTA.astro
      Footer.astro
    styles/global.css          ← single stylesheet, scoped to the page
  public/                       ← static assets (currently empty)
  astro.config.mjs
  package.json
  tsconfig.json
```

## Develop

```bash
cd site
npm install
npm run dev          # http://localhost:4321/SWERY-Localization-Tool/
```

Hot-reload on every `.astro`/`.css` change.

## Build → GitHub Pages

The build output goes **straight into `../docs/`** (configured via `outDir`
in `astro.config.mjs`), because GitHub Pages can serve from `main` branch
`/docs` folder without any GitHub Actions workflow.

```bash
cd site
npm run build
```

After build, commit and push:

```bash
git add docs/
git commit -m "site: rebuild"
git push
```

**One-time GitHub Pages setup:**
1. Repo → **Settings** → **Pages**.
2. **Source**: `Deploy from a branch`.
3. **Branch**: `main` · `/docs` · **Save**.
4. Wait ~30s, the page goes live at:
   `https://littlebitua.github.io/SWERY-Localization-Tool/`

## Editing content

- **New game** → edit `src/components/Cases.astro`, append to the `cases` array.
- **New feature** → edit `src/components/Capabilities.astro`, append to `caps`.
- **New writeup** → edit `src/components/Modding.astro`, append to `reports`.
- **New shortcut** → edit `src/components/Shortcuts.astro`, append to `shortcuts`.
- **Theme colors** → `src/styles/global.css` `:root` variables — same names as
  the in-app HomeV2 (`--paper`, `--stamp`, `--ink-strong`, etc.).

The download button's version label lives in **two** places:
`src/components/Hero.astro` and `src/components/FinalCTA.astro`.
Bump them on each release.

## Why Astro?

Pure static HTML in the end (`docs/index.html` + `docs/assets/...`). Zero
runtime JS except the small reveal-on-scroll + tab-switcher snippet embedded
by `BaseLayout.astro`. Components let us split a 1000-line page into chunks
that read in 30 seconds each, without dragging in a framework runtime.
