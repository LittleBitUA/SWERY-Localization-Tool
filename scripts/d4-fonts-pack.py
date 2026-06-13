"""
D4 Fonts Pack — portable repack для D4: вставляє згенеровані UA-атласи назад
у uncompressed Ms01Utility_LOC_INT.upk. Без variable-stride ExportTable
патчингу: всі заміни SAME-SIZE (texture mip0 payload не міняє розмір, UFont
body пакується назад у orig size з padding нулями).

Вхід — JSON config:
{
  "srcUpk":       "/path/to/Ms01Utility_LOC_INT.upk",
  "outUpk":       "/path/to/output.upk",
  "exportsJson":  "/path/to/exports.json",   // дамп probe-exports.ps1
  "fonts": [
    {
      "name": "newcinema",
      "type": "paired",                    // або "single"
      "shadow": "newcinema_s",             // лише для paired
      "originalMetaJson": "/path/to/Meta/newcinema.json",
      "originalShadowMetaJson": "/path/to/Meta/newcinema_s.json",  // paired
      "generatedDir": "/path/to/Generated/newcinema/"
    }
  ]
}

Емітить:
  [STEP]/[INFO]/[ERR] + RESULT_JSON
"""
import json, struct, sys
from pathlib import Path

if len(sys.argv) < 2:
    print("Usage: d4-fonts-pack.py <config.json>")
    sys.exit(1)

CFG = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

SRC_UPK = Path(CFG["srcUpk"])
OUT_UPK = Path(CFG["outUpk"])
EXPORTS = json.loads(Path(CFG["exportsJson"]).read_text(encoding="utf-8"))

print(f"[INFO] src={SRC_UPK}")
print(f"[INFO] out={OUT_UPK}")

src = bytearray(SRC_UPK.read_bytes())
names = EXPORTS["names"]
exports = EXPORTS["exports"]

def i32(b, p): return struct.unpack_from("<i", b, p)[0]
def pi(v): return struct.pack("<i", v)
def pu16(v): return struct.pack("<H", v)

def ni(s):
    return names.index(s)

def find_export(name, klass):
    for e in exports:
        if e["objectName"] == name and e["className"] == klass:
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

def replace_texture_mip0(tex_name, payload_path):
    """Замінює mip[0] payload Texture2D. Розмір НЕ може змінитись (BC3/G8
    для тих самих розмірів атласу — однакові)."""
    payload = Path(payload_path).read_bytes()
    tx = find_export(tex_name, "Texture2D")
    body_start = tx["serialOffset"]
    body = bytes(src[body_start:body_start + tx["serialSize"]])
    npos = find_none(body)
    # None(8) + SourceArt(16) + MipCount(4) → mip0 FByteBulkData header
    mip0_hdr = npos + 8 + 16 + 4
    # FByteBulkData header: BulkDataFlags(4) + ElementCount(4) + BulkDataSizeOnDisk(4) + BulkDataOffsetInFile(4)
    old_size = i32(body, mip0_hdr + 4)
    if len(payload) != old_size:
        raise RuntimeError(f"{tex_name}: payload size mismatch {len(payload)} != {old_size}")
    payload_off = body_start + mip0_hdr + 16
    src[payload_off:payload_off + len(payload)] = payload
    print(f"  [TEX] {tex_name}: {len(payload)} B @ 0x{payload_off:x}")

