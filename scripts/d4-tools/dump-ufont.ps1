# Дампить UFont-експорт повністю: Characters (FFontCharacter array),
# Textures (object refs), CharRemap, ImportOptions metadata.
#
# UFont layout у UE3 v888 cooked:
#   DefaultProperties:
#     Characters   ArrayProperty (body = int32 count + count × FFontCharacter[21])
#     Textures     ArrayProperty (body = int32 count + count × int32 object-ref)
#     IsRemapped   IntProperty (4)
#     EmScale, Ascent, Descent  FloatProperty (4)
#     ImportOptions StructProperty (+8 type-FName, then 452-byte body)
#     (Tag "None" 8 bytes)
#   UFont::Serialize tail:
#     TMap<u16,u16> CharRemap  → int32 count + count × (u16 key, u16 val)
#     (можливо tail-fields)
#
# FFontCharacter (21 байт):
#   int32 StartU
#   int32 StartV
#   int32 USize
#   int32 VSize
#   uint8 TextureIndex
#   int32 VerticalOffset

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$SrcUpk,
    [Parameter(Mandatory=$true)] [string]$ObjectName,
    [Parameter(Mandatory=$true)] [string]$OutJson,
    [Parameter(Mandatory=$true)] [string]$UelibDll
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Diag { param([string]$m) Write-Host "[DIAG] $m" }

$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()

$names = $pkg.Names | ForEach-Object { $_.Name }
$noneIdx = -1
for ($i = 0; $i -lt $names.Count; $i++) {
    if ($names[$i] -eq "None") { $noneIdx = $i; break }
}

$exp = $pkg.Exports | Where-Object {
    $_.ObjectName.ToString() -eq $ObjectName -and $_.ClassName -eq "Font"
} | Select-Object -First 1
if (-not $exp) { throw "Font export '$ObjectName' not found" }

$bytes = [System.IO.File]::ReadAllBytes($SrcUpk)
function I32([int]$p) { return [System.BitConverter]::ToInt32($bytes, $p) }
function U16([int]$p) { return [System.BitConverter]::ToUInt16($bytes, $p) }
function F32([int]$p) { return [System.BitConverter]::ToSingle($bytes, $p) }

$body = [int]$exp.SerialOffset
$serialSize = [int]$exp.SerialSize
$end  = $body + $serialSize
Write-Diag ("Font {0} SerialOffset=0x{1:x} SerialSize=0x{2:x}" -f $ObjectName, $body, $serialSize)

# Збираємо інформацію по props + знаходимо offsets потрібних bodies.
$characters = New-Object System.Collections.ArrayList
$textures = New-Object System.Collections.ArrayList
$importOptions = $null
$isRemapped = $null
$emScale = $null
$ascent = $null
$descent = $null

