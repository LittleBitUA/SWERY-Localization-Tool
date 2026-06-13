"""
Генерує talkfont атласи (atlas 0 + atlas 1) з вибраного TTF і пакує:
  - atlas 0 (508×512) — повний Latin + Latin-1 (приблизно як оригінал).
  - atlas 1 (512×1024) — Latin + повна Cyrillic (U+0400..U+04FF) + укр. extra.

Виходи:
  - <out>/atlas0.bc3.bin  + atlas0.png
  - <out>/atlas1.bc3.bin  + atlas1.png
  - <out>/talkfont_meta.json  — Characters масив, CharRemap, EmScale, ...

BC3 encoder: оскільки RGB = constant white (0xFFFFFF), color-block тривіальний:
  c0=0xFFFF c1=0xFFFF indices=0 -> bytes  FF FF FF FF 00 00 00 00
Alpha-block (BC4 form): real 2-endpoint encoder.
"""

import json
import struct
import sys
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw

# ──────────────────────────────────────────────────────────────
# Параметри
# ──────────────────────────────────────────────────────────────
TTF = r"F:/My.ttf"
OUT_DIR = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA")
OUT_DIR.mkdir(parents=True, exist_ok=True)

ATLAS0_W, ATLAS0_H = 508, 512
ATLAS1_W, ATLAS1_H = 512, 1024
FONT_SIZE = 32          # render-size — менший, щоб все вліло в atlas 0
GLYPH_PAD = 2           # padding між гліфами

# Якщо SINGLE_ATLAS=True — всю кирилицю кладемо в atlas 0 (атлас 1 не чіпаємо).
SINGLE_ATLAS = True

# ──────────────────────────────────────────────────────────────
# Кодпойнти
# ──────────────────────────────────────────────────────────────
def latin_codepoints():
    """Базова Latin + Latin-1: U+0020..U+007E + U+00A0..U+00FF."""
    pts = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100))
    return pts

def cyrillic_codepoints():
    """Український + Російський алфавіт + spec.
    Уникаємо повного U+0400..04FF (там багато гліфів, яких у TTF немає)."""
    pts = []
    # Українські великі: Є І Ї Ґ (та інші) + А-Я + Ё.
    pts += [0x0401, 0x0404, 0x0406, 0x0407, 0x0490]           # Ё Є І Ї Ґ
    pts += list(range(0x0410, 0x0450))                          # А-я
    pts += [0x0451, 0x0454, 0x0456, 0x0457, 0x0491]           # ё є і ї ґ
    # Spec.
    pts += [0x2012, 0x2013, 0x2014, 0x2015, 0x2116]
    return sorted(set(pts))

# ──────────────────────────────────────────────────────────────
# Рендер одного гліфа: повертає (W×H тільки) RGBA з RGB=255,255,255
# і alpha = ink coverage. Також (vOff) — offset baseline.
# ──────────────────────────────────────────────────────────────
def render_glyph(font, codepoint, ascent):
    ch = chr(codepoint)
    # Whitespace без ink: повертаємо порожній 1×1 placeholder з advance width.
    if codepoint in (0x20, 0xA0):
        try:
            advance = int(font.getlength(ch))
        except Exception:
            advance = FONT_SIZE // 3
        # 1-px прозорий gliph, але запам'ятовуємо ширину advance як uSize.
        rgba = Image.new("RGBA", (max(advance, 4), 1), (255, 255, 255, 0))
        return rgba, 0
    try:
        bbox = font.getbbox(ch)
    except Exception:
        return None
    if not bbox:
        return None
    l, t, r, b = bbox
    w, h = r - l, b - t
    if w <= 0 or h <= 0:
        return None
    canvas = Image.new("L", (w + 2, h + 2), 0)
    draw = ImageDraw.Draw(canvas)
    draw.text((-l + 1, -t + 1), ch, fill=255, font=font)
    bbox2 = canvas.getbbox()
    if not bbox2:
        return None
    cropped = canvas.crop(bbox2)
    cw, ch2 = cropped.size
    vOff = max(0, int(ascent + t))
    rgba = Image.new("RGBA", (cw, ch2), (255, 255, 255, 0))
    rgba.putalpha(cropped)
    return rgba, vOff

