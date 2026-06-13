"""
D4 Fonts Additive Generator — головна тактика для збереження спецсимволів.

На відміну від make_paired_fonts/make_single_font, цей скрипт:
  • Завантажує оригінальний atlas (BC3/G8 → RGBA Image)
  • Зберігає ВСІ orig Characters (latin, кнопки контролера, стрілки, іконки)
  • Знаходить вільні зони (alpha < threshold)
  • Рендерить ТІЛЬКИ кириличні + UA-spec гліфи з TTF
  • Пакує їх у вільні місця на ту ж саму канву
  • Encode назад → BC3 / G8
  • Output: merged meta (orig characters + new appended, CharRemap orig + cyrillic)

Для paired: shadow атлас обробляється з тими самими позиціями глифів, але
рендериться dilated/blurred alpha (drop-shadow).

Usage: d4-fonts-additive.py <config.json>

Config:
{
  "name":        "consola",                           // ім'я UFont
  "type":        "single" | "paired",
  "shadow":      "consola_s",                         // лише paired
  "ttf":         "/path/to/font.ttf",
  "fontSize":    14,
  "format":      "BC3" | "G8",                        // вихідний формат payload
  "origMetaJson":       "/path/Meta/consola.json",    // UFont meta (textures, characters, remap, ascent, ...)
  "origShadowMetaJson": "/path/Meta/consola_s.json",  // paired only
  "origAtlasDir":       "/path/Atlases/consola/",     // тут <texName>.mip0.bin + .props.json
  "origShadowAtlasDir": "/path/Atlases/consola_s/",   // paired only
  "outDir":             "/path/Generated/consola/"
}

Output (у outDir/):
  single:  atlas.{bc3|g8}.bin (для першої tex) + atlas.png + meta.json
  paired:  main_page<N>.{bc3|g8}.bin + main_page<N>.png + shadow_page<N>.{bc3|g8}.bin + shadow_page<N>.png + meta.json

Емітить:
  [STEP]/[INFO]/[ERR] + RESULT_JSON
"""
import json, sys, struct
from pathlib import Path

if len(sys.argv) < 2:
    print("Usage: d4-fonts-additive.py <config.json>")
    sys.exit(1)

CFG = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

try:
    import texture2ddecoder
    from PIL import Image, ImageFont, ImageDraw, ImageFilter
except ImportError as e:
    print(f"[ERR] missing python lib: {e}")
    sys.exit(2)

NAME = CFG["name"]
TYPE = CFG["type"]
SHADOW = CFG.get("shadow")
TTF = CFG["ttf"]
FONT_SIZE = int(CFG["fontSize"])
OUT_FORMAT = CFG.get("format", "BC3").upper()
ORIG_META_PATH = Path(CFG["origMetaJson"])
ORIG_SHADOW_META_PATH = Path(CFG["origShadowMetaJson"]) if TYPE == "paired" else None
ORIG_ATLAS_DIR = Path(CFG["origAtlasDir"])
ORIG_SHADOW_ATLAS_DIR = Path(CFG["origShadowAtlasDir"]) if TYPE == "paired" else None
OUT_DIR = Path(CFG["outDir"])
OUT_DIR.mkdir(parents=True, exist_ok=True)

SIDE_BEARING = 1
LINE_PAD = 2
ALPHA_THRESHOLD = 8           # піксель вважається порожнім якщо alpha <= 8
PADDING_AROUND_GLYPH = 1      # margin навколо нового гліфа (щоб не торкався сусідів)
SHADOW_DILATE_PX = 3
SHADOW_BLUR_RADIUS = 1.5
SHADOW_BOOST = 2.0


def cyrillic_codepoints():
    """Codepoints, які ДОДАЄМО на atlas. Усе що orig вже має — лишаємо без змін."""
    pts = []
    pts += list(range(0x0410, 0x0450))                              # А-я
    pts += [0x0401, 0x0451]                                          # Ё ё
    pts += [0x0404, 0x0454, 0x0406, 0x0456, 0x0407, 0x0457, 0x0490, 0x0491]  # UA spec
    pts += [0x2012, 0x2013, 0x2014, 0x2015, 0x2116]                  # тире, №
    return sorted(set(pts))


