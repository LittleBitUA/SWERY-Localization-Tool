"""
Для кожного UFont у all_fonts/ дампить ПЕРШИЙ atlas як alpha PNG.
Виходи в d4_font_preview/.
"""
import json, subprocess, glob, os
from pathlib import Path

ALL_FONTS = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/all_fonts")
SRC_UPK = r"C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk"
UELIB = r"C:/Users/bidlov/AppData/Local/Temp/uelib/extracted/lib/net8.0/Eliot.UELib.dll"
DUMP_SCRIPT = r"e:/Localization/DP2/Tool/scripts/d4-tools/dump-texture2d.ps1"
OUT_DIR = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/d4_font_preview")
OUT_DIR.mkdir(parents=True, exist_ok=True)
TMP_DUMP = Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/_tmp_dump")
TMP_DUMP.mkdir(parents=True, exist_ok=True)

# Завантажуємо exports для пошуку розмірів Texture2D.
EXPORTS = json.loads(Path(r"C:/Users/bidlov/AppData/Local/Temp/d4_font_test/exports.json").read_text(encoding="utf-8"))

import texture2ddecoder
from PIL import Image
import struct, json

def detect_format(props_path):
    """Повертає PF_DXT5 (BC3), PF_G8 (grayscale), або None."""
    if not props_path.exists(): return None
    for p in json.loads(props_path.read_text(encoding='utf-8')):
        if p.get('name') == 'Format':
            v = p.get('value', '')
            if 'PF_DXT5' in v: return 'BC3'
            if 'PF_G8' in v: return 'G8'
            if 'PF_DXT1' in v: return 'BC1'
            return v
    return None

def get_texture_size(name):
    """Знаходимо SizeX, SizeY з body Texture2D — швидко без full dump."""
    for e in EXPORTS["exports"]:
        if e["objectName"] == name and e["className"] == "Texture2D":
            # Розмір BC3 → SizeX×SizeY/2 (BC3 = 1 byte/pixel)
            # Простіше: SerialSize - оверхед_типу_500 = payload size.
            # Здогадуємось з типових розмірів.
            sz = e["serialSize"]
            return sz
    return None

# Часті розміри:
# 508×512 = 260096 bytes BC3 (+~400 header) → serial ~260500
# 512×512 = 262144 (+~400) → serial ~262500
# 512×256 = 131072 (+~400) → serial ~131500
# 512×128 = 65536 → ~65900
# 508×64 = 32512 → ~32900

def guess_dims(serial_size):
    # rough guess based on payload size = serial_size - ~400 header
    payload = serial_size - 400
    candidates = [
        (508, 512, 260096), (512, 512, 262144), (256, 256, 65536),
        (512, 256, 131072), (508, 256, 130048), (512, 128, 65536),
        (508, 64, 32512), (508, 128, 65024), (256, 128, 32768),
        (512, 1024, 524288), (1024, 512, 524288), (1024, 1024, 1048576),
        (128, 128, 16384), (256, 512, 131072),
    ]
    best = None
    for w, h, ps in candidates:
        if abs(ps - payload) < 500:
            best = (w, h); break
    return best

for jf in sorted(ALL_FONTS.glob("*.json")):
    name = jf.stem
    try:
        d = json.loads(jf.read_text(encoding="utf-8"))
    except: continue
    txs = d.get("textures") or []
    if not txs: continue
    tex0 = txs[0]["name"]
    # Dump Texture2D.
    res = subprocess.run([
        "C:/PowerShell-7/pwsh.exe", "-NoProfile", "-File", DUMP_SCRIPT,
        "-SrcUpk", SRC_UPK, "-ObjectName", tex0, "-OutDir", str(TMP_DUMP),
        "-UelibDll", UELIB,
    ], capture_output=True, text=True)
    # Зчитати SizeX/Y з output.
    sizes_match = [l for l in res.stdout.splitlines() if "SizeX=" in l]
    W, H = None, None
    for line in sizes_match:
        import re
        m = re.search(r"SizeX=(\d+) SizeY=(\d+)", line)
        if m:
            W, H = int(m.group(1)), int(m.group(2))
            break
    if not W:
        print(f"  {name}: skipped, no size detected")
        continue
    bin_path = TMP_DUMP / f"{tex0}.mip0.bin"
    if not bin_path.exists():
        print(f"  {name}: bin not found"); continue
    data = bin_path.read_bytes()
    props_path = TMP_DUMP / f"{tex0}.props.json"
    fmt = detect_format(props_path) or 'BC3'
    try:
        if fmt == 'G8':
            img = Image.frombytes("L", (W, H), data)
            img.save(OUT_DIR / f"{name}__{tex0}__{W}x{H}.png")
            print(f"  {name}: {tex0} {W}x{H} G8 -> PNG")
        elif fmt == 'BC3':
            rgba = texture2ddecoder.decode_bc3(data, W, H)
            img = Image.frombytes("RGBA", (W, H), rgba, "raw", "BGRA")
            alpha = img.split()[3]
            alpha.save(OUT_DIR / f"{name}__{tex0}__{W}x{H}.png")
            print(f"  {name}: {tex0} {W}x{H} BC3 -> PNG")
        else:
            print(f"  {name}: {tex0} unsupported format {fmt}")
    except Exception as e:
        print(f"  {name}: decode failed: {e}")

print(f"\nDone. PNGs in {OUT_DIR}")
