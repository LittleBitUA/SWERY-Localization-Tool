# Дампить усі 13 talkfont-атласів і конвертує їх в alpha-only PNG.
# Корисно для огляду, що міститься у кожному атласі (latin vs CJK).

[CmdletBinding()]
param(
    [string]$Upk    = "C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk",
    [string]$Out   = "C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_dump",
    [string]$Uelib = "C:/Users/bidlov/AppData/Local/Temp/uelib/extracted/lib/net8.0/Eliot.UELib.dll",
    [int[]] $Ids   = @(82,83,84,85,86,87,88,89,90,91,92,93,94)
)

$dumpScript = Join-Path $PSScriptRoot "dump-texture2d.ps1"
foreach ($id in $Ids) {
    $name = "Texture2D_$id"
    Write-Host "===== $name ====="
    & "C:/PowerShell-7/pwsh.exe" -NoProfile -File $dumpScript `
        -SrcUpk $Upk -ObjectName $name -OutDir $Out -UelibDll $Uelib 2>&1 |
        Where-Object { $_ -match "Mip 0|UTexture2D body|MipCount|RESULT_JSON" }
}

# Конвертуємо bin → PNG через Python.
$py = @"
import os, glob
import texture2ddecoder
from PIL import Image
out = r'C:/Users/bidlov/AppData/Local/Temp/d4_font_test/talkfont_dump'
for bin in sorted(glob.glob(out + '/Texture2D_*.mip0.bin')):
    name = os.path.basename(bin).replace('.mip0.bin','')
    data = open(bin,'rb').read()
    W, H = 508, 512
    rgba = texture2ddecoder.decode_bc3(data, W, H)
    img = Image.frombytes('RGBA', (W, H), rgba, 'raw', 'BGRA')
    _r, _g, _b, a = img.split()
    a.save(out + f'/{name}_alpha.png')
    print(f'wrote {name}_alpha.png')
"@
$py | & python3
Write-Host "Done."
