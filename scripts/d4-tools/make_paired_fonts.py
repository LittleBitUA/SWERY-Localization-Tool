"""
Будує main + shadow атласи парами + UFont meta для D4 шрифтів.

За GPT алгоритмом #2:
- 517 гліфів = 256 Latin (U+0000..00FF) + 256 Cyrillic (U+0400..04FF) + 5 spec.
- Multi-page packing (3 сторінки 512×512 для newcinema/_s).
- Characters/CharRemap ідентичні для main і shadow.
- Shadow atlas = main alpha → MaxFilter(2-3px) + GaussianBlur(1.2-2.0px).
- USize = advance width (з side bearings, не просто ширина чорнила).

Виходи у <out_dir>/:
  main_page0.bc3.bin, main_page1.bc3.bin, main_page2.bc3.bin
  shadow_page0.bc3.bin, ...
  main_page0.png, shadow_page0.png, ...
  meta.json — characters[], remap[], page_count, atlas_size.
"""
import json, struct, sys
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw, ImageFilter

if len(sys.argv) < 4:
    print("Usage: make_paired_fonts.py <ttf> <font_size> <out_dir> [page_w=512] [page_h=512] [num_pages=3]")
    sys.exit(1)

TTF = sys.argv[1]
FONT_SIZE = int(sys.argv[2])
OUT_DIR = Path(sys.argv[3])
PAGE_W = int(sys.argv[4]) if len(sys.argv) > 4 else 512
PAGE_H = int(sys.argv[5]) if len(sys.argv) > 5 else 512
NUM_PAGES = int(sys.argv[6]) if len(sys.argv) > 6 else 3

OUT_DIR.mkdir(parents=True, exist_ok=True)

# Параметри shadow генерації.
# Згідно GPT-аналізу RU патча: shadow має мати ~4-6× більше alpha mass за main.
# Для досягнення цього: агресивне dilation + blur + boost.
DILATE_PX = 5       # значно ширший контур (RU: ~4.3× per glyph)
BLUR_RADIUS = 2.0   # м'якша тінь по краях
SHADOW_BOOST = 2.5  # сильне підсилення alpha
SIDE_BEARING = 1
LINE_PAD = 2 * DILATE_PX + 6  # достатньо щоб shadow не зливалися

# ──────────────────────────────────────────────────────────────
# Codepoints (як у RU — 517 glyphs)
# ──────────────────────────────────────────────────────────────
def codepoints():
    # Якщо CYRILLIC_FULL=1 у env — full U+0400..04FF (як RU).
    # Інакше — UA-relevant only (для compact body).
    import os
    full = os.environ.get("CYRILLIC_FULL") == "1"
    pts = []
    pts += list(range(0x0020, 0x007F))   # ASCII
    pts += list(range(0x00A0, 0x0100))   # Latin-1
    if full:
        pts += list(range(0x0400, 0x0500))
    else:
        pts += list(range(0x0410, 0x0450))                     # А-я
        pts += [0x0401, 0x0451]                                # Ё ё
        pts += [0x0404, 0x0454, 0x0406, 0x0456,
                0x0407, 0x0457, 0x0490, 0x0491]                # UA spec
    pts += [0x2012, 0x2013, 0x2014, 0x2015, 0x2116]
    return sorted(set(pts))