# ──────────────────────────────────────────────────────────────
# Простий row-packer: розміщає гліфи послідовно у вільне місце.
# Повертає список (codepoint, x, y, w, h, vOff).
# ──────────────────────────────────────────────────────────────
def pack_atlas(font, ascent, codepoints, atlas_w, atlas_h):
    placed = []
    cx, cy, row_h = 0, 0, 0
    skipped = []
    for cp in codepoints:
        r = render_glyph(font, cp, ascent)
        if r is None:
            skipped.append(cp)
            continue
        glyph, vOff = r
        gw, gh = glyph.size
        if cx + gw + GLYPH_PAD > atlas_w:
            cx = 0
            cy += row_h + GLYPH_PAD
            row_h = 0
        if cy + gh > atlas_h:
            skipped.append(cp)
            continue
        placed.append((cp, cx, cy, gw, gh, vOff, glyph))
        cx += gw + GLYPH_PAD
        row_h = max(row_h, gh)
    return placed, skipped

# ──────────────────────────────────────────────────────────────
# BC3 encoder
# ──────────────────────────────────────────────────────────────
def encode_alpha_block(alphas):
    """16 alphas (0..255). Повертає 8 байт BC4-like alpha block."""
    a_min = min(alphas)
    a_max = max(alphas)
    if a_min == a_max:
        # Однорідний блок — кодуємо як alpha0=alpha1=значення, всі indices=0.
        b = bytearray()
        b.append(a_min)
        b.append(a_max)
        b.extend([0] * 6)
        return bytes(b)
    a0 = a_max
    a1 = a_min
    # 8-точковий gradient: a0, a1, (6*a0+1*a1)/7, ..., (1*a0+6*a1)/7
    palette = [a0, a1]
    for i in range(1, 7):
        v = ((7 - i) * a0 + i * a1 + 3) // 7
        palette.append(v)
    # Знаходимо найближчий індекс для кожного alpha.
    indices = []
    for a in alphas:
        best_idx = 0
        best_diff = 1e9
        for i, p in enumerate(palette):
            d = abs(a - p)
            if d < best_diff:
                best_diff = d
                best_idx = i
        indices.append(best_idx)
    # Пакуємо 16 3-бітних індексів у 6 байт.
    bits = 0
    for i, idx in enumerate(indices):
        bits |= (idx & 7) << (i * 3)
    b = bytearray()
    b.append(a0)
    b.append(a1)
    for i in range(6):
        b.append((bits >> (i * 8)) & 0xFF)
    return bytes(b)

# Color-block: RGB constant white.
COLOR_BLOCK = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00])

def encode_bc3(rgba_bytes, width, height):
    """rgba_bytes — bytes у форматі BGRA (як texture2ddecoder.decode_bc3 видає).
    Будемо очікувати RGBA натомість — для зрозумілості.
    Повертає BC3 stream."""
    # BC3 storage: блоки 4x4, по 16 байт кожен (8 alpha + 8 color).
    # Розміри округлюються до кратних 4.
    bw = (width + 3) // 4
    bh = (height + 3) // 4
    out = bytearray()
    # Розпакуємо rgba_bytes у 2D масив.
    px_per_row = width * 4
    for by in range(bh):
        for bx in range(bw):
            alphas = []
            for sy in range(4):
                for sx in range(4):
                    x = bx * 4 + sx
                    y = by * 4 + sy
                    if x < width and y < height:
                        idx = y * px_per_row + x * 4
                        # RGBA: a at +3.
                        alphas.append(rgba_bytes[idx + 3])
                    else:
                        alphas.append(0)
            out.extend(encode_alpha_block(alphas))
            out.extend(COLOR_BLOCK)
    return bytes(out)