def write_ufont_body(font_name, orig_meta, gen_meta):
    """Перезаписує UFont body. ImportOptions + NetIndex берем з orig.
    Characters + CharRemap беруться з gen_meta (новий UA-набір).
    Textures[] (object refs) — з orig_meta (для shadow ці refs інші, ніж main).
    Pad до orig size — щоб не зачіпати ExportTable."""
    fe = find_export(font_name, "Font")
    body_start = fe["serialOffset"]
    orig_body = bytes(src[body_start:body_start + fe["serialSize"]])

    # ImportOptions block копіюємо verbatim з orig.
    io_s, io_e = find_tag(orig_body, "ImportOptions")
    io_bytes = orig_body[io_s:io_e]

    netindex = orig_body[:4]

    # Characters body (FFontCharacter[21]).
    chars = gen_meta["characters"]
    ch_body = bytearray()
    ch_body.extend(pi(len(chars)))
    for c in chars:
        ch_body.extend(pi(c["startU"]))
        ch_body.extend(pi(c["startV"]))
        ch_body.extend(pi(c["uSize"]))
        ch_body.extend(pi(c["vSize"]))
        ch_body.append(c["texIdx"] & 0xFF)
        ch_body.extend(pi(c["vOff"]))

    # Textures body — ORIG refs цього UFont (main/shadow різні!).
    tex_refs = [t["ref"] for t in orig_meta["textures"]]
    tx_body = bytearray()
    tx_body.extend(pi(len(tex_refs)))
    for r in tex_refs:
        tx_body.extend(pi(r))

    # Збираємо тіло.
    em_scale = gen_meta.get("emScale", orig_meta.get("emScale", 1.0))
    ascent = gen_meta.get("ascent", orig_meta.get("ascent", 0))
    descent = gen_meta.get("descent", orig_meta.get("descent", 0))

    out = bytearray()
    out.extend(netindex)
    out.extend(make_tag("Characters", "ArrayProperty", len(ch_body))); out.extend(ch_body)
    out.extend(make_tag("Textures", "ArrayProperty", len(tx_body))); out.extend(tx_body)
    out.extend(make_tag("IsRemapped", "IntProperty", 4)); out.extend(pi(1))
    out.extend(make_tag("EmScale", "FloatProperty", 4)); out.extend(struct.pack("<f", float(em_scale)))
    out.extend(make_tag("Ascent", "FloatProperty", 4)); out.extend(struct.pack("<f", float(ascent)))
    out.extend(make_tag("Descent", "FloatProperty", 4)); out.extend(struct.pack("<f", float(descent)))
    out.extend(io_bytes)
    out.extend(pi(none_idx)); out.extend(pi(0))

    remap = gen_meta["remap"]
    out.extend(pi(len(remap)))
    for r in remap:
        out.extend(pu16(r["key"])); out.extend(pu16(r["val"]))

    orig_size = fe["serialSize"]
    if len(out) > orig_size:
        raise RuntimeError(f"{font_name}: body too big {len(out)} > {orig_size}")
    pad = orig_size - len(out)
    out.extend(b"\x00" * pad)
    src[body_start:body_start + orig_size] = bytes(out)
    print(f"  [FONT] {font_name}: {len(out) - pad} B + {pad} pad = {orig_size}")

# ── Process each font ──
results = []
for font in CFG["fonts"]:
    name = font["name"]
    ftype = font["type"]
    print(f"[STEP] {name} ({ftype})")
    try:
        orig_meta = json.loads(Path(font["originalMetaJson"]).read_text(encoding="utf-8"))
        gen_meta = json.loads(Path(Path(font["generatedDir"]) / "meta.json").read_text(encoding="utf-8"))
        gen_dir = Path(font["generatedDir"])
        gen_format = gen_meta.get("format", "BC3")
        bin_ext = "bc3.bin" if gen_format == "BC3" else "g8.bin"

        if ftype == "paired":
            # Replace main pages (Texture2D refs from orig_meta).
            main_texs = [t["name"] for t in orig_meta["textures"]]
            for i, tn in enumerate(main_texs):
                fn = gen_dir / f"main_page{i}.{bin_ext}"
                if not fn.exists():
                    raise FileNotFoundError(str(fn))
                replace_texture_mip0(tn, fn)
            # Replace shadow pages.
            orig_shadow = json.loads(Path(font["originalShadowMetaJson"]).read_text(encoding="utf-8"))
            shadow_texs = [t["name"] for t in orig_shadow["textures"]]
            for i, tn in enumerate(shadow_texs):
                fn = gen_dir / f"shadow_page{i}.{bin_ext}"
                if not fn.exists():
                    raise FileNotFoundError(str(fn))
                replace_texture_mip0(tn, fn)
            # Rewrite UFont bodies (main + shadow з ОДНАКОВИМИ Characters/Remap,
            # але РІЗНИМИ Textures refs).
            write_ufont_body(name, orig_meta, gen_meta)
            write_ufont_body(font["shadow"], orig_shadow, gen_meta)
        else:
            # single.
            tex_name = orig_meta["textures"][0]["name"]
            fn = gen_dir / f"atlas.{bin_ext}"
            if not fn.exists():
                raise FileNotFoundError(str(fn))
            replace_texture_mip0(tex_name, fn)
            write_ufont_body(name, orig_meta, gen_meta)
        results.append({"name": name, "ok": True})
        print(f"[DONE] {name}")
    except Exception as e:
        print(f"[ERR] {name}: {e}")
        results.append({"name": name, "ok": False, "error": str(e)})

OUT_UPK.parent.mkdir(parents=True, exist_ok=True)
OUT_UPK.write_bytes(bytes(src))
print(f"[INFO] wrote {OUT_UPK} ({len(src):,} bytes)")
summary = {
    "ok": all(r["ok"] for r in results),
    "outUpk": str(OUT_UPK),
    "size": len(src),
    "results": results,
}
print("RESULT_JSON: " + json.dumps(summary, ensure_ascii=False))