# ──────────────────────────────────────────────────────────────
# Render glyph
# ──────────────────────────────────────────────────────────────
def render_glyph(font, cp, ascent):
    """Render single glyph. Returns (PIL Image RGBA with white+alpha, advance_width, vOff) or None."""
    ch = chr(cp)
    # Whitespace — placeholder з advance.
    if cp in (0x0020, 0x00A0):
        try: adv = int(font.getlength(ch))
        except: adv = FONT_SIZE // 3
        adv = max(adv, 4)
        img = Image.new("RGBA", (adv, 1), (255, 255, 255, 0))
        return img, adv, 0, adv, 1
    try: bbox = font.getbbox(ch)
    except: return None
    if not bbox: return None
    l, t, r, b = bbox
    ink_w, ink_h = r - l, b - t
    if ink_w <= 0 or ink_h <= 0: return None
    # Render у tight bbox.
    canvas = Image.new("L", (ink_w + 2, ink_h + 2), 0)
    ImageDraw.Draw(canvas).text((-l + 1, -t + 1), ch, fill=255, font=font)
    bb2 = canvas.getbbox()
    if not bb2: return None
    cropped = canvas.crop(bb2)
    cw, ch2 = cropped.size
    # Advance width = ink + 2 × side bearing (для нормальних проміжків).
    advance = cw + 2 * SIDE_BEARING
    vOff = max(0, int(ascent + t))
    rgba = Image.new("RGBA", (cw, ch2), (255, 255, 255, 0))
    rgba.putalpha(cropped)
    return rgba, advance, vOff, cw, ch2   # also raw ink w/h

# ──────────────────────────────────────────────────────────────
# Multi-page row-based packer
# ──────────────────────────────────────────────────────────────
def pack_glyphs(font, ascent, cps):
    """Pack glyphs across NUM_PAGES of size PAGE_W × PAGE_H.
    Returns list of (cp, page_idx, x, y, ink_w, ink_h, advance, vOff, image)."""
    placed = []
    cur_page = 0
    cx, cy, row_h = 0, 0, 0
    skipped = []
    for cp in cps:
        r = render_glyph(font, cp, ascent)
        if r is None:
            skipped.append(cp); continue
        gl, advance, vOff, cw, ch2 = r
        gw = max(gl.size[0], 1)
        gh = max(gl.size[1], 1)
        # Guard на початку — якщо ми вже за межами останньої сторінки (бо
        # попередній гліф переповнив), просто пропускаємо все що залишилось.
        if cur_page >= NUM_PAGES:
            skipped.append(cp); continue
        if cx + gw + LINE_PAD > PAGE_W:
            cx = 0
            cy += row_h + LINE_PAD
            row_h = 0
        if cy + gh > PAGE_H:
            # Next page.
            cur_page += 1
            cx, cy, row_h = 0, 0, 0
            if cur_page >= NUM_PAGES:
                skipped.append(cp); continue
        # Place glyph WITH side bearing offset — atlas x is bearing-left of ink.
        atlas_x = cx + SIDE_BEARING
        placed.append((cp, cur_page, atlas_x, cy, cw, ch2, advance, vOff, gl))
        cx += advance + LINE_PAD
        row_h = max(row_h, gh)
    return placed, skipped

# ──────────────────────────────────────────────────────────────
# BC3 encoder
# ──────────────────────────────────────────────────────────────
def enc_alpha(a):
    mn, mx = min(a), max(a)
    if mn == mx: return bytes([mn, mx, 0, 0, 0, 0, 0, 0])
    a0, a1 = mx, mn
    pal = [a0, a1] + [((7-i)*a0 + i*a1 + 3)//7 for i in range(1, 7)]
    bits = 0
    for i, v in enumerate(a):
        bi, bd = 0, 999
        for j, p in enumerate(pal):
            d = abs(v-p)
            if d < bd: bd, bi = d, j
        bits |= (bi & 7) << (i*3)
    b = bytearray([a0, a1])
    for i in range(6): b.append((bits >> (i*8)) & 0xFF)
    return bytes(b)

COLOR_BLOCK = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00])

def bc3_encode(rgba_bytes, W, H):
    bw, bh = (W+3)//4, (H+3)//4
    out = bytearray()
    for by in range(bh):
        for bx in range(bw):
            alphas = []
            for sy in range(4):
                for sx in range(4):
                    x, y = bx*4+sx, by*4+sy
                    if x < W and y < H:
                        alphas.append(rgba_bytes[y*W*4 + x*4 + 3])
                    else: alphas.append(0)
            out.extend(enc_alpha(alphas))
            out.extend(COLOR_BLOCK)
    return bytes(out)

