import { defineConfig } from "astro/config";

// GitHub Pages serves the repo under /<repo-name>/ — обовʼязково виставити
// base, інакше абсолютні URLs у production будуть 404.
export default defineConfig({
  site: "https://littlebitua.github.io",
  base: "/SWERY-Localization-Tool",
  // Build output → ../docs (GitHub Pages source = main branch /docs).
  // Це уникне зайвого Actions workflow: запушив новий docs/ — сторінка оновилась.
  outDir: "../docs",
  // Не вичищаємо docs повністю — там лежать modding-notes.txt files; нехай Astro
  // переписує тільки те що генерує.
  build: {
    assets: "assets",
  },
  vite: {
    build: {
      // Уникаємо JS-чанку якщо JS не потрібен взагалі для статичної сторінки.
      cssCodeSplit: false,
    },
  },
});