# Cyrillic → Latin візуально-ідентичні замінники. Для цих codepoint'ів НЕ
# малюємо нічого на atlas, просто CharRemap[cyrillic] = orig glyph idx латиниці.
# Атлас newcinema показав 0% вільного місця — без цього прийому ~22 кириличних
# літери не вмістились би взагалі.
LATIN_SUBSTITUTIONS = {
    # Uppercase
    0x0410: 0x0041,  # А → A
    0x0412: 0x0042,  # В → B
    0x0415: 0x0045,  # Е → E
    0x041A: 0x004B,  # К → K
    0x041C: 0x004D,  # М → M
    0x041D: 0x0048,  # Н → H
    0x041E: 0x004F,  # О → O
    0x0420: 0x0050,  # Р → P
    0x0421: 0x0043,  # С → C
    0x0422: 0x0054,  # Т → T
    0x0425: 0x0058,  # Х → X
    0x0406: 0x0049,  # І → I (UA)
    0x0407: 0x0049,  # Ї → I (близько, кращий за відсутність)  TODO crown dots
    # Lowercase
    0x0430: 0x0061,  # а → a
    0x0435: 0x0065,  # е → e
    0x043C: 0x006D,  # м → m
    0x043E: 0x006F,  # о → o
    0x0440: 0x0070,  # р → p
    0x0441: 0x0063,  # с → c
    0x0443: 0x0079,  # у → y
    0x0445: 0x0078,  # х → x
    0x0456: 0x0069,  # і → i (UA)
    0x0457: 0x0069,  # ї → i
    # Спецсимволи — теж візуально однакові
    0x0401: 0x0045,  # Ё → E (без дієрезіса, але краще ніж нічого)
    0x0451: 0x0065,  # ё → e
}


# ── Decode orig atlas ──────────────────────────────────────────────
def detect_format(props_path: Path) -> str:
    if not props_path.exists(): return "BC3"
    for p in json.loads(props_path.read_text(encoding="utf-8")):
        if p.get("name") == "Format":
            v = str(p.get("value", ""))
            if "PF_DXT5" in v: return "BC3"
            if "PF_G8"   in v: return "G8"
            if "PF_DXT1" in v: return "BC1"
            return v
    return "BC3"


def guess_size(payload_size: int, fmt: str):
    """Texture2D розміри з payload — як у d4-fonts-preview.py."""
    if fmt == "BC1": target = payload_size * 2
    else: target = payload_size
    cands = [
        (1024, 1024), (1024, 512), (512, 1024),
        (512, 512), (512, 256), (256, 512),
        (508, 512), (512, 508),
        (256, 256), (508, 256), (256, 128),
        (512, 128), (508, 128), (508, 64),
        (128, 128), (64, 64), (256, 64),
    ]
    for w, h in cands:
        if abs(w * h - target) < 1024: return (w, h)
    return None


def decode_atlas(atlas_dir: Path, tex_name: str):
    """Повертає (Image alpha-mask 'L', W, H, format)."""
    bin_path = atlas_dir / f"{tex_name}.mip0.bin"
    props_path = atlas_dir / f"{tex_name}.props.json"
    if not bin_path.exists():
        raise FileNotFoundError(str(bin_path))
    data = bin_path.read_bytes()
    fmt = detect_format(props_path)
    sz = guess_size(len(data), fmt)
    if not sz: raise RuntimeError(f"cannot guess size for {tex_name} ({len(data)}B {fmt})")
    W, H = sz
    if fmt == "G8":
        img = Image.frombytes("L", (W, H), data)
        return img, W, H, fmt
    if fmt == "BC3":
        rgba_bytes = texture2ddecoder.decode_bc3(data, W, H)
        rgba = Image.frombytes("RGBA", (W, H), rgba_bytes, "raw", "BGRA")
        return rgba.split()[3], W, H, fmt
    if fmt == "BC1":
        rgba_bytes = texture2ddecoder.decode_bc1(data, W, H)
        rgba = Image.frombytes("RGBA", (W, H), rgba_bytes, "raw", "BGRA")
        return rgba.convert("L"), W, H, fmt
    raise RuntimeError(f"unsupported orig format: {fmt}")


