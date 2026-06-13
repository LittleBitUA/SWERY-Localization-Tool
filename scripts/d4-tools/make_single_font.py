"""
Single-page UFont generator — для шрифтів без drop-shadow пари.
Render TTF → 1 atlas (512×512 за замовчуванням) → BC3 АБО PF_G8 + meta.json.

Usage: make_single_font.py <ttf> <font_size> <atlas_w> <atlas_h> <out_dir> [format=BC3|G8]
"""
import json, struct, sys
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw

if len(sys.argv) < 6:
    print("Usage: make_single_font.py <ttf> <font_size> <atlas_w> <atlas_h> <out_dir> [format=BC3|G8]")
    sys.exit(1)

TTF = sys.argv[1]
FONT_SIZE = int(sys.argv[2])
ATLAS_W = int(sys.argv[3])
ATLAS_H = int(sys.argv[4])
OUT_DIR = Path(sys.argv[5])
OUT_FORMAT = (sys.argv[6] if len(sys.argv) > 6 else "BC3").upper()
if OUT_FORMAT not in ("BC3", "G8"):
    print(f"unsupported format: {OUT_FORMAT}"); sys.exit(1)
OUT_DIR.mkdir(parents=True, exist_ok=True)

SIDE_BEARING = 1
LINE_PAD = 2

def codepoints():
    # Обмежений набір для шрифтів з малим UFont body (consola тощо).
    # ASCII + Latin-1 + UA-relevant cyrillic + spec.
    pts = []
    pts += list(range(0x0020, 0x007F))    # ASCII 95
    pts += list(range(0x00A0, 0x0100))    # Latin-1 96
    pts += list(range(0x0410, 0x0450))    # А-я 64
    pts += [0x0401, 0x0451]                # Ё ё
    pts += [0x0404, 0x0454, 0x0406, 0x0456, 0x0407, 0x0457, 0x0490, 0x0491]  # UA spec
    pts += [0x2012, 0x2013, 0x2014, 0x2015, 0x2116]
    return sorted(set(pts))

def render_glyph(font, cp, ascent):
    ch = chr(cp)
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
    w, h = r - l, b - t
    if w <= 0 or h <= 0: return None
    canvas = Image.new("L", (w + 2, h + 2), 0)
    ImageDraw.Draw(canvas).text((-l + 1, -t + 1), ch, fill=255, font=font)
    bb2 = canvas.getbbox()
    if not bb2: return None
    cropped = canvas.crop(bb2)
    cw, ch2 = cropped.size
    advance = cw + 2 * SIDE_BEARING
    vOff = max(0, int(ascent + t))
    rgba = Image.new("RGBA", (cw, ch2), (255, 255, 255, 0))
    rgba.putalpha(cropped)
    return rgba, advance, vOff, cw, ch2

def pack(font, ascent, cps):
    placed, skipped = [], []
    cx, cy, rh = 0, 0, 0
    for cp in cps:
        r = render_glyph(font, cp, ascent)
        if r is None: skipped.append(cp); continue
        gl, advance, vOff, cw, ch2 = r
        gw, gh = gl.size
        if cx + gw + LINE_PAD > ATLAS_W:
            cx = 0; cy += rh + LINE_PAD; rh = 0
        if cy + gh > ATLAS_H: skipped.append(cp); continue
        ax = cx + SIDE_BEARING
        placed.append((cp, ax, cy, cw, ch2, advance, vOff, gl))
        cx += advance + LINE_PAD; rh = max(rh, gh)
    return placed, skipped

def enc_alpha(a):
    mn, mx = min(a), max(a)
    if mn == mx: return bytes([mn, mx, 0, 0, 0, 0, 0, 0])
    a0, a1 = mx, mn
    pal = [a0, a1] + [((7-i)*a0 + i*a1 + 3)//7 for i in range(1, 7)]
    bits = 0
    for i, v in enumerate(a):
        bi, bd = 0, 999
        for j, p in enumerate(pal):
            d = abs(v - p)
            if d < bd: bd, bi = d, j
        bits |= (bi & 7) << (i*3)
    b = bytearray([a0, a1])
    for i in range(6): b.append((bits >> (i*8)) & 0xFF)
    return bytes(b)

COLOR_BLOCK = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00])

def bc3_encode(rgba, W, H):
    bw, bh = (W+3)//4, (H+3)//4
    out = bytearray()
    for by in range(bh):
        for bx in range(bw):
            alphas = []
            for sy in range(4):
                for sx in range(4):
                    x, y = bx*4+sx, by*4+sy
                    if x < W and y < H:
                        alphas.append(rgba[y*W*4 + x*4 + 3])
                    else: alphas.append(0)
            out.extend(enc_alpha(alphas))
            out.extend(COLOR_BLOCK)
    return bytes(out)

font = ImageFont.truetype(TTF, FONT_SIZE)
ascent, descent = font.getmetrics()
print(f"{TTF} size={FONT_SIZE} ascent={ascent} descent={descent}")
cps = codepoints()
placed, skipped = pack(font, ascent, cps)
print(f"placed={len(placed)} skipped={len(skipped)}")
if skipped: print(f"  WARN skipped: {skipped[:15]}")

atlas = Image.new("RGBA", (ATLAS_W, ATLAS_H), (255, 255, 255, 0))
for cp, x, y, cw, ch2, adv, vOff, gl in placed:
    atlas.paste(gl, (x, y))
atlas.save(OUT_DIR / "atlas.png")
alpha = atlas.split()[3]
alpha.save(OUT_DIR / "atlas_alpha.png")

if OUT_FORMAT == "BC3":
    bc3 = bc3_encode(atlas.tobytes("raw", "RGBA"), ATLAS_W, ATLAS_H)
    (OUT_DIR / "atlas.bc3.bin").write_bytes(bc3)
    print(f"BC3: {len(bc3)} bytes")
else:
    # PF_G8 — sirий raw grayscale (1 байт на піксель). Зберігаємо alpha-канал
    # як яскравість (це маска шрифту: 0 = прозоро, 255 = повна заливка).
    g8 = alpha.tobytes()
    (OUT_DIR / "atlas.g8.bin").write_bytes(g8)
    print(f"G8: {len(g8)} bytes")

chars, remap = [], {}
for cp, x, y, cw, ch2, adv, vOff, _ in placed:
    gi = len(chars)
    chars.append({"startU": x, "startV": y, "uSize": adv, "vSize": ch2, "texIdx": 0, "vOff": vOff})
    remap[cp] = gi
for cp in range(0, 0x20): remap.setdefault(cp, 0)
remap_sorted = [{"key": k, "val": v} for k, v in sorted(remap.items())]

meta = {
    "ttf": TTF, "fontSize": FONT_SIZE,
    "ascent": ascent, "descent": descent,
    "atlasW": ATLAS_W, "atlasH": ATLAS_H,
    "format": OUT_FORMAT,
    "characters": chars,
    "remap": remap_sorted,
}
(OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"chars={len(chars)} remap={len(remap_sorted)}")
