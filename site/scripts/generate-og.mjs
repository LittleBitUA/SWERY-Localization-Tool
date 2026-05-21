// Одноразовий генератор Open Graph картинки 1200×630 для соціальних preview.
// SVG складається тут inline + sharp конвертує у PNG. Запуск:
//   node scripts/generate-og.mjs
// (sharp потрібен лише на час генерації; кінцевий public/og.png — статичний).

import { writeFileSync } from "node:fs";
import sharp from "sharp";

const W = 1200, H = 630;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <radialGradient id="warm" cx="22%" cy="20%" r="80%">
      <stop offset="0%" stop-color="#3a1c14"/>
      <stop offset="100%" stop-color="#0a0806"/>
    </radialGradient>
    <radialGradient id="stamp" cx="78%" cy="78%" r="65%">
      <stop offset="0%" stop-color="rgba(168,42,37,0.16)"/>
      <stop offset="100%" stop-color="rgba(168,42,37,0)"/>
    </radialGradient>
    <pattern id="grain" x="0" y="0" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(115)">
      <rect width="3" height="3" fill="transparent"/>
      <rect width="1" height="1" fill="rgba(255,255,255,0.03)"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#warm)"/>
  <rect width="${W}" height="${H}" fill="url(#stamp)"/>
  <rect width="${W}" height="${H}" fill="url(#grain)"/>

  <!-- Vignette frame (top + bottom thin lines) -->
  <line x1="64" y1="64" x2="${W - 64}" y2="64" stroke="rgba(216,200,154,0.4)" stroke-width="1"/>
  <line x1="64" y1="${H - 64}" x2="${W - 64}" y2="${H - 64}" stroke="rgba(216,200,154,0.4)" stroke-width="1"/>

  <!-- Bureau mark (top center, between lines) -->
  <text x="${W / 2}" y="100"
        font-family="Consolas, 'Cascadia Mono', monospace"
        font-size="18" letter-spacing="6" font-weight="700"
        fill="#d8c89a" text-anchor="middle" opacity="0.85">
    FEDERAL  BUREAU  OF  LOCALIZATION
  </text>

  <!-- Title -->
  <text x="${W / 2}" y="280"
        font-family="Constantia, Cambria, Charter, Georgia, serif"
        font-size="98" font-style="italic" font-weight="700"
        fill="#f0e4cc" text-anchor="middle">
    SWERY Localization Tool
  </text>

  <!-- Subtitle / case-marker -->
  <text x="${W / 2}" y="340"
        font-family="Consolas, monospace"
        font-size="20" letter-spacing="3" font-weight="500"
        fill="#a8997f" text-anchor="middle">
    INVESTIGATION  LOG  ·  CASE  FILES  ·  BUILD  MANUALS
  </text>

  <!-- Description -->
  <text x="${W / 2}" y="420"
        font-family="Constantia, Cambria, Georgia, serif"
        font-size="26" font-style="italic"
        fill="#d8cbb5" text-anchor="middle">
    One desktop app instead of five —
  </text>
  <text x="${W / 2}" y="456"
        font-family="Constantia, Cambria, Georgia, serif"
        font-size="26" font-style="italic"
        fill="#d8cbb5" text-anchor="middle">
    text · fonts · textures · per-string box sizes.
  </text>

  <!-- Five games row -->
  <g font-family="Consolas, monospace" font-size="16" letter-spacing="2" font-weight="700" fill="#a82a25">
    <text x="${W / 2}" y="540" text-anchor="middle" opacity="0.95">
      DEADLY PREMONITION  ·  DP2  ·  THE GOOD LIFE  ·  HOTEL BARCELONA  ·  THE MISSING
    </text>
  </g>

  <!-- Red stamp top-right -->
  <g transform="translate(${W - 220} 130) rotate(-8)">
    <rect x="-3" y="-3" width="160" height="48" fill="none"
          stroke="rgba(168,42,37,0.85)" stroke-width="3"/>
    <rect x="0" y="0" width="160" height="48" fill="none"
          stroke="rgba(168,42,37,0.85)" stroke-width="3"/>
    <text x="80" y="33"
          font-family="Consolas, monospace" font-size="22"
          font-weight="900" letter-spacing="4"
          fill="rgba(168,42,37,0.92)" text-anchor="middle">
      v1.0
    </text>
  </g>
</svg>`;

const png = await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9 })
  .toBuffer();

writeFileSync("public/og.png", png);
console.log("Wrote public/og.png (" + png.length + " bytes)");
