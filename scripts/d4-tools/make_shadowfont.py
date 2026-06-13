"""
Рендерить atlas для newcinema (Texture2D_7, 512×512).
Шрифт-сайз 48, щоб збігтись із розмірами оригіналу (T=36×40, A=39×39).
"""
import json, struct
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw, ImageFilter

TTF = r"F:/My.ttf"
OUT_DIR = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/shadowfont_UA")
OUT_DIR.mkdir(parents=True, exist_ok=True)
ATLAS_W, ATLAS_H = 508, 512
FONT_SIZE = 34   # розмір під newcinema (36) щоб після dilate вийшло ширше
PAD = 2

def latin():
    # Тільки базовий ASCII — Latin-1 (À Á ...) пропускаємо, рідко вживане.
    return list(range(0x20, 0x7F))

def cyrillic():
    pts = [0x0401, 0x0404, 0x0406, 0x0407, 0x0490]
    pts += list(range(0x0410, 0x0450))
    pts += [0x0451, 0x0454, 0x0456, 0x0457, 0x0491]
    pts += [0x2012, 0x2013, 0x2014, 0x2015, 0x2116]
    return sorted(set(pts))

DILATE_PX = 2     # розширити на 2 — стане ширшим за newcinema
BLUR_RADIUS = 1.0 # blur для м'якшої тіні

def render_glyph(font, cp, ascent):
    ch = chr(cp)
    if cp in (0x20, 0xA0):
        try: adv = int(font.getlength(ch))
        except: adv = FONT_SIZE // 3
        rgba = Image.new("RGBA", (max(adv, 4), 1), (255,255,255,0))
        return rgba, 0
    try: bbox = font.getbbox(ch)
    except: return None
    if not bbox: return None
    l, t, r, b = bbox
    w, h = r-l, b-t
    if w <= 0 or h <= 0: return None
    # Великий canvas, бо dilation розширить glyph.
    pad = DILATE_PX + 2
    canvas = Image.new("L", (w + 2*pad, h + 2*pad), 0)
    ImageDraw.Draw(canvas).text((-l + pad, -t + pad), ch, fill=255, font=font)
    # Dilate (MaxFilter розміру 2N+1).
    if DILATE_PX > 0:
        canvas = canvas.filter(ImageFilter.MaxFilter(2 * DILATE_PX + 1))
    # Blur для м'якших країв.
    if BLUR_RADIUS > 0:
        canvas = canvas.filter(ImageFilter.GaussianBlur(BLUR_RADIUS))
    bb2 = canvas.getbbox()
    if not bb2: return None
    cropped = canvas.crop(bb2)
    cw, ch2 = cropped.size
    # vOff: dilation зсуває top на DILATE_PX вище → коригуємо.
    vOff = max(0, int(ascent + t - DILATE_PX))
    rgba = Image.new("RGBA", (cw, ch2), (255,255,255,0))
    rgba.putalpha(cropped)
    return rgba, vOff

def pack(font, ascent, cps):
    placed, skipped = [], []
    cx, cy, rh = 0, 0, 0
    for cp in cps:
        r = render_glyph(font, cp, ascent)
        if r is None: skipped.append(cp); continue
        gl, vOff = r
        gw, gh = gl.size
        if cx + gw + PAD > ATLAS_W: cx = 0; cy += rh + PAD; rh = 0
        if cy + gh > ATLAS_H: skipped.append(cp); continue
        placed.append((cp, cx, cy, gw, gh, vOff, gl))
        cx += gw + PAD; rh = max(rh, gh)
    return placed, skipped

# BC3
def enc_alpha(a):
    mn, mx = min(a), max(a)
    if mn == mx:
        return bytes([mn, mx, 0, 0, 0, 0, 0, 0])
    a0, a1 = mx, mn
    pal = [a0, a1]
    for i in range(1, 7):
        pal.append(((7-i)*a0 + i*a1 + 3)//7)
    idxs = []
    for v in a:
        bi, bd = 0, 1e9
        for i, p in enumerate(pal):
            d = abs(v-p)
            if d < bd: bd, bi = d, i
        idxs.append(bi)
    bits = 0
    for i, x in enumerate(idxs): bits |= (x & 7) << (i*3)
    b = bytearray([a0, a1])
    for i in range(6): b.append((bits >> (i*8)) & 0xFF)
    return bytes(b)

COLOR = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00])

def bc3_encode(rgba_bytes, W, H):
    bw, bh = (W+3)//4, (H+3)//4
    out = bytearray()
    row_bytes = W*4
    for by in range(bh):
        for bx in range(bw):
            a = []
            for sy in range(4):
                for sx in range(4):
                    x, y = bx*4+sx, by*4+sy
                    if x < W and y < H:
                        a.append(rgba_bytes[y*row_bytes + x*4 + 3])
                    else: a.append(0)
            out.extend(enc_alpha(a))
            out.extend(COLOR)
    return bytes(out)

def main():
    font = ImageFont.truetype(TTF, FONT_SIZE)
    ascent, descent = font.getmetrics()
    print(f"size={FONT_SIZE} ascent={ascent} descent={descent}")
    cps = latin() + cyrillic()
    placed, skipped = pack(font, ascent, cps)
    print(f"placed={len(placed)} skipped={len(skipped)}")
    img = Image.new("RGBA", (ATLAS_W, ATLAS_H), (255,255,255,0))
    for cp,x,y,w,h,vOff,gl in placed: img.paste(gl, (x, y))
    img.save(OUT_DIR / "atlas.png")
    img.split()[3].save(OUT_DIR / "atlas_alpha.png")
    bc3 = bc3_encode(img.tobytes("raw", "RGBA"), ATLAS_W, ATLAS_H)
    print(f"BC3: {len(bc3)} bytes (expected {((ATLAS_W+3)//4)*((ATLAS_H+3)//4)*16})")
    (OUT_DIR / "atlas.bc3.bin").write_bytes(bc3)
    chars, remap = [], {}
    for cp,x,y,w,h,vOff,_ in placed:
        gi = len(chars)
        chars.append({"startU":x, "startV":y, "uSize":w, "vSize":h, "texIdx":0, "vOff":vOff})
        remap[cp] = gi
    for cp in range(0, 0x20): remap.setdefault(cp, 0)
    meta = {
        "ttf": TTF, "fontSize": FONT_SIZE,
        "ascent": ascent, "descent": descent,
        "characters": chars,
        "remap": [{"key":k, "val":v} for k,v in sorted(remap.items())],
    }
    (OUT_DIR / "shadowfont_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"chars={len(chars)} remap={len(remap)}")

if __name__ == "__main__":
    main()