# ── Free-zone finder ──────────────────────────────────────────────
def build_used_mask(alpha_img: Image.Image, orig_chars):
    """Бінарна mask: True = піксель зайнятий (alpha > threshold або у bbox orig char)."""
    import array
    W, H = alpha_img.size
    pixels = alpha_img.tobytes()
    # Initially, mask comes from alpha
    used = bytearray(W * H)
    for i in range(W * H):
        if pixels[i] > ALPHA_THRESHOLD:
            used[i] = 1
    # Додатково помічаємо bbox orig characters (на випадок alpha=0 в межах char).
    for c in orig_chars:
        x = c["startU"]; y = c["startV"]
        w = c["uSize"]; h = c["vSize"]
        ty = max(0, y - PADDING_AROUND_GLYPH)
        by = min(H, y + h + PADDING_AROUND_GLYPH)
        lx = max(0, x - PADDING_AROUND_GLYPH)
        rx = min(W, x + w + PADDING_AROUND_GLYPH)
        for yy in range(ty, by):
            row = yy * W
            for xx in range(lx, rx):
                used[row + xx] = 1
    return used, W, H


def integral_image(mask, W, H):
    """Sum-area table для O(1) перевірки прямокутника."""
    ii = [0] * ((W + 1) * (H + 1))
    for y in range(H):
        row_sum = 0
        for x in range(W):
            row_sum += mask[y * W + x]
            ii[(y + 1) * (W + 1) + (x + 1)] = ii[y * (W + 1) + (x + 1)] + row_sum
    return ii


def is_free(ii, W, x, y, w, h):
    """True якщо прямокутник [x..x+w, y..y+h] повністю порожній."""
    return (
        ii[(y + h) * (W + 1) + (x + w)]
        - ii[(y + h) * (W + 1) + x]
        - ii[y * (W + 1) + (x + w)]
        + ii[y * (W + 1) + x]
    ) == 0


def find_free_position(ii, W, H, w, h):
    """Шукає найвищу-лівшу вільну зону для прямокутника WxH."""
    if w > W or h > H: return None
    for y in range(H - h + 1):
        for x in range(W - w + 1):
            if is_free(ii, W, x, y, w, h):
                return x, y
    return None


def mark_used(mask, W, x, y, w, h):
    for yy in range(y, y + h):
        row = yy * W
        for xx in range(x, x + w):
            mask[row + xx] = 1


# ── Render glyph ──────────────────────────────────────────────────
def render_glyph(font, cp, ascent):
    ch = chr(cp)
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
    return cropped, advance, vOff, cw, ch2


# ── BC3 encoder (з make_single_font.py) ──────────────────────────
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
        bits |= (bi & 7) << (i * 3)
    b = bytearray([a0, a1])
    for i in range(6): b.append((bits >> (i * 8)) & 0xFF)
    return bytes(b)


COLOR_BLOCK = bytes([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00])


def bc3_encode_alpha(alpha_img: Image.Image, W: int, H: int) -> bytes:
    """alpha_img — Image 'L' розміру WxH."""
    px = alpha_img.tobytes()
    bw, bh = (W + 3) // 4, (H + 3) // 4
    out = bytearray()
    for by in range(bh):
        for bx in range(bw):
            alphas = []
            for sy in range(4):
                for sx in range(4):
                    x, y = bx * 4 + sx, by * 4 + sy
                    if x < W and y < H:
                        alphas.append(px[y * W + x])
                    else:
                        alphas.append(0)
            out.extend(enc_alpha(alphas))
            out.extend(COLOR_BLOCK)
    return bytes(out)


