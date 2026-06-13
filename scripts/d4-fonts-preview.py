"""
D4 Fonts Preview — для кожного UFont з <metaDir>/<font>.json декодує перший
Texture2D-атлас (BC3 або PF_G8) у PNG. Вихід — у <previewDir>/<font>.png
(alpha-only grayscale, бо це маска шрифту).

Підтримує CLI-аргументи:
  python d4-fonts-preview.py <metaDir> <atlasDir> <previewDir>

Кожна <font>.json містить поле "textures" — масив { name }. Беремо перший,
шукаємо bin+props у <atlasDir>/<font>/<texName>.mip0.bin + .props.json.
"""
import json, sys
from pathlib import Path

if len(sys.argv) < 4:
    print("Usage: d4-fonts-preview.py <metaDir> <atlasDir> <previewDir>")
    sys.exit(1)

META_DIR = Path(sys.argv[1])
ATLAS_DIR = Path(sys.argv[2])
PREVIEW_DIR = Path(sys.argv[3])
PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

try:
    import texture2ddecoder
    from PIL import Image
except ImportError as e:
    print(f"[ERR] missing python lib: {e}")
    sys.exit(2)


def detect_format(props_path: Path) -> str:
    if not props_path.exists():
        return "BC3"
    for p in json.loads(props_path.read_text(encoding="utf-8")):
        if p.get("name") == "Format":
            v = str(p.get("value", ""))
            if "PF_DXT5" in v: return "BC3"
            if "PF_G8"   in v: return "G8"
            if "PF_DXT1" in v: return "BC1"
            return v
    return "BC3"


def parse_size(props_path: Path):
    """Texture size — у .props.json може бути SizeX/SizeY, але часто його
    нема. Тоді пробуємо вивести з payload-size (типові розміри атласів)."""
    sx, sy = None, None
    if props_path.exists():
        for p in json.loads(props_path.read_text(encoding="utf-8")):
            n = p.get("name")
            if n == "SizeX": sx = int(p.get("value") or 0) or None
            if n == "SizeY": sy = int(p.get("value") or 0) or None
    return sx, sy


def guess_size(payload_size: int, fmt: str):
    """Bytes per pixel:
       BC3 = 1.0,  G8 = 1.0,  BC1 = 0.5  (поки що однаково, але є приклад)."""
    if fmt == "BC1":
        target = payload_size * 2
    else:
        target = payload_size
    candidates = [
        (1024, 1024), (1024, 512), (512, 1024),
        (512, 512), (512, 256), (256, 512),
        (508, 512), (512, 508),
        (256, 256), (508, 256), (256, 128),
        (512, 128), (508, 128), (508, 64),
        (128, 128), (64, 64), (256, 64),
    ]
    best = None
    for w, h in candidates:
        if abs(w * h - target) < 1024:
            best = (w, h); break
    return best


results = []
for meta_file in sorted(META_DIR.glob("*.json")):
    name = meta_file.stem
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:
        continue
    textures = meta.get("textures") or []
    if not textures:
        print(f"[SKIP] {name}: no textures")
        continue
    tex0 = textures[0]["name"]
    bin_path = ATLAS_DIR / name / f"{tex0}.mip0.bin"
    props_path = ATLAS_DIR / name / f"{tex0}.props.json"
    if not bin_path.exists():
        print(f"[SKIP] {name}: bin missing {bin_path.name}")
        continue
    data = bin_path.read_bytes()
    fmt = detect_format(props_path)
    sx, sy = parse_size(props_path)
    if not sx or not sy:
        guess = guess_size(len(data), fmt)
        if not guess:
            print(f"[SKIP] {name}: cannot guess size for {tex0} ({len(data)}B {fmt})")
            continue
        sx, sy = guess
    print(f"[STEP] {name}: {tex0} {sx}x{sy} {fmt} ({len(data)}B)")
    try:
        if fmt == "G8":
            img = Image.frombytes("L", (sx, sy), data)
        elif fmt == "BC3":
            rgba = texture2ddecoder.decode_bc3(data, sx, sy)
            img = Image.frombytes("RGBA", (sx, sy), rgba, "raw", "BGRA")
            img = img.split()[3]   # alpha only
        elif fmt == "BC1":
            rgba = texture2ddecoder.decode_bc1(data, sx, sy)
            img = Image.frombytes("RGBA", (sx, sy), rgba, "raw", "BGRA")
            img = img.convert("L")
        else:
            print(f"[ERR] {name}: unsupported fmt {fmt}")
            continue
        out = PREVIEW_DIR / f"{name}.png"
        img.save(out)
        results.append({"name": name, "ok": True, "out": str(out),
                        "w": sx, "h": sy, "format": fmt})
    except Exception as e:
        print(f"[ERR] {name}: decode failed: {e}")
        results.append({"name": name, "ok": False, "error": str(e)})

summary = {"ok": True, "count": len(results), "items": results,
           "previewDir": str(PREVIEW_DIR)}
print("RESULT_JSON: " + json.dumps(summary, ensure_ascii=False))
