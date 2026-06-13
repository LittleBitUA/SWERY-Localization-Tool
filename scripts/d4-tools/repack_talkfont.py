"""
Пакує новий Ms01Utility_LOC_INT.upk із заміною:
  - Texture2D_82 → atlas0.bc3.bin (508×512)
  - Texture2D_83 → atlas1.bc3.bin (512×1024) — SizeY змінюється з 512 на 1024
  - talkfont (Font) → нові Characters + CharRemap масиви

Усі інші exports — копіюємо як є з оригіналу.

Підхід:
  1. Читаємо raw bytes оригінального .upk.
  2. З exports.json (probe-exports.ps1) — знаємо ClassName/ObjectName/SerialSize/SerialOffset
     кожного export-а.
  3. Bootstrap-знаходимо stride FObjectExport у raw bytes (як у d4-text-import.ps1).
  4. Будуємо новий body для 3-х cited exports; для решти — копіюємо.
  5. Sort exports у порядку original SerialOffset.
  6. Перерахуємо new SerialOffsets (всі підряд, починаючи з body start = першого
     orig export-а, або з HeaderSize-aligned).
  7. У header/ExportTable патчимо SerialSize + SerialOffset для всіх exports.
  8. Записуємо новий файл.
"""

import json
import struct
import sys
from pathlib import Path

# ──────────────────────────────────────────────────────────────
# Параметри
# ──────────────────────────────────────────────────────────────
SRC_UPK = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk")
OUT_UPK = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT_UA.upk")
EXPORTS_JSON = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json")
TALKFONT_META = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/talkfont_meta.json")
ATLAS0_BC3 = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/atlas0.bc3.bin")
ATLAS1_BC3 = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_UA/atlas1.bc3.bin")
ORIG_TALKFONT_JSON = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_orig.json")

ATLAS0_SX, ATLAS0_SY = 508, 512
ATLAS1_SX, ATLAS1_SY = 512, 1024

# ──────────────────────────────────────────────────────────────
# Утиліти
# ──────────────────────────────────────────────────────────────
def i32(b, p): return struct.unpack_from('<i', b, p)[0]
def u32(b, p): return struct.unpack_from('<I', b, p)[0]
def pack_i32(v): return struct.pack('<i', v)
def pack_u32(v): return struct.pack('<I', v)
def pack_u16(v): return struct.pack('<H', v)

# ──────────────────────────────────────────────────────────────
# Завантаження
# ──────────────────────────────────────────────────────────────
print(f"[STEP] Reading {SRC_UPK}")
src_bytes = SRC_UPK.read_bytes()
exports_info = json.loads(EXPORTS_JSON.read_text(encoding="utf-8"))
meta = json.loads(TALKFONT_META.read_text(encoding="utf-8"))
orig_talkfont = json.loads(ORIG_TALKFONT_JSON.read_text(encoding="utf-8"))

names = exports_info["names"]
exports = exports_info["exports"]
exports_offset = exports_info["exportOffset"]
header_size = exports_info["headerSize"]

# Знаходимо name idx за рядком.
def name_idx(s):
    try:
        return names.index(s)
    except ValueError:
        return -1

# Bootstrap stride FObjectExport.
e0, e1 = exports[0], exports[1]
pat0 = pack_i32(e0["serialSize"]) + pack_i32(e0["serialOffset"])
pat1 = pack_i32(e1["serialSize"]) + pack_i32(e1["serialOffset"])
pos0 = src_bytes.find(pat0, exports_offset)
pos1 = src_bytes.find(pat1, exports_offset)
if pos0 < 0 or pos1 < 0:
    raise RuntimeError("Cannot bootstrap FObjectExport stride")
stride = pos1 - pos0
serialSizeOffsetInEntry = (pos0 - exports_offset) % stride
print(f"[DIAG] FObjectExport stride={stride} bytes, SerialSize@entry+{serialSizeOffsetInEntry}")

# ──────────────────────────────────────────────────────────────
# Будуємо новий body для Texture2D
# ──────────────────────────────────────────────────────────────
def find_export(name, klass="Texture2D"):
    for e in exports:
        if e["objectName"] == name and e["className"] == klass:
            return e
    raise KeyError(name)

