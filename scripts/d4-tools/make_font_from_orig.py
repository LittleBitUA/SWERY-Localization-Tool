"""
Генерує atlas + UFont meta РЕСПЕКТУЮЧИ оригінальні розміри гліфів.
Для кожного glyph code-point що ВЖЕ Є в оригіналі (ASCII, Latin-1):
  - Беремо оригінальні uSize, vSize, StartU, StartV, vOff (з font_orig.json).
  - Render F:\My.ttf у *такому самому* bounding box (з масштабуванням).
  - Place у atlas на тих же координатах.
Для UA cyrillic (U+0400+):
  - Render F:\My.ttf на типовому розмірі (від ascent оригіналу).
  - Place у пусте місце atlas (CJK територія).
  - Add нові Characters + CharRemap entries.

Це дає: shadow effect (newcinema_s) точно співпадає по UV; UA letters додані.
"""
import json, struct, sys
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw

if len(sys.argv) < 5:
    print("Usage: make_font_from_orig.py <ttf> <orig_json> <atlas_w> <atlas_h> <out_dir>")
    sys.exit(1)

TTF = sys.argv[1]
ORIG_JSON = Path(sys.argv[2])
ATLAS_W = int(sys.argv[3])
ATLAS_H = int(sys.argv[4])
OUT_DIR = Path(sys.argv[5])
OUT_DIR.mkdir(parents=True, exist_ok=True)
PAD = 2

orig = json.loads(ORIG_JSON.read_text(encoding="utf-8"))
orig_chars = orig["characters"]
orig_remap = {r["key"]: r["val"] for r in orig["remap"]}

# Знаходимо тип. uppercase height (з 'A') для UA-render розміру.
A_idx = orig_remap.get(0x41)
ref_h = orig_chars[A_idx]["vSize"] if A_idx else 36

# Шукаємо FONT_SIZE для нашого TTF, де 'A' має висоту = ref_h.
def find_font_size():
    for sz in range(20, 80):
        f = ImageFont.truetype(TTF, sz)
        bbox = f.getbbox("A")
        h = bbox[3] - bbox[1]
        if h >= ref_h:
            return sz
    return 40
FONT_SIZE = find_font_size()
print(f"Auto FONT_SIZE={FONT_SIZE} (ref H='A'={ref_h})")

font = ImageFont.truetype(TTF, FONT_SIZE)
ascent, descent = font.getmetrics()

def render_glyph(cp, target_w=None, target_h=None):
    """Render glyph; if target_w/target_h задані — масштабуємо туди."""
    ch = chr(cp)
    if cp in (0x20, 0xA0):
        adv = target_w or max(int(font.getlength(ch)), 4)
        return Image.new("RGBA", (adv, 1), (255,255,255,0)), 0
    try: bbox = font.getbbox(ch)
    except: return None
    if not bbox: return None
    l, t, r, b = bbox
    w, h = r-l, b-t
    if w <= 0 or h <= 0: return None
    canvas = Image.new("L", (w+2, h+2), 0)
    ImageDraw.Draw(canvas).text((-l+1, -t+1), ch, fill=255, font=font)
    bb2 = canvas.getbbox()
    if not bb2: return None
    cropped = canvas.crop(bb2)
    # Масштаб до target if any.
    if target_w and target_h:
        cropped = cropped.resize((target_w, target_h), Image.LANCZOS)
    cw, ch2 = cropped.size
    vOff = max(0, int(ascent + t))
    rgba = Image.new("RGBA", (cw, ch2), (255,255,255,0))
    rgba.putalpha(cropped)
    return rgba, vOff

atlas = Image.new("RGBA", (ATLAS_W, ATLAS_H), (255,255,255,0))

# 1) Перепишемо ASCII + Latin-1 glyphs у відповідні позиції оригіналу.
new_chars = list(orig_chars)   # copy structure
# Викидаємо CJK з remap — тільки Latin + spec лишаємо.
orig_remap_filtered = {k: v for k, v in orig_remap.items()
                       if k <= 0x024F or 0x2000 <= k <= 0x20FF or k in (0x2116,)}
print(f"Remap filtered: {len(orig_remap)} -> {len(orig_remap_filtered)} (CJK removed)")
orig_remap = orig_remap_filtered
replaced = 0
for cp in list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)):
    if cp not in orig_remap: continue
    gi = orig_remap[cp]
    orig_c = orig_chars[gi]
    tw, th = orig_c["uSize"], orig_c["vSize"]
    if tw <= 0 or th <= 0: continue
    g = render_glyph(cp, target_w=tw, target_h=th)
    if g is None: continue
    gl, _ = g
    atlas.paste(gl, (orig_c["startU"], orig_c["startV"]))
    # vOff лишаємо оригінальний (синхрон з shadow).
    replaced += 1
print(f"Replaced {replaced} ASCII/Latin-1 glyphs in-place")

# 2) Додаємо UA cyrillic — **OVERWRITE** CJK Character entries (з кінця масиву)
# щоб НЕ збільшувати total Characters count.
ua_cps = [0x0401, 0x0404, 0x0406, 0x0407, 0x0490]
ua_cps += list(range(0x0410, 0x0450))
ua_cps += [0x0451, 0x0454, 0x0456, 0x0457, 0x0491]
ua_cps += [0x2012, 0x2013, 0x2014, 0x2015, 0x2116]
ua_cps = sorted(set(ua_cps))

# Знаходимо вільне місце у atlas. Кладемо у CJK територію y>=256.
ua_start_y = max(ATLAS_H - 256, 0)
cx, cy, rh = 0, ua_start_y, 0
new_remap = dict(orig_remap)

# Замість append — overwrite Characters з кінця (CJK glyphs).
overwrite_idx = len(new_chars) - 1
added = 0
for cp in ua_cps:
    g = render_glyph(cp)
    if g is None: continue
    gl, vOff = g
    gw, gh = gl.size
    if cx + gw + PAD > ATLAS_W:
        cx = 0; cy += rh + PAD; rh = 0
    if cy + gh > ATLAS_H: break
    # Перезаписуємо CJK entry.
    new_chars[overwrite_idx] = {
        "startU": cx, "startV": cy,
        "uSize": gw, "vSize": gh,
        "texIdx": 0, "vOff": vOff,
    }
    atlas.paste(gl, (cx, cy))
    new_remap[cp] = overwrite_idx
    cx += gw + PAD; rh = max(rh, gh)
    added += 1
    overwrite_idx -= 1
print(f"Overwrote {added} CJK entries with UA cyrillic at y>={ua_start_y}")

# Збереження.
atlas.save(OUT_DIR / "atlas.png")
atlas.split()[3].save(OUT_DIR / "atlas_alpha.png")

# BC3 encoder.
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
COLOR = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00])
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
            out.extend(COLOR)
    return bytes(out)

bc3 = bc3_encode(atlas.tobytes("raw", "RGBA"), ATLAS_W, ATLAS_H)
(OUT_DIR / "atlas.bc3.bin").write_bytes(bc3)
print(f"BC3: {len(bc3)} bytes")

meta = {
    "ttf": TTF, "fontSize": FONT_SIZE,
    "ascent": ascent, "descent": descent,
    "characters": new_chars,
    "remap": [{"key": k, "val": v} for k, v in sorted(new_remap.items())],
}
(OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"chars={len(new_chars)} remap={len(new_remap)}")