# ── Main pipeline ─────────────────────────────────────────────────
def process_font():
    print(f"[STEP] {NAME} ({TYPE}) — additive")
    orig_meta = json.loads(ORIG_META_PATH.read_text(encoding="utf-8"))
    font_ttf = ImageFont.truetype(TTF, FONT_SIZE)
    ascent_pix, descent_pix = font_ttf.getmetrics()

    orig_chars = orig_meta["characters"]
    orig_remap = orig_meta["remap"]
    orig_textures = orig_meta["textures"]

    # Decode усі сторінки main atlas.
    main_alphas = []
    main_sizes = []
    for t in orig_textures:
        alpha_img, W, H, _fmt = decode_atlas(ORIG_ATLAS_DIR, t["name"])
        main_alphas.append(alpha_img.copy())
        main_sizes.append((W, H))
        print(f"  [LOAD] {t['name']} {W}x{H}")

    # Side note: shadow paired — завантажуємо сторінки одразу, додаватимемо
    # дзеркальні позиції з тінню.
    shadow_alphas = []
    shadow_textures = []
    if TYPE == "paired":
        orig_shadow_meta = json.loads(ORIG_SHADOW_META_PATH.read_text(encoding="utf-8"))
        shadow_textures = orig_shadow_meta["textures"]
        for t in shadow_textures:
            alpha_img, W, H, _fmt = decode_atlas(ORIG_SHADOW_ATLAS_DIR, t["name"])
            shadow_alphas.append(alpha_img.copy())
            print(f"  [LOAD] shadow {t['name']} {W}x{H}")
        if len(shadow_alphas) != len(main_alphas):
            print(f"  [WARN] page count mismatch main={len(main_alphas)} shadow={len(shadow_alphas)}")

    # Будуємо masks вільних зон для кожної main сторінки.
    masks = []
    integrals = []
    for i, alpha_img in enumerate(main_alphas):
        W, H = main_sizes[i]
        chars_on_page = [c for c in orig_chars if c.get("texIdx", 0) == i]
        used, _, _ = build_used_mask(alpha_img, chars_on_page)
        ii = integral_image(used, W, H)
        masks.append(used)
        integrals.append(ii)

    # Render cyrillic glyphs.
    cps = cyrillic_codepoints()
    print(f"  [INFO] target codepoints: {len(cps)}")

    # PASS 1: Latin substitution для візуально-ідентичних. Не малюємо нічого,
    # просто додаємо CharRemap entries (кириличний codepoint → той самий glyph
    # index що й латинський). Це звільняє місце на atlas для унікальних букв.
    orig_remap_dict = {int(r["key"]): int(r["val"]) for r in orig_remap}
    reused_via_latin = {}      # cyrillic_cp → glyph_idx
    for cp in cps:
        if cp in LATIN_SUBSTITUTIONS:
            latin_cp = LATIN_SUBSTITUTIONS[cp]
            if latin_cp in orig_remap_dict:
                reused_via_latin[cp] = orig_remap_dict[latin_cp]
    print(f"  [INFO] reused via Latin substitution: {len(reused_via_latin)}")

    # PASS 2: render + pack для тих що не reused.
    to_render = [cp for cp in cps if cp not in reused_via_latin]
    rendered = []
    for cp in to_render:
        r = render_glyph(font_ttf, cp, ascent_pix)
        if r is None: continue
        rendered.append((cp, r))
    print(f"  [INFO] to render (unique cyrillic): {len(rendered)}")

    # Pack: для кожного нового гліфа знаходимо вільне місце на якійсь сторінці.
    placed = []
    skipped = []
    for cp, (glyph_img, advance, vOff, cw, ch2) in rendered:
        # Розмір з padding для пошуку.
        need_w = cw + 2 * PADDING_AROUND_GLYPH
        need_h = ch2 + 2 * PADDING_AROUND_GLYPH
        found = False
        for page_idx in range(len(main_alphas)):
            W, H = main_sizes[page_idx]
            pos = find_free_position(integrals[page_idx], W, H, need_w, need_h)
            if pos is None: continue
            x_pad, y_pad = pos
            x = x_pad + PADDING_AROUND_GLYPH
            y = y_pad + PADDING_AROUND_GLYPH
            # Малюємо гліф на main атласі (alpha-mode: paste з max-alpha).
            main_alphas[page_idx].paste(glyph_img, (x, y), glyph_img)
            # Помічаємо у mask + перебудовуємо integral для цієї сторінки.
            mark_used(masks[page_idx], W, x_pad, y_pad, need_w, need_h)
            integrals[page_idx] = integral_image(masks[page_idx], W, H)
            placed.append((cp, page_idx, x, y, cw, ch2, advance, vOff))
            found = True
            break
        if not found:
            skipped.append(cp)
    print(f"  [INFO] placed: {len(placed)}, skipped: {len(skipped)}")
    if skipped:
        print(f"  [WARN] skipped cps: {skipped[:10]}{'...' if len(skipped) > 10 else ''}")

    # Build merged Characters[] + CharRemap.
    new_chars = list(orig_chars)
    new_remap = {int(r["key"]): int(r["val"]) for r in orig_remap}
    # Pass 1 mappings — Latin substitution (no new glyph, just point to existing).
    for cp, glyph_idx in reused_via_latin.items():
        new_remap[cp] = glyph_idx
    # Pass 2 mappings — нові гліфи додані на atlas.
    for cp, page_idx, x, y, cw, ch2, adv, vOff in placed:
        gi = len(new_chars)
        new_chars.append({
            "startU": x, "startV": y, "uSize": adv, "vSize": ch2,
            "texIdx": page_idx, "vOff": vOff,
        })
        new_remap[cp] = gi
    remap_sorted = [{"key": k, "val": v} for k, v in sorted(new_remap.items())]

    # ── Generate shadow paired ────────────────────────────────────
    if TYPE == "paired" and shadow_alphas:
        # Для кожного нового placed glyph малюємо ту ж канву на shadow atlas
        # у такій же позиції — але dilated + blurred (drop-shadow look).
        # Якщо shadow має менше сторінок ніж main — використовуємо modulo.
        n_shadow = len(shadow_alphas)
        for cp, page_idx, x, y, cw, ch2, adv, vOff in placed:
            shadow_page = page_idx if page_idx < n_shadow else (page_idx % n_shadow)
            # Render glyph alpha → dilate → blur → boost.
            glyph_img = main_alphas[page_idx].crop((x, y, x + cw, y + ch2))
            dilated = glyph_img.filter(ImageFilter.MaxFilter(2 * SHADOW_DILATE_PX + 1))
            blurred = dilated.filter(ImageFilter.GaussianBlur(SHADOW_BLUR_RADIUS))
            boosted = blurred.point(lambda v: min(255, int(v * SHADOW_BOOST)))
            # Розширюємо область на shadow atlas (бо dilate робить glyph ширше).
            shadow_alphas[shadow_page].paste(boosted, (x, y), boosted)
        print(f"  [INFO] shadow pages updated")

    # ── Save outputs ──────────────────────────────────────────────
    ext = "bc3.bin" if OUT_FORMAT == "BC3" else "g8.bin"
    if TYPE == "single":
        # Single = 1 atlas. Зберігаємо як atlas.<ext>.
        W, H = main_sizes[0]
        alpha = main_alphas[0]
        alpha.save(OUT_DIR / "atlas.png")
        if OUT_FORMAT == "BC3":
            bc3 = bc3_encode_alpha(alpha, W, H)
            (OUT_DIR / "atlas.bc3.bin").write_bytes(bc3)
        else:
            (OUT_DIR / "atlas.g8.bin").write_bytes(alpha.tobytes())
    else:
        # Paired: main_page<N> + shadow_page<N>.
        for i, alpha in enumerate(main_alphas):
            W, H = main_sizes[i]
            alpha.save(OUT_DIR / f"main_page{i}.png")
            if OUT_FORMAT == "BC3":
                bc3 = bc3_encode_alpha(alpha, W, H)
                (OUT_DIR / f"main_page{i}.bc3.bin").write_bytes(bc3)
            else:
                (OUT_DIR / f"main_page{i}.g8.bin").write_bytes(alpha.tobytes())
        for i, alpha in enumerate(shadow_alphas):
            W, H = alpha.size
            alpha.save(OUT_DIR / f"shadow_page{i}.png")
            if OUT_FORMAT == "BC3":
                bc3 = bc3_encode_alpha(alpha, W, H)
                (OUT_DIR / f"shadow_page{i}.bc3.bin").write_bytes(bc3)
            else:
                (OUT_DIR / f"shadow_page{i}.g8.bin").write_bytes(alpha.tobytes())

    # Meta JSON: зберігаємо emScale/ascent/descent з orig (для UFont body
    # генерації під час pack — d4-fonts-pack.py читає ці поля).
    meta = {
        "ttf": TTF,
        "fontSize": FONT_SIZE,
        "format": OUT_FORMAT,
        "emScale": orig_meta.get("emScale", 1.0),
        "ascent": orig_meta.get("ascent", 0),
        "descent": orig_meta.get("descent", 0),
        "charactersCount": len(new_chars),
        "remapCount": len(remap_sorted),
        "characters": new_chars,
        "remap": remap_sorted,
        "addedCyrillic": len(placed),
        "skippedCyrillic": len(skipped),
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  [DONE] characters={len(new_chars)} (+{len(placed)} drawn, +{len(reused_via_latin)} via Latin), remap={len(remap_sorted)}")

    return {
        "ok": True, "name": NAME,
        "added": len(placed),
        "reusedLatin": len(reused_via_latin),
        "skipped": len(skipped),
        "characters": len(new_chars),
    }


try:
    result = process_font()
    print("RESULT_JSON: " + json.dumps(result, ensure_ascii=False))
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"[ERR] {NAME}: {e}")
    print("RESULT_JSON: " + json.dumps({"ok": False, "name": NAME, "error": str(e)}, ensure_ascii=False))
    sys.exit(3)