def find_name_string_or_none(s):
    idx = name_idx(s)
    if idx < 0:
        raise RuntimeError(f"Name '{s}' not in NameTable")
    return idx

# Скан DefaultProperties зі StructProperty +8 квирком; повертає (tail_offset).
# tail_offset вказує на початок "None" tag (8 байт name+inst).
def find_none_tag(body, none_idx):
    # body — bytes export тіла. Перший 4 байти = NetIndex.
    p = 4
    while p + 24 <= len(body):
        name = i32(body, p)
        p += 8     # name+inst
        if name == none_idx:
            return p - 8
        type_idx = i32(body, p); p += 8     # type+inst
        size = i32(body, p); p += 4
        arrIdx = i32(body, p); p += 4
        type_name = names[type_idx]
        if type_name == "ByteProperty":
            p += size + 8
        elif type_name == "BoolProperty":
            p += size + 1
        elif type_name == "StructProperty":
            p += 8 + size       # +8 struct type FName
        else:
            p += size
    return -1

# Знаходимо позицію SizeY IntProperty body всередині Texture2D body.
# Повертає (size_y_value_offset, current_value) — щоб патчити на 1024.
def find_int_prop_value_offset(body, prop_name):
    none_idx = find_name_string_or_none("None")
    target_name_idx = find_name_string_or_none(prop_name)
    p = 4
    while p + 24 <= len(body):
        name = i32(body, p)
        p += 8
        if name == none_idx:
            return -1, 0
        type_idx = i32(body, p); p += 8
        size = i32(body, p); p += 4
        arrIdx = i32(body, p); p += 4
        type_name = names[type_idx]
        if name == target_name_idx and type_name == "IntProperty":
            return p, i32(body, p)
        if type_name == "ByteProperty":   p += size + 8
        elif type_name == "BoolProperty": p += size + 1
        elif type_name == "StructProperty": p += 8 + size
        else:                             p += size
    return -1, 0

def build_texture2d_body(orig_body, new_bc3, new_size_x, new_size_y):
    """Build new Texture2D export body. Preserves trailing 44 bytes (GUID + meta)
    from the original verbatim."""
    none_idx = find_name_string_or_none("None")
    none_pos = find_none_tag(orig_body, none_idx)
    if none_pos < 0:
        raise RuntimeError("Cannot find None tag in Texture2D body")

    # Знаходимо trailing-data у оригіналі: після SizeY mip[0] до кінця body.
    # Layout original:
    #   props ... None ... SourceArt(16) MipCount(4) MipHdr(16) Payload(N) SizeX(4) SizeY(4) [trailing...]
    p = none_pos + 8                      # після None tag
    p += 16                                # SourceArt
    orig_mip_count = i32(orig_body, p); p += 4
    if orig_mip_count != 1:
        print(f"  [WARN] original MipCount={orig_mip_count}, expecting 1")
    # Mip[0] header.
    orig_payload_size = i32(orig_body, p + 4)
    p += 16
    p += orig_payload_size
    p += 8                                 # SizeX + SizeY
    trailing = orig_body[p:]
    print(f"  [DIAG] preserved trailing: {len(trailing)} bytes")

    # Patch SizeY in DefaultProperties.
    props = bytearray(orig_body[:none_pos])
    sy_off, sy_val = find_int_prop_value_offset(props, "SizeY")
    if sy_off > 0 and sy_val != new_size_y:
        struct.pack_into('<i', props, sy_off, new_size_y)
        print(f"  [DIAG] patched SizeY: {sy_val} -> {new_size_y}")
    osy_off, osy_val = find_int_prop_value_offset(props, "OriginalSizeY")
    if osy_off > 0 and osy_val != new_size_y:
        struct.pack_into('<i', props, osy_off, new_size_y)
        print(f"  [DIAG] patched OriginalSizeY: {osy_val} -> {new_size_y}")

    out = bytearray()
    out.extend(props)
    out.extend(pack_i32(none_idx)); out.extend(pack_i32(0))
    # SourceArt empty.
    out.extend(pack_i32(0)); out.extend(pack_i32(0)); out.extend(pack_i32(0)); out.extend(pack_i32(0))
    # MipCount = 1.
    out.extend(pack_i32(1))
    # Mip[0] header.
    out.extend(pack_i32(0)); out.extend(pack_i32(len(new_bc3)))
    out.extend(pack_i32(len(new_bc3))); out.extend(pack_i32(0))
    out.extend(new_bc3)
    out.extend(pack_i32(new_size_x)); out.extend(pack_i32(new_size_y))
    out.extend(trailing)
    return bytes(out)

