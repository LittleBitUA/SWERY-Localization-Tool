"""
Single-font UFont repack — для шрифтів без shadow-пари (consola, customfont, etc.).
Кожен FONT_CONFIG: {font_name, texture_name, meta.json, atlas.bc3.bin, dump.json}
"""
import json, struct, sys
from pathlib import Path

# Шлях ВХІДНОГО файлу - беремо вже модифікований (з newcinema/talkfont). Якщо першочерговий
# repack — заміни на orig.
SRC = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_paired.upk")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_paired_consola.upk")
INFO = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json")
ALL_FONTS = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/all_fonts")

CONFIGS = [
    {
        "font_name": "consola",
        "texture_name": "Texture2D_1",
        "meta": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/consola_UA/meta.json",
        "bc3":  r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/consola_UA/atlas.bc3.bin",
    },
    {
        "font_name": "consola_b",
        "texture_name": "Texture2D_2",
        "meta": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/consola_b_UA/meta.json",
        "bc3":  r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/consola_b_UA/atlas.bc3.bin",
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
        if e['objectName'] == name and e['className'] == klass: return e
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

def replace_texture2d(tex_name, bc3_bytes):
    tx = find_export(tex_name, "Texture2D")
    body = bytes(src[tx['serialOffset']:tx['serialOffset'] + tx['serialSize']])
    npos = find_none(body)
    mip0_hdr = npos + 8 + 16 + 4
    payload_off_in_body = mip0_hdr + 16
    payload_off = tx['serialOffset'] + payload_off_in_body
    old_size = i32(body, mip0_hdr + 4)
    if len(bc3_bytes) != old_size:
        raise RuntimeError(f"{tex_name}: BC3 size mismatch {len(bc3_bytes)} != {old_size}")
    src[payload_off:payload_off + len(bc3_bytes)] = bc3_bytes
    print(f"  {tex_name}: swapped {len(bc3_bytes)} bytes @ 0x{payload_off:x}")

def build_ufont_body(font_name, meta):
    dump = json.loads((ALL_FONTS / f"{font_name}.json").read_text(encoding='utf-8'))
    fe = find_export(font_name, "Font")
    orig_body = bytes(src[fe['serialOffset']:fe['serialOffset'] + fe['serialSize']])

    io_s, io_e = find_tag(orig_body, "ImportOptions")
    io_bytes = orig_body[io_s:io_e]
    netindex = orig_body[:4]

    chars = meta['characters']
    ch_body = bytearray(); ch_body.extend(pi(len(chars)))
    for c in chars:
        ch_body.extend(pi(c['startU'])); ch_body.extend(pi(c['startV']))
        ch_body.extend(pi(c['uSize'])); ch_body.extend(pi(c['vSize']))
        ch_body.append(c['texIdx'] & 0xFF)
        ch_body.extend(pi(c['vOff']))

    tex_refs = [t['ref'] for t in dump['textures']]
    tx_body = bytearray(); tx_body.extend(pi(len(tex_refs)))
    for r in tex_refs: tx_body.extend(pi(r))

    out = bytearray()
    out.extend(netindex)
    out.extend(make_tag("Characters", "ArrayProperty", len(ch_body))); out.extend(ch_body)
    out.extend(make_tag("Textures", "ArrayProperty", len(tx_body))); out.extend(tx_body)
    out.extend(make_tag("IsRemapped", "IntProperty", 4)); out.extend(pi(1))
    out.extend(make_tag("EmScale", "FloatProperty", 4)); out.extend(struct.pack('<f', dump['emScale']))
    out.extend(make_tag("Ascent", "FloatProperty", 4)); out.extend(struct.pack('<f', dump['ascent']))
    out.extend(make_tag("Descent", "FloatProperty", 4)); out.extend(struct.pack('<f', dump['descent']))
    out.extend(io_bytes)
    out.extend(pi(none_idx)); out.extend(pi(0))
    remap = meta['remap']
    out.extend(pi(len(remap)))
    for r in remap:
        out.extend(pu16(r['key'])); out.extend(pu16(r['val']))

    orig_size = fe['serialSize']
    if len(out) > orig_size:
        raise RuntimeError(f"{font_name}: body {len(out)} > orig {orig_size}")
    pad = orig_size - len(out)
    out.extend(b'\x00' * pad)
    src[fe['serialOffset']:fe['serialOffset'] + orig_size] = bytes(out)
    print(f"  {font_name}: {len(out)-pad} bytes + {pad} pad = {orig_size}")

for cfg in CONFIGS:
    print(f"\n=== {cfg['font_name']} ===")
    meta = json.loads(Path(cfg['meta']).read_text(encoding='utf-8'))
    bc3 = Path(cfg['bc3']).read_bytes()
    replace_texture2d(cfg['texture_name'], bc3)
    build_ufont_body(cfg['font_name'], meta)

OUT.write_bytes(bytes(src))
print(f"\n[STEP] Wrote {OUT} ({len(src)} bytes)")