$p = $body + 4
while ($p -lt $end) {
    if ($p + 24 -gt $end) { break }
    $tagStart = $p
    $nameIdx = I32 $p; $p += 8
    if ($nameIdx -eq $noneIdx) { $p = $tagStart + 8; break }
    $typeIdx = I32 $p; $p += 8
    $size = I32 $p; $p += 4
    $arrIdx = I32 $p; $p += 4
    $tagName = $names[$nameIdx]
    $tagType = $names[$typeIdx]
    Write-Diag ("  walker prop {0,-20} {1,-15} size={2} @ 0x{3:x}" -f $tagName, $tagType, $size, $tagStart)

    if ($tagType -eq "ByteProperty") {
        $p += $size + 8
    } elseif ($tagType -eq "BoolProperty") {
        $p += $size + 1
    } elseif ($tagType -eq "StructProperty") {
        # +8 байт struct type FName перед body.
        $structType = $names[(I32 $p)]
        $bodyOff = $p + 8
        if ($tagName -eq "ImportOptions") {
            # Просто збережемо raw байти body.
            $importOptions = [pscustomobject]@{
                structType = $structType
                size = $size
                bodyOffset = $bodyOff
            }
        }
        $p += 8 + $size
    } elseif ($tagType -eq "ArrayProperty") {
        $bodyOff = $p
        if ($tagName -eq "Characters") {
            $cnt = I32 $bodyOff
            Write-Diag ("Characters count = $cnt")
            $ep = $bodyOff + 4
            for ($i = 0; $i -lt $cnt; $i++) {
                $startU = I32 $ep
                $startV = I32 ($ep + 4)
                $uSize  = I32 ($ep + 8)
                $vSize  = I32 ($ep + 12)
                $texIdx = [int]$bytes[$ep + 16]
                $vOff   = I32 ($ep + 17)
                [void]$characters.Add([pscustomobject]@{
                    i = $i
                    startU = $startU
                    startV = $startV
                    uSize = $uSize
                    vSize = $vSize
                    texIdx = $texIdx
                    vOff = $vOff
                })
                $ep += 21
            }
        } elseif ($tagName -eq "Textures") {
            $cnt = I32 $bodyOff
            Write-Diag ("Textures count = $cnt")
            $ep = $bodyOff + 4
            for ($i = 0; $i -lt $cnt; $i++) {
                $ref = I32 $ep
                $ep += 4
                $refName = "<unknown>"
                if ($ref -gt 0 -and ($ref - 1) -lt $pkg.Exports.Count) {
                    $refName = $pkg.Exports[$ref - 1].ObjectName.ToString()
                }
                [void]$textures.Add([pscustomobject]@{ i = $i; ref = $ref; name = $refName })
            }
        }
        $p += $size
    } elseif ($tagType -eq "IntProperty") {
        $val = I32 $p
        if ($tagName -eq "IsRemapped") { $isRemapped = $val }
        $p += $size
    } elseif ($tagType -eq "FloatProperty") {
        $val = F32 $p
        if ($tagName -eq "EmScale")  { $emScale = $val }
        elseif ($tagName -eq "Ascent")  { $ascent = $val }
        elseif ($tagName -eq "Descent") { $descent = $val }
        $p += $size
    } else {
        $p += $size
    }
}
$tailStart = $p
$walkerOk = ($p -ge $body -and $p -le $end -and $p -lt $bytes.Length)
if (-not $walkerOk) {
    Write-Diag ("Walker ran past body (p=0x{0:x}, end=0x{1:x}) — resyncing on 'None'" -f $p, $end)
    # Byte-by-byte скан: RU патч може мати non-4-aligned None tag.
    # Шукаємо int32 LE = noneIdx, наступний int32 LE = 0 (інстанс), потім
    # int32 LE = sane count (0..count(Characters)).
    $found = $false
    # Pass 1: точний матч CharRemap count == Characters count.
    for ($s = $body + 4; $s -lt $end - 12; $s++) {
        if ((I32 $s) -eq $noneIdx -and (I32 ($s + 4)) -eq 0 -and (I32 ($s + 8)) -eq $characters.Count) {
            $tailStart = $s + 8
            $found = $true
            Write-Diag ("Resync (exact): found 'None' @ 0x{0:x}, tail @ 0x{1:x}, remap count={2}" -f $s, $tailStart, $characters.Count)
            break
        }
    }
    # Pass 2: fallback на heuristic.
    if (-not $found) {
        $maxCnt = if ($characters.Count -gt 0) { $characters.Count } else { 10000 }
        for ($s = $body + 4; $s -lt $end - 12; $s++) {
            if ((I32 $s) -eq $noneIdx -and (I32 ($s + 4)) -eq 0) {
                $cnt = I32 ($s + 8)
                if ($cnt -gt 0 -and $cnt -le $maxCnt) {
                    $k0 = U16 ($s + 12); $v0 = U16 ($s + 14)
                    if ($k0 -le 0x100 -and $v0 -le $maxCnt) {
                        $tailStart = $s + 8
                        $found = $true
                        Write-Diag ("Resync (heur): found 'None' @ 0x{0:x}, tail @ 0x{1:x}, remap count={2}" -f $s, $tailStart, $cnt)
                        break
                    }
                }
            }
        }
    }
    if (-not $found) {
        Write-Diag ("Resync failed")
    }
}
Write-Diag ("UFont body tail (CharRemap) start at 0x{0:x}" -f $tailStart)

# CharRemap: int32 count + count × (u16 key, u16 val).
$remap = New-Object System.Collections.ArrayList
$remapCount = 0
$remapParseOk = $false
try {
    if ($tailStart + 4 -le $end -and $tailStart -ge 0 -and $tailStart -lt $bytes.Length) {
        $remapCount = I32 $tailStart
        if ($remapCount -lt 0 -or $remapCount -gt 100000) {
            Write-Diag ("Remap count suspicious: $remapCount — skipping")
        } else {
            $rp = $tailStart + 4
            for ($i = 0; $i -lt $remapCount; $i++) {
                if ($rp + 4 -gt $end) {
                    Write-Diag ("Remap parse hit body end at i=$i / count=$remapCount")
                    break
                }
                $k = U16 $rp
                $v = U16 ($rp + 2)
                [void]$remap.Add([pscustomobject]@{ key = $k; val = $v })
                $rp += 4
            }
            $remapParseOk = $true
            Write-Diag ("CharRemap parsed $($remap.Count) of $remapCount entries; final p=0x{0:x} (body end=0x{1:x})" -f $rp, $end)
        }
    } else {
        Write-Diag ("Tail offset out of range — skipping CharRemap")
    }
} catch {
    Write-Diag ("CharRemap parse failed: $($_.Exception.Message)")
}

# Зберігаємо.
$result = [pscustomobject]@{
    ok = $true
    name = $ObjectName
    isRemapped = $isRemapped
    emScale = $emScale
    ascent = $ascent
    descent = $descent
    charactersCount = $characters.Count
    texturesCount = $textures.Count
    remapCount = $remap.Count
    importOptions = $importOptions
    textures = $textures.ToArray()
    characters = $characters.ToArray()
    remap = $remap.ToArray()
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
$json = ConvertTo-Json -InputObject $result -Depth 6
[System.IO.File]::WriteAllText($OutJson, $json, $utf8)
Write-Host ("RESULT_JSON: " + (ConvertTo-Json @{ok=$true;file=$OutJson;chars=$characters.Count;remap=$remap.Count;tex=$textures.Count} -Compress))