# ──────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────
def main():
    font = ImageFont.truetype(TTF, FONT_SIZE)
    ascent, descent = font.getmetrics()
    print(f"Font {TTF} size={FONT_SIZE} ascent={ascent} descent={descent}")

    cps = codepoints()
    print(f"Target codepoints: {len(cps)}")

    placed, skipped = pack_glyphs(font, ascent, cps)
    print(f"Placed: {len(placed)} / Skipped: {len(skipped)}")
    if skipped:
        print(f"  WARN skipped: {skipped[:20]}")

    # Build main atlas pages.
    main_pages = [Image.new("RGBA", (PAGE_W, PAGE_H), (255, 255, 255, 0))
                  for _ in range(NUM_PAGES)]
    for cp, page, x, y, cw, ch2, adv, vOff, gl in placed:
        main_pages[page].paste(gl, (x, y))

    # Build shadow atlas pages (dilate + blur main alpha).
    shadow_pages = []
    for i, p in enumerate(main_pages):
        # Витягаємо alpha, dilate, blur.
        r, g, b, a = p.split()
        a_dilated = a.filter(ImageFilter.MaxFilter(2 * DILATE_PX + 1))
        a_blurred = a_dilated.filter(ImageFilter.GaussianBlur(BLUR_RADIUS))
        # Підсилюємо alpha трохи.
        a_boosted = a_blurred.point(lambda v: min(255, int(v * SHADOW_BOOST)))
        shadow_p = Image.new("RGBA", (PAGE_W, PAGE_H), (255, 255, 255, 0))
        shadow_p.putalpha(a_boosted)
        shadow_pages.append(shadow_p)

    # Save PNGs.
    for i, p in enumerate(main_pages):
        p.save(OUT_DIR / f"main_page{i}.png")
        p.split()[3].save(OUT_DIR / f"main_page{i}_alpha.png")
    for i, p in enumerate(shadow_pages):
        p.save(OUT_DIR / f"shadow_page{i}.png")
        p.split()[3].save(OUT_DIR / f"shadow_page{i}_alpha.png")

    # BC3 encode.
    for i, p in enumerate(main_pages):
        bc3 = bc3_encode(p.tobytes("raw", "RGBA"), PAGE_W, PAGE_H)
        (OUT_DIR / f"main_page{i}.bc3.bin").write_bytes(bc3)
    for i, p in enumerate(shadow_pages):
        bc3 = bc3_encode(p.tobytes("raw", "RGBA"), PAGE_W, PAGE_H)
        (OUT_DIR / f"shadow_page{i}.bc3.bin").write_bytes(bc3)

    # Build Characters[] and CharRemap.
    chars = []
    remap = {}
    for cp, page, x, y, cw, ch2, adv, vOff, _ in placed:
        gi = len(chars)
        chars.append({
            "startU": x,
            "startV": y,
            "uSize": adv,          # USize = advance (з side bearings)
            "vSize": ch2,
            "texIdx": page,
            "vOff": vOff,
        })
        remap[cp] = gi
    # Control chars (U+0000..U+001F) — мапимо на glyph 0 (placeholder).
    for cp in range(0, 0x20):
        remap.setdefault(cp, 0)

    # SORT remap by key ascending! (важливо за GPT)
    remap_sorted = [{"key": k, "val": v} for k, v in sorted(remap.items())]

    meta = {
        "ttf": TTF,
        "fontSize": FONT_SIZE,
        "ascent": ascent,
        "descent": descent,
        "pageCount": NUM_PAGES,
        "pageW": PAGE_W,
        "pageH": PAGE_H,
        "charactersCount": len(chars),
        "remapCount": len(remap_sorted),
        "characters": chars,
        "remap": remap_sorted,
    }
    (OUT_DIR / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"chars={len(chars)} remap={len(remap_sorted)} pages={NUM_PAGES}")
    print(f"Output: {OUT_DIR}")

if __name__ == "__main__":
    main()
