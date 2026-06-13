"""
Pre-flight перевірка перекладених JSON файлів проти оригіналу.
Шукає типові mojibake patterns коли accented Latin → cyrillic через CP1251.

Usage: validate_translation.py <orig_json_dir> <translated_json_dir>
"""
import json, sys
from pathlib import Path

# CP1251 ↔ Latin-1 mapping для accented Latin → cyrillic:
# Якщо в orig був ç (U+00E7=0xE7), у Win-1251 byte 0xE7 = з (U+0437)
# тощо. Це 1-в-1 при тому ж byte value.
def cp1251_byte_to_cyr(b):
    """Повертає cyrillic char що його дає CP1251 для байта b."""
    try: return bytes([b]).decode('cp1251')
    except: return None

def looks_like_mojibake(orig_str, ua_str):
    """Перевіряє чи UA рядок це CP1251-моджибейк ENG рядка з accents."""
    if len(orig_str) != len(ua_str): return False
    for o, u in zip(orig_str, ua_str):
        if o == u: continue
        if not (0x00C0 <= ord(o) <= 0x00FF): return False  # orig не accent
        # u має бути cp1251_byte_to_cyr(ord(o))
        expected = cp1251_byte_to_cyr(ord(o))
        if expected != u: return False
    return True

if len(sys.argv) < 3:
    print("Usage: validate_translation.py <orig_dir> <ua_dir>")
    sys.exit(1)

orig_dir = Path(sys.argv[1])
ua_dir = Path(sys.argv[2])

total_issues = 0
for ua_file in sorted(ua_dir.glob("*.json")):
    orig_file = orig_dir / ua_file.name
    if not orig_file.exists():
        print(f"SKIP {ua_file.name}: no original")
        continue
    do = json.loads(orig_file.read_text(encoding='utf-8-sig'))
    du = json.loads(ua_file.read_text(encoding='utf-8-sig'))
    file_issues = []
    for ei in range(min(len(do), len(du))):
        eo, eu = do[ei], du[ei]
        for field in ('m_aString', 'm_aWord'):
            ao = eo.get(field, []); au = eu.get(field, [])
            for si in range(min(len(ao), len(au))):
                if ao[si] != au[si]:
                    if looks_like_mojibake(ao[si], au[si]):
                        file_issues.append(
                            f'  [{ei}].{field}[{si}]: MOJIBAKE  orig={ao[si]!r}  ua={au[si]!r}'
                        )
    if file_issues:
        print(f"\n=== {ua_file.name}: {len(file_issues)} mojibake issues ===")
        for s in file_issues[:20]:
            print(s)
        if len(file_issues) > 20:
            print(f"  ... ({len(file_issues)-20} more)")
        total_issues += len(file_issues)

print(f"\nTotal mojibake issues across all files: {total_issues}")
sys.exit(1 if total_issues > 0 else 0)