# ──────────────────────────────────────────────────────────────
# Будуємо новий body для UFont (talkfont)
# ──────────────────────────────────────────────────────────────
def make_tag(name, ttype, size, arr_idx=0):
    """Створює 24-байтовий PropertyTag header."""
    return (pack_i32(name_idx(name)) + pack_i32(0) +
            pack_i32(name_idx(ttype)) + pack_i32(0) +
            pack_i32(size) + pack_i32(arr_idx))

def build_ufont_body(orig_body, characters, remap, textures_refs,
                     em_scale, ascent, descent, is_remapped):
    """Build talkfont UFont export body."""
    none_idx = find_name_string_or_none("None")

    # Будуємо Characters array body.
    chars_body = bytearray()
    chars_body.extend(pack_i32(len(characters)))
    for c in characters:
        chars_body.extend(pack_i32(c["startU"]))
        chars_body.extend(pack_i32(c["startV"]))
        chars_body.extend(pack_i32(c["uSize"]))
        chars_body.extend(pack_i32(c["vSize"]))
        chars_body.append(c["texIdx"] & 0xFF)
        chars_body.extend(pack_i32(c["vOff"]))

    # Textures array body.
    tex_body = bytearray()
    tex_body.extend(pack_i32(len(textures_refs)))
    for r in textures_refs:
        tex_body.extend(pack_i32(r))

    # Знайдемо ImportOptions у оригіналі — копіюємо як є (з tag header + struct type FName).
    p = 4
    import_options_bytes = None
    while p + 24 <= len(orig_body):
        nidx = i32(orig_body, p)
        if nidx == none_idx:
            break
        tag_start = p
        p += 8
        type_idx = i32(orig_body, p); p += 8
        size = i32(orig_body, p); p += 4
        arrIdx = i32(orig_body, p); p += 4
        type_name = names[type_idx]
        tag_name = names[nidx]
        body_size = size
        if type_name == "ByteProperty":
            body_size = size + 8
        elif type_name == "BoolProperty":
            body_size = size + 1
        elif type_name == "StructProperty":
            body_size = 8 + size
        if tag_name == "ImportOptions":
            import_options_bytes = bytes(orig_body[tag_start:p + body_size])
        p += body_size
    if import_options_bytes is None:
        raise RuntimeError("ImportOptions not found in original UFont")
    print(f"  [DIAG] ImportOptions tag block: {len(import_options_bytes)} bytes")

    # Емітимо нові DefaultProperties.
    out = bytearray()
    out.extend(orig_body[:4])          # NetIndex.
    # Characters.
    out.extend(make_tag("Characters", "ArrayProperty", len(chars_body)))
    out.extend(chars_body)
    # Textures.
    out.extend(make_tag("Textures", "ArrayProperty", len(tex_body)))
    out.extend(tex_body)
    # IsRemapped.
    out.extend(make_tag("IsRemapped", "IntProperty", 4))
    out.extend(pack_i32(is_remapped))
    # EmScale.
    out.extend(make_tag("EmScale", "FloatProperty", 4))
    out.extend(struct.pack('<f', em_scale))
    # Ascent.
    out.extend(make_tag("Ascent", "FloatProperty", 4))
    out.extend(struct.pack('<f', ascent))
    # Descent.
    out.extend(make_tag("Descent", "FloatProperty", 4))
    out.extend(struct.pack('<f', descent))
    # ImportOptions (copy verbatim).
    out.extend(import_options_bytes)
    # None tag.
    out.extend(pack_i32(none_idx))
    out.extend(pack_i32(0))
    # CharRemap: int32 count + N × (u16 key, u16 val).
    out.extend(pack_i32(len(remap)))
    for r in remap:
        out.extend(pack_u16(r["key"]))
        out.extend(pack_u16(r["val"]))
    return bytes(out)

