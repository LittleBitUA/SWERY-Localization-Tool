"""
Paired UFont repack по GPT алгоритму:
  - Заміна main Texture2D pages (Texture2D_7,8,9 для newcinema)
  - Заміна shadow Texture2D pages (Texture2D_105,106,107 для newcinema_s)
  - Переписаний main UFont body (Characters + CharRemap = paired meta)
  - Переписаний shadow UFont body (ТЕ Ж Characters + CharRemap)
  - Textures[] зберігаємо ORIG для кожного UFont (різні!)
  - Padding нулями до original SerialSize.
"""
import json, struct
from pathlib import Path

SRC = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk")
OUT = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_paired.upk")
INFO = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json")
NC_META = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema_paired/meta.json")
NC_DUMP = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema.json")
NCS_DUMP = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema_s.json")

# Конфіг пари: main UFont + N main pages + shadow UFont + N shadow pages.
PAIRS = [
    {
        "name": "newcinema_pair",
        "meta": NC_META,
        "main_dir": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema_paired",
        "main_font": "newcinema",
        "main_dump": NC_DUMP,
        "main_textures": ["Texture2D_7", "Texture2D_8", "Texture2D_9"],
        "shadow_font": "newcinema_s",
        "shadow_dump": NCS_DUMP,
        "shadow_textures": ["Texture2D_105", "Texture2D_106", "Texture2D_107"],
    },
    {
        "name": "talkfont_pair",
        "meta": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_paired/meta.json",
        "main_dir": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_paired",
        "main_font": "talkfont",
        "main_dump": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/all_fonts/talkfont.json",
        "main_textures": ["Texture2D_82"],
        "shadow_font": "shadowfont",
        "shadow_dump": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/all_fonts/shadowfont.json",
        "shadow_textures": ["Texture2D_69"],
    },
]

def i32(b, p): return struct.unpack_from('<i', b, p)[0]
def pi(v): return struct.pack('<i', v)
def pu16(v): return struct.pack('<H', v)

src = bytearray(SRC.read_bytes())
info = json.loads(INFO.read_text(encoding='utf-8'))
names = info['names']
exports = info['exports']

def ni(s):
    return names.index(s)

def find_export(name, klass):
    for e in exports:
        if e['objectName'] == name and e['className'] == klass:
            return e
    raise KeyError(f"{klass}:{name}")

none_idx = ni("None")

def find_none(b):
    p = 4
    while p + 24 <= len(b):
        nidx = i32(b, p); p += 8
        if nidx == none_idx: return p - 8
        ti = i32(b, p); p += 8
        sz = i32(b, p); p += 4
        ai = i32(b, p); p += 4
        tn = names[ti]
        if tn == "ByteProperty": p += sz + 8
        elif tn == "BoolProperty": p += sz + 1
        elif tn == "StructProperty": p += 8 + sz
        else: p += sz
    return -1

def find_tag(b, name):
    p = 4
    while p + 24 <= len(b):
        nidx = i32(b, p)
        if nidx == none_idx: return -1, -1
        start = p; p += 8
        ti = i32(b, p); p += 8
        sz = i32(b, p); p += 4
        ai = i32(b, p); p += 4
        extra = 0
        tn = names[ti]; nn = names[nidx]
        if tn == "ByteProperty": extra = 8
        elif tn == "BoolProperty": extra = 1
        elif tn == "StructProperty": extra = 8
        if nn == name: return start, p + sz + extra
        p += sz + extra
    return -1, -1

def make_tag(name, ttype, sz, ai=0):
    return pi(ni(name)) + pi(0) + pi(ni(ttype)) + pi(0) + pi(sz) + pi(ai)

def replace_texture2d(tex_name, bc3_path):
    """Заміняє mip[0] payload у Texture2D — same size only."""
    bc3 = Path(bc3_path).read_bytes()
    tx = find_export(tex_name, "Texture2D")
    body = bytes(src[tx['serialOffset']:tx['serialOffset'] + tx['serialSize']])
    npos = find_none(body)
    mip0_hdr = npos + 8 + 16 + 4    # None(8) + SourceArt(16) + MipCount(4)
    payload_off_in_body = mip0_hdr + 16
    payload_off = tx['serialOffset'] + payload_off_in_body
    old_size = i32(body, mip0_hdr + 4)
    if len(bc3) != old_size:
        raise RuntimeError(f"{tex_name}: BC3 size mismatch {len(bc3)} != {old_size}")
    src[payload_off:payload_off + len(bc3)] = bc3
    print(f"  {tex_name}: swapped {len(bc3)} bytes @ 0x{payload_off:x}")