# ──────────────────────────────────────────────────────────────
# Головна логіка
# ──────────────────────────────────────────────────────────────
def main():
    font = ImageFont.truetype(TTF, FONT_SIZE)
    # PIL ascent/descent з font.getmetrics().
    ascent, descent = font.getmetrics()
    print(f"Font {TTF} size={FONT_SIZE} ascent={ascent} descent={descent}")

    if SINGLE_ATLAS:
        # Все в atlas 0: Latin + Cyrillic + spec.
        all_cp = latin_codepoints() + cyrillic_codepoints()
        atlas0_glyphs, skip0 = pack_atlas(font, ascent, all_cp,
                                          ATLAS0_W, ATLAS0_H)
        print(f"Atlas 0 (single): {len(atlas0_glyphs)} placed, {len(skip0)} skipped")
        if skip0:
            print(f"  WARN skipped: {skip0[:30]}")
        atlas1_glyphs = []
    else:
        atlas0_glyphs, skip0 = pack_atlas(font, ascent, latin_codepoints(),
                                          ATLAS0_W, ATLAS0_H)
        print(f"Atlas 0: {len(atlas0_glyphs)} placed, {len(skip0)} skipped")
        atlas1_codepoints = latin_codepoints() + cyrillic_codepoints()
        atlas1_glyphs, skip1 = pack_atlas(font, ascent, atlas1_codepoints,
                                          ATLAS1_W, ATLAS1_H)
        print(f"Atlas 1: {len(atlas1_glyphs)} placed, {len(skip1)} skipped")

    # Будуємо composite PNG-и.
    atlas0_img = Image.new("RGBA", (ATLAS0_W, ATLAS0_H), (255, 255, 255, 0))
    for cp, x, y, w, h, vOff, gl in atlas0_glyphs:
        atlas0_img.paste(gl, (x, y))
    atlas0_img.save(OUT_DIR / "atlas0.png")

    atlas1_img = Image.new("RGBA", (ATLAS1_W, ATLAS1_H), (255, 255, 255, 0))
    for cp, x, y, w, h, vOff, gl in atlas1_glyphs:
        atlas1_img.paste(gl, (x, y))
    atlas1_img.save(OUT_DIR / "atlas1.png")

    # BC3 encode.
    atlas0_bgr = atlas0_img.tobytes("raw", "RGBA")
    atlas1_bgr = atlas1_img.tobytes("raw", "RGBA")
    print("Encoding BC3 atlas 0...")
    bc0 = encode_bc3(atlas0_bgr, ATLAS0_W, ATLAS0_H)
    print(f"  -> {len(bc0)} bytes (expected {((ATLAS0_W + 3) // 4) * ((ATLAS0_H + 3) // 4) * 16})")
    (OUT_DIR / "atlas0.bc3.bin").write_bytes(bc0)
    print("Encoding BC3 atlas 1...")
    bc1 = encode_bc3(atlas1_bgr, ATLAS1_W, ATLAS1_H)
    print(f"  -> {len(bc1)} bytes (expected {((ATLAS1_W + 3) // 4) * ((ATLAS1_H + 3) // 4) * 16})")
    (OUT_DIR / "atlas1.bc3.bin").write_bytes(bc1)

    # Будуємо Characters масив + CharRemap.
    # Кожен codepoint -> glyph index. Спочатку всі atlas-0 гліфи (texIdx=0),
    # потім atlas-1 гліфи (texIdx=1).
    characters = []
    remap = {}    # codepoint -> glyph_idx
    for cp, x, y, w, h, vOff, _ in atlas0_glyphs:
        gi = len(characters)
        characters.append({
            "startU": x, "startV": y,
            "uSize": w, "vSize": h,
            "texIdx": 0, "vOff": vOff,
        })
        if cp not in remap:
            remap[cp] = gi
    for cp, x, y, w, h, vOff, _ in atlas1_glyphs:
        gi = len(characters)
        characters.append({
            "startU": x, "startV": y,
            "uSize": w, "vSize": h,
            "texIdx": 1, "vOff": vOff,
        })
        # Для cyrillic — обов'язково оновити (atlas 1 єдине місце).
        if cp not in remap or cp >= 0x0400:
            remap[cp] = gi
    # Додаємо identity-стаб для U+0000..U+001F (управляючі) — мапимо на glyph 0.
    for cp in range(0, 0x20):
        remap.setdefault(cp, 0)

    meta = {
        "ttf": TTF,
        "fontSize": FONT_SIZE,
        "ascent": ascent,
        "descent": descent,
        "atlasWH": [[ATLAS0_W, ATLAS0_H], [ATLAS1_W, ATLAS1_H]],
        "characters": characters,
        "remap": [{"key": k, "val": v} for k, v in sorted(remap.items())],
    }
    (OUT_DIR / "talkfont_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Total characters: {len(characters)}")
    print(f"Total remap entries: {len(remap)}")
    print(f"Output dir: {OUT_DIR}")

if __name__ == "__main__":
    main()