# ──────────────────────────────────────────────────────────────
# Основний цикл — будуємо нові bodies
# ──────────────────────────────────────────────────────────────
print("[STEP] Building new bodies for modified exports")

new_bodies = {}      # index → bytes

# Texture2D_82.
tx82 = find_export("Texture2D_82", "Texture2D")
orig_tx82 = src_bytes[tx82["serialOffset"]:tx82["serialOffset"] + tx82["serialSize"]]
bc0 = ATLAS0_BC3.read_bytes()
new_tx82 = build_texture2d_body(orig_tx82, bc0, ATLAS0_SX, ATLAS0_SY)
new_bodies[tx82["index"]] = new_tx82
print(f"  Texture2D_82: {tx82['serialSize']} -> {len(new_tx82)} bytes")

# Texture2D_83.
tx83 = find_export("Texture2D_83", "Texture2D")
orig_tx83 = src_bytes[tx83["serialOffset"]:tx83["serialOffset"] + tx83["serialSize"]]
bc1 = ATLAS1_BC3.read_bytes()
new_tx83 = build_texture2d_body(orig_tx83, bc1, ATLAS1_SX, ATLAS1_SY)
new_bodies[tx83["index"]] = new_tx83
print(f"  Texture2D_83: {tx83['serialSize']} -> {len(new_tx83)} bytes")

# talkfont (UFont).
tf = find_export("talkfont", "Font")
orig_tf = src_bytes[tf["serialOffset"]:tf["serialOffset"] + tf["serialSize"]]
# Беремо текстури з оригіналу (13 refs), щоб не плодити сюрпризи.
textures_refs = [t["ref"] for t in orig_talkfont["textures"]]
new_tf = build_ufont_body(
    orig_tf,
    meta["characters"],
    meta["remap"],
    textures_refs,
    em_scale=orig_talkfont["emScale"],
    ascent=orig_talkfont["ascent"],
    descent=orig_talkfont["descent"],
    is_remapped=1,
)
new_bodies[tf["index"]] = new_tf
print(f"  talkfont: {tf['serialSize']} -> {len(new_tf)} bytes")

# ──────────────────────────────────────────────────────────────
# Сортуємо exports у порядку SerialOffset → перерахуємо нові
# ──────────────────────────────────────────────────────────────
sorted_exports = sorted(exports, key=lambda e: e["serialOffset"])
first_offset = sorted_exports[0]["serialOffset"]
print(f"[STEP] First body offset (orig): 0x{first_offset:x}")

new_serial_offsets = {}        # index → new offset
new_serial_sizes = {}          # index → new size
cur = first_offset
for e in sorted_exports:
    idx = e["index"]
    if idx in new_bodies:
        body = new_bodies[idx]
    else:
        body = src_bytes[e["serialOffset"]:e["serialOffset"] + e["serialSize"]]
    new_serial_offsets[idx] = cur
    new_serial_sizes[idx] = len(body)
    new_bodies[idx] = body
    cur += len(body)
new_file_size = cur
print(f"[STEP] New file size: {new_file_size} bytes (orig was {len(src_bytes)})")

# ──────────────────────────────────────────────────────────────
# Будуємо новий файл
# ──────────────────────────────────────────────────────────────
print("[STEP] Building new file")
out_bytes = bytearray(src_bytes[:first_offset])     # header + tables до першого body

# Патчимо ExportTable: для кожного export-а — нові SerialSize/SerialOffset.
# Entry start = exports_offset + idx * stride.
# SerialSize @ entry + serialSizeOffsetInEntry, SerialOffset @ entry + serialSizeOffsetInEntry + 4.
for e in exports:
    idx = e["index"]
    entry_start = exports_offset + idx * stride
    sz_off = entry_start + serialSizeOffsetInEntry
    struct.pack_into('<i', out_bytes, sz_off, new_serial_sizes[idx])
    struct.pack_into('<i', out_bytes, sz_off + 4, new_serial_offsets[idx])

# Конкатенуємо bodies у порядку sorted_exports.
for e in sorted_exports:
    out_bytes.extend(new_bodies[e["index"]])

OUT_UPK.write_bytes(out_bytes)
print(f"[STEP] Wrote {OUT_UPK} ({len(out_bytes)} bytes)")