def build_ufont_body(font_name, dump_path, meta):
    """Будує UFont body з paired meta + orig Textures refs."""
    dump = json.loads(Path(dump_path).read_text(encoding='utf-8'))
    fe = find_export(font_name, "Font")
    orig_body = bytes(src[fe['serialOffset']:fe['serialOffset'] + fe['serialSize']])

    # ImportOptions block копіюємо verbatim з orig.
    io_s, io_e = find_tag(orig_body, "ImportOptions")
    io_bytes = orig_body[io_s:io_e]

    # NetIndex (4 байти) — preserve from orig.
    netindex = orig_body[:4]

    # Characters body.
    chars = meta['characters']
    ch_body = bytearray()
    ch_body.extend(pi(len(chars)))
    for c in chars:
        ch_body.extend(pi(c['startU']))
        ch_body.extend(pi(c['startV']))
        ch_body.extend(pi(c['uSize']))
        ch_body.extend(pi(c['vSize']))
        ch_body.append(c['texIdx'] & 0xFF)
        ch_body.extend(pi(c['vOff']))

    # Textures body — ОРИГІНАЛЬНІ refs цього шрифту (різні main vs shadow).
    tex_refs = [t['ref'] for t in dump['textures']]
    tx_body = bytearray()
    tx_body.extend(pi(len(tex_refs)))
    for r in tex_refs:
        tx_body.extend(pi(r))

    # Збираємо тіло.
    out = bytearray()
    out.extend(netindex)
    out.extend(make_tag("Characters", "ArrayProperty", len(ch_body))); out.extend(ch_body)
    out.extend(make_tag("Textures", "ArrayProperty", len(tx_body))); out.extend(tx_body)
    out.extend(make_tag("IsRemapped", "IntProperty", 4)); out.extend(pi(1))
    out.extend(make_tag("EmScale", "FloatProperty", 4)); out.extend(struct.pack('<f', dump['emScale']))
    out.extend(make_tag("Ascent", "FloatProperty", 4)); out.extend(struct.pack('<f', dump['ascent']))
    out.extend(make_tag("Descent", "FloatProperty", 4)); out.extend(struct.pack('<f', dump['descent']))
    out.extend(io_bytes)
    # None tag.
    out.extend(pi(none_idx)); out.extend(pi(0))
    # CharRemap.
    remap = meta['remap']
    out.extend(pi(len(remap)))
    for r in remap:
        out.extend(pu16(r['key'])); out.extend(pu16(r['val']))

    orig_size = fe['serialSize']
    if len(out) > orig_size:
        raise RuntimeError(f"{font_name}: body too big {len(out)} > {orig_size}")
    pad = orig_size - len(out)
    out.extend(b'\x00' * pad)
    src[fe['serialOffset']:fe['serialOffset'] + orig_size] = bytes(out)
    print(f"  {font_name}: {len(out)-pad} bytes + {pad} pad = {orig_size}")

for pair in PAIRS:
    print(f"\n=== {pair['name']} ===")
    meta = json.loads(Path(pair['meta']).read_text(encoding='utf-8'))
    main_dir = pair['main_dir']
    # 1) Replace main texture pages.
    for i, tex_name in enumerate(pair['main_textures']):
        replace_texture2d(tex_name, f"{main_dir}/main_page{i}.bc3.bin")
    # 2) Replace shadow texture pages.
    for i, tex_name in enumerate(pair['shadow_textures']):
        replace_texture2d(tex_name, f"{main_dir}/shadow_page{i}.bc3.bin")
    # 3) Write main UFont body.
    build_ufont_body(pair['main_font'], pair['main_dump'], meta)
    # 4) Write shadow UFont body (SAME Characters/CharRemap, different Textures).
    build_ufont_body(pair['shadow_font'], pair['shadow_dump'], meta)

OUT.write_bytes(bytes(src))
print(f"\n[STEP] Wrote {OUT} ({len(src)} bytes)")
