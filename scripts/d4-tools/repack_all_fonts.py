"""
Комбінований minimal repack для всіх 4 шрифтів які впливають на subtitle:
  - talkfont      (Texture2D_82, atlas0 508x512)
  - newcinema     (Texture2D_7,  atlas0 512x512)
  - newcinema_s   (Texture2D_105, atlas0 512x512)
  - shadowfont    (Texture2D_69, atlas0 508x512)

Тільки BC3 swap + UFont body padded до original SerialSize → жодних зсувів.
"""
import json, struct
from pathlib import Path

SRC = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk")
OUT = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_all.upk")
INFO = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json")

# Конфіги: (font_name, texture_name, meta_json, bc3_bin, font_json_orig)
TALK_META = r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/talkfont_meta.json"
TALK_BC3  = r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/atlas0.bc3.bin"
NC_META   = r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema_UA/newcinema_meta.json"
NC_BC3    = r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema_UA/atlas.bc3.bin"
SH_META   = r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/shadowfont_UA/shadowfont_meta.json"
SH_BC3    = r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/shadowfont_UA/atlas.bc3.bin"

FONTS = [
    {"font": "talkfont",    "tex": "Texture2D_82",
     "meta": TALK_META, "bc3": TALK_BC3,
     "orig_json": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_orig.json"},
    {"font": "newcinema",   "tex": "Texture2D_7",
     "meta": NC_META, "bc3": NC_BC3,
     "orig_json": r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/newcinema.json"},
    # newcinema_s тимчасово прибрано для діагностики (overlap при включенні).
]

def i32(b,p): return struct.unpack_from('<i', b, p)[0]
def pi(v): return struct.pack('<i', v)
def pu16(v): return struct.pack('<H', v)

src = bytearray(SRC.read_bytes())
info = json.loads(INFO.read_text(encoding='utf-8'))
names = info['names']
exports = info['exports']

def ni(s):
    return names.index(s)

def find(name, klass):
    for e in exports:
        if e['objectName'] == name and e['className'] == klass: return e
    raise KeyError(name)

none_idx = ni("None")

def find_none(b):
    p = 4
    while p+24 <= len(b):
        nidx = i32(b,p); p += 8
        if nidx == none_idx: return p-8
        ti = i32(b,p); p += 8
        sz = i32(b,p); p += 4
        ai = i32(b,p); p += 4
        tn = names[ti]
        if tn == "ByteProperty": p += sz+8
        elif tn == "BoolProperty": p += sz+1
        elif tn == "StructProperty": p += 8+sz
        else: p += sz
    return -1

def find_tag(b, name):
    p = 4
    while p+24 <= len(b):
        nidx = i32(b,p)
        if nidx == none_idx: return -1,-1
        start = p; p += 8
        ti = i32(b,p); p += 8
        sz = i32(b,p); p += 4
        ai = i32(b,p); p += 4
        extra = 0
        tn = names[ti]; nn = names[nidx]
        if tn == "ByteProperty": extra = 8
        elif tn == "BoolProperty": extra = 1
        elif tn == "StructProperty": extra = 8
        if nn == name: return start, p+sz+extra
        p += sz + extra
    return -1,-1

def tag(name, typ, sz, ai=0):
    return pi(ni(name))+pi(0)+pi(ni(typ))+pi(0)+pi(sz)+pi(ai)

for cfg in FONTS:
    print(f"\n=== {cfg['font']} (atlas={cfg['tex']}) ===")
    meta = json.loads(Path(cfg['meta']).read_text(encoding='utf-8'))
    orig_dump = json.loads(Path(cfg['orig_json']).read_text(encoding='utf-8'))
    bc3 = Path(cfg['bc3']).read_bytes()

    # 1) BC3 swap.
    tx = find(cfg['tex'], "Texture2D")
    tbody = bytes(src[tx['serialOffset']:tx['serialOffset']+tx['serialSize']])
    npos = find_none(tbody)
    mip0 = npos + 8 + 16 + 4
    payload_off = tx['serialOffset'] + mip0 + 16
    old_sz = i32(tbody, mip0 + 4)
    if len(bc3) != old_sz:
        print(f"  SKIP {cfg['tex']}: BC3 size mismatch {len(bc3)} != {old_sz}")
        continue
    src[payload_off:payload_off+len(bc3)] = bc3
    print(f"  Texture2D swap: {len(bc3)} bytes @ 0x{payload_off:x}")

    # 2) UFont body.
    fe = find(cfg['font'], "Font")
    orig_body = bytes(src[fe['serialOffset']:fe['serialOffset']+fe['serialSize']])
    io_s, io_e = find_tag(orig_body, "ImportOptions")
    io_bytes = orig_body[io_s:io_e]

    chars = meta['characters']
    remap = meta['remap']
    tex_refs = [t['ref'] for t in orig_dump['textures']]

    ch = bytearray(); ch.extend(pi(len(chars)))
    for c in chars:
        ch.extend(pi(c['startU'])); ch.extend(pi(c['startV']))
        ch.extend(pi(c['uSize']));  ch.extend(pi(c['vSize']))
        ch.append(c['texIdx'] & 0xFF); ch.extend(pi(c['vOff']))

    txa = bytearray(); txa.extend(pi(len(tex_refs)))
    for r in tex_refs: txa.extend(pi(r))

    out = bytearray()
    out.extend(orig_body[:4])
    out.extend(tag("Characters", "ArrayProperty", len(ch))); out.extend(ch)
    out.extend(tag("Textures", "ArrayProperty", len(txa))); out.extend(txa)
    out.extend(tag("IsRemapped", "IntProperty", 4)); out.extend(pi(1))
    out.extend(tag("EmScale", "FloatProperty", 4)); out.extend(struct.pack('<f', orig_dump['emScale']))
    out.extend(tag("Ascent",  "FloatProperty", 4)); out.extend(struct.pack('<f', orig_dump['ascent']))
    out.extend(tag("Descent", "FloatProperty", 4)); out.extend(struct.pack('<f', orig_dump['descent']))
    out.extend(io_bytes)
    out.extend(pi(none_idx)); out.extend(pi(0))
    out.extend(pi(len(remap)))
    for r in remap:
        out.extend(pu16(r['key'])); out.extend(pu16(r['val']))

    orig_sz = fe['serialSize']
    if len(out) > orig_sz:
        print(f"  ERROR: {cfg['font']} body too big {len(out)} > {orig_sz}")
        continue
    pad = orig_sz - len(out)
    out.extend(b'\x00' * pad)
    src[fe['serialOffset']:fe['serialOffset']+orig_sz] = bytes(out)
    print(f"  UFont body: {len(out)-pad} bytes + {pad} pad = {orig_sz}")

OUT.write_bytes(bytes(src))
print(f"\n[STEP] Wrote {OUT} ({len(src)} bytes)")
