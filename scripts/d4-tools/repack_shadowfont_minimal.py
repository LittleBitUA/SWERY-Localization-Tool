"""
МІНІМАЛЬНИЙ repack newcinema: BC3 swap Texture2D_7 + UFont newcinema body
з UA-CharRemap, padded до original size.
Цей файл наслідує structure від repack_talkfont_minimal.py.
"""
import json, struct
from pathlib import Path

SRC = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_min2.upk")
OUT = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_min3.upk")
INFO = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json")
META = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/shadowfont_UA/shadowfont_meta.json")
BC3 = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/shadowfont_UA/atlas.bc3.bin")
NC_JSON = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/shadowfont.json")

def i32(b,p): return struct.unpack_from('<i', b, p)[0]
def pi(v): return struct.pack('<i', v)
def pu16(v): return struct.pack('<H', v)

src = bytearray(SRC.read_bytes())
info = json.loads(INFO.read_text(encoding='utf-8'))
meta = json.loads(META.read_text(encoding='utf-8'))
nc = json.loads(NC_JSON.read_text(encoding='utf-8'))
names = info['names']
exports = info['exports']

def ni(s):
    try: return names.index(s)
    except: raise RuntimeError(f"no name '{s}'")
def find(name, klass):
    for e in exports:
        if e['objectName']==name and e['className']==klass: return e
    raise KeyError(name)

# 1) Texture2D_7 BC3 swap.
tx = find("Texture2D_69", "Texture2D")
print(f"Texture2D_7: SerialOffset=0x{tx['serialOffset']:x} SerialSize={tx['serialSize']}")
# Знаходимо payload offset — потрібно парсити body. Використаємо memo логiку.
none_idx = ni("None")
body = bytes(src[tx['serialOffset']:tx['serialOffset']+tx['serialSize']])
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
none_pos = find_none(body)
mip0_hdr = none_pos + 8 + 16 + 4   # None tag + SourceArt + MipCount
payload_off_in_body = mip0_hdr + 16
payload_off = tx['serialOffset'] + payload_off_in_body
print(f"  Mip[0] payload at file offset 0x{payload_off:x}")
bc3 = BC3.read_bytes()
old_size = i32(body, mip0_hdr + 4)
print(f"  Old payload size: {old_size}, new: {len(bc3)}")
assert len(bc3) == old_size, f"size mismatch {len(bc3)} != {old_size}"
src[payload_off:payload_off+len(bc3)] = bc3
print(f"  Swapped {len(bc3)} bytes")

# 2) newcinema UFont.
font = find("shadowfont", "Font")
orig = bytes(src[font['serialOffset']:font['serialOffset']+font['serialSize']])
print(f"newcinema: SerialOffset=0x{font['serialOffset']:x} SerialSize={font['serialSize']}")

# Знаходимо ImportOptions блок для копії.
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

io_s, io_e = find_tag(orig, "ImportOptions")
io_bytes = orig[io_s:io_e]
print(f"  ImportOptions: {len(io_bytes)} bytes")

def tag(name, typ, sz, ai=0):
    return pi(ni(name))+pi(0)+pi(ni(typ))+pi(0)+pi(sz)+pi(ai)

chars = meta['characters']
remap = meta['remap']
tex_refs = [t['ref'] for t in nc['textures']]

ch_body = bytearray()
ch_body.extend(pi(len(chars)))
for c in chars:
    ch_body.extend(pi(c['startU']))
    ch_body.extend(pi(c['startV']))
    ch_body.extend(pi(c['uSize']))
    ch_body.extend(pi(c['vSize']))
    ch_body.append(c['texIdx'] & 0xFF)
    ch_body.extend(pi(c['vOff']))

tx_body = bytearray()
tx_body.extend(pi(len(tex_refs)))
for r in tex_refs: tx_body.extend(pi(r))

out = bytearray()
out.extend(orig[:4])
out.extend(tag("Characters", "ArrayProperty", len(ch_body)))
out.extend(ch_body)
out.extend(tag("Textures", "ArrayProperty", len(tx_body)))
out.extend(tx_body)
out.extend(tag("IsRemapped", "IntProperty", 4))
out.extend(pi(nc['isRemapped'] if nc['isRemapped'] is not None else 1))
out.extend(tag("EmScale", "FloatProperty", 4))
out.extend(struct.pack('<f', nc['emScale']))
out.extend(tag("Ascent", "FloatProperty", 4))
out.extend(struct.pack('<f', nc['ascent']))
out.extend(tag("Descent", "FloatProperty", 4))
out.extend(struct.pack('<f', nc['descent']))
out.extend(io_bytes)
out.extend(pi(none_idx)); out.extend(pi(0))
out.extend(pi(len(remap)))
for r in remap:
    out.extend(pu16(r['key'])); out.extend(pu16(r['val']))

print(f"  New body: {len(out)} bytes (orig {font['serialSize']})")
if len(out) > font['serialSize']:
    raise RuntimeError(f"too big: {len(out)} > {font['serialSize']}")
pad = font['serialSize'] - len(out)
out.extend(b'\x00' * pad)
print(f"  Padded {pad} bytes")

src[font['serialOffset']:font['serialOffset']+font['serialSize']] = bytes(out)

OUT.write_bytes(bytes(src))
print(f"Wrote {OUT} ({len(src)} bytes)")
