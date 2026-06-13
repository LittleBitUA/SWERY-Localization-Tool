"""
МІНІМАЛЬНИЙ repack — БЕЗ зсувів offsets:
  - Texture2D_82: BC3 swap (зберігаємо розмір=260096).
  - Texture2D_83: НЕ ЧІПАЄМО.
  - talkfont: новий body (UA Characters texIdx=0 + UA CharRemap), PADDING
    до оригінального SerialSize 0xDF39 (нулями). Це гарантує, що інші
    exports на своїх місцях.

Очікувані ризики:
  - Гра може не любити trailing zeros у UFont. Тоді пробуємо інший варіант.
"""

import json
import struct
from pathlib import Path

SRC_UPK = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk")
OUT_UPK = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_min.upk")
EXPORTS_JSON = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json")
TALKFONT_META = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/talkfont_meta.json")
ATLAS0_BC3 = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/atlas0.bc3.bin")
ORIG_TALKFONT_JSON = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_orig.json")

def i32(b, p): return struct.unpack_from('<i', b, p)[0]
def pack_i32(v): return struct.pack('<i', v)
def pack_u16(v): return struct.pack('<H', v)

src = bytearray(SRC_UPK.read_bytes())
info = json.loads(EXPORTS_JSON.read_text(encoding="utf-8"))
meta = json.loads(TALKFONT_META.read_text(encoding="utf-8"))
orig_tf_dump = json.loads(ORIG_TALKFONT_JSON.read_text(encoding="utf-8"))

names = info["names"]
exports = info["exports"]

def name_idx(s):
    try: return names.index(s)
    except ValueError: raise RuntimeError(f"No name '{s}'")

def find_export(name, klass):
    for e in exports:
        if e["objectName"] == name and e["className"] == klass:
            return e
    raise KeyError(name)

# 1) Texture2D_82 BC3 swap (in-place, payload at known offset).
tx82 = find_export("Texture2D_82", "Texture2D")
print(f"Texture2D_82: SerialOffset=0x{tx82['serialOffset']:x} SerialSize=0x{tx82['serialSize']:x}")

# Mip[0] payload starts at SerialOffset + (props_end + 8 + 16 + 4 + 16) bytes.
# Простіше: знаходимо payload offset через його старий зміст: перші байти BC3
# block. Або з memo: payload at 0x1676196.
# Sanity-check: peek 8 bytes — мають бути BC3-pattern (наш encoder подібний).
payload_off = 0x1676196
old_first = bytes(src[payload_off:payload_off+8])
print(f"  Old payload[0..8]: {old_first.hex(' ')}")
bc0 = ATLAS0_BC3.read_bytes()
assert len(bc0) == 260096, f"BC3 size mismatch: {len(bc0)}"
src[payload_off:payload_off+len(bc0)] = bc0
print(f"  Swapped {len(bc0)} bytes at 0x{payload_off:x}")

# 2) talkfont: build new body, pad to orig SerialSize.
tf = find_export("talkfont", "Font")
orig_tf_body = bytes(src[tf["serialOffset"]:tf["serialOffset"] + tf["serialSize"]])
print(f"talkfont: SerialOffset=0x{tf['serialOffset']:x} SerialSize={tf['serialSize']}")

none_idx = name_idx("None")

# Знаходимо None tag у оригіналі (з нашим walker логіком).
def find_none(body):
    p = 4
    while p + 24 <= len(body):
        nidx = i32(body, p); p += 8
        if nidx == none_idx: return p - 8
        type_idx = i32(body, p); p += 8
        size = i32(body, p); p += 4
        arrIdx = i32(body, p); p += 4
        tn = names[type_idx]
        if tn == "ByteProperty": p += size + 8
        elif tn == "BoolProperty": p += size + 1
        elif tn == "StructProperty": p += 8 + size
        else: p += size
    return -1

none_pos = find_none(orig_tf_body)
print(f"  Original None tag at body offset 0x{none_pos:x}")

# Знаходимо ImportOptions tag block (для копії).
def find_tag(body, tag_name):
    p = 4
    while p + 24 <= len(body):
        nidx = i32(body, p)
        if nidx == none_idx: return -1, -1
        start = p; p += 8
        type_idx = i32(body, p); p += 8
        size = i32(body, p); p += 4
        arrIdx = i32(body, p); p += 4
        tn = names[type_idx]; nn = names[nidx]
        body_extra = 0
        if tn == "ByteProperty": body_extra = 8
        elif tn == "BoolProperty": body_extra = 1
        elif tn == "StructProperty": body_extra = 8
        if nn == tag_name:
            return start, p + size + body_extra
        p += size + body_extra
    return -1, -1

io_start, io_end = find_tag(orig_tf_body, "ImportOptions")
import_options_bytes = orig_tf_body[io_start:io_end]
print(f"  ImportOptions block: {len(import_options_bytes)} bytes")

# Будуємо новий body.
def make_tag(name, ttype, size, arr_idx=0):
    return (pack_i32(name_idx(name)) + pack_i32(0) +
            pack_i32(name_idx(ttype)) + pack_i32(0) +
            pack_i32(size) + pack_i32(arr_idx))

characters = meta["characters"]
remap = meta["remap"]
textures_refs = [t["ref"] for t in orig_tf_dump["textures"]]

# Characters body.
ch_body = bytearray()
ch_body.extend(pack_i32(len(characters)))
for c in characters:
    ch_body.extend(pack_i32(c["startU"]))
    ch_body.extend(pack_i32(c["startV"]))
    ch_body.extend(pack_i32(c["uSize"]))
    ch_body.extend(pack_i32(c["vSize"]))
    ch_body.append(c["texIdx"] & 0xFF)
    ch_body.extend(pack_i32(c["vOff"]))

# Textures body.
tx_body = bytearray()
tx_body.extend(pack_i32(len(textures_refs)))
for r in textures_refs:
    tx_body.extend(pack_i32(r))

out = bytearray()
out.extend(orig_tf_body[:4])    # NetIndex
out.extend(make_tag("Characters", "ArrayProperty", len(ch_body)))
out.extend(ch_body)
out.extend(make_tag("Textures", "ArrayProperty", len(tx_body)))
out.extend(tx_body)
out.extend(make_tag("IsRemapped", "IntProperty", 4))
out.extend(pack_i32(1))
out.extend(make_tag("EmScale", "FloatProperty", 4))
out.extend(struct.pack('<f', orig_tf_dump["emScale"]))
out.extend(make_tag("Ascent", "FloatProperty", 4))
out.extend(struct.pack('<f', orig_tf_dump["ascent"]))
out.extend(make_tag("Descent", "FloatProperty", 4))
out.extend(struct.pack('<f', orig_tf_dump["descent"]))
out.extend(import_options_bytes)
out.extend(pack_i32(none_idx)); out.extend(pack_i32(0))
out.extend(pack_i32(len(remap)))
for r in remap:
    out.extend(pack_u16(r["key"])); out.extend(pack_u16(r["val"]))

print(f"  New body: {len(out)} bytes (orig was {tf['serialSize']})")
orig_size = tf["serialSize"]
if len(out) > orig_size:
    raise RuntimeError(f"New body bigger than orig: {len(out)} > {orig_size}")
# Padding нулями до original size.
pad = orig_size - len(out)
out.extend(b'\x00' * pad)
print(f"  Padded with {pad} zero bytes")

# Записуємо in-place.
src[tf["serialOffset"]:tf["serialOffset"] + orig_size] = bytes(out)

OUT_UPK.write_bytes(bytes(src))
print(f"[STEP] Wrote {OUT_UPK} ({len(src)} bytes)")
