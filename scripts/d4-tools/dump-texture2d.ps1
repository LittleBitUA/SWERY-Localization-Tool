# Витягає mip[0] payload конкретного Texture2D-експорту з uncompressed UE3 .upk.
#
# Layout UTexture2D у UE3 v888 cooked (підтверджено для D4 talkfont):
#   ── DefaultProperties (UPropertyTag stream) ──
#   ... до Tag з name="None" (8 байт: idx+inst).
#   ── UTexture2D::Serialize body ──
#   FByteBulkData SourceArt — 16 байт (int32 offset), у cooked Count=0.
#   int32 MipCount.
#   for each mip:
#     FByteBulkData header — 16 байт.
#       int32 BulkDataFlags
#       int32 ElementCount     (= payload byte count для PF_DXT5)
#       int32 BulkDataSizeOnDisk
#       int32 BulkDataOffsetInFile (file offset де лежить payload)
#     payload (ElementCount bytes, BC3 для PF_DXT5).
#     int32 SizeX
#     int32 SizeY
#   ...
#
# Скрипт використовує UELib для парсингу DefaultProperties, далі вручну
# зчитує SourceArt + Mip-array із raw байтів.
#
# Дамп:
#   <OutDir>/<Name>.props.json — імена/значення DefaultProperties.
#   <OutDir>/<Name>.mipN.bin   — payload кожного mip.
#
# Параметри:
#   -SrcUpk      повний шлях до uncompressed .upk
#   -ObjectName  ObjectName експорту, наприклад "Texture2D_82"
#   -OutDir      каталог для дампу
#   -UelibDll    шлях до Eliot.UELib.dll

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$SrcUpk,
    [Parameter(Mandatory=$true)] [string]$ObjectName,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UelibDll
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$m) Write-Host "[STEP] $m" }
function Write-Diag { param([string]$m) Write-Host "[DIAG] $m" }

if (-not (Test-Path $SrcUpk))   { throw ".upk not found: $SrcUpk" }
if (-not (Test-Path $UelibDll)) { throw "UELib.dll not found: $UelibDll" }
if (-not (Test-Path $OutDir))   { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)

Write-Step "Loading $SrcUpk ..."
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()
if ($pkg.Summary.CompressionFlags -ne 0) {
    throw "Package is compressed. Run decompress.exe first."
}

# Знаходимо ім'я "None" у name-таблиці.
$names = $pkg.Names | ForEach-Object { $_.Name }
$noneIdx = -1
for ($i = 0; $i -lt $names.Count; $i++) {
    if ($names[$i] -eq "None") { $noneIdx = $i; break }
}
if ($noneIdx -lt 0) { throw "No 'None' name in name table" }

$exp = $pkg.Exports | Where-Object {
    $_.ObjectName.ToString() -eq $ObjectName -and $_.ClassName -eq "Texture2D"
} | Select-Object -First 1
if (-not $exp) { throw "Texture2D export '$ObjectName' not found" }

$body = [int]$exp.SerialOffset
$serialSize = [int]$exp.SerialSize
$end  = $body + $serialSize
Write-Diag ("Export {0} SerialOffset=0x{1:x} SerialSize=0x{2:x}" -f $ObjectName, $body, $serialSize)

# Витягуємо DefaultProperties через UELib (для діагностики/логування).
$obj = $pkg.GetIndexObject($exp.Index + 1)
$props = New-Object System.Collections.ArrayList
try {
    $obj.BeginDeserializing()
} catch {
    # UELib падає на mip-array (несумісність версії), але DefaultProperties
    # вже розпарсені.
}
try {
    foreach ($d in $obj.Properties) {
        [void]$props.Add([pscustomobject]@{
            name  = $d.Name.ToString()
            type  = $d.Type.ToString()
            value = $d.Value
        })
    }
} catch {
    Write-Diag ("Properties enumeration failed: {0}" -f $_.Exception.Message)
}

$propsJson = Join-Path $OutDir ("$ObjectName.props.json")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$json = $props.ToArray() | ConvertTo-Json -Depth 4
if ($null -eq $json) { $json = "[]" }
elseif ($json -notmatch '^\s*\[') { $json = "[" + $json + "]" }
[System.IO.File]::WriteAllText($propsJson, $json, $utf8NoBom)
Write-Step ("Wrote $propsJson")

# Знаходимо позицію 'None' tag — пошук на raw байтах серіалізованого тіла.
$bytes = [System.IO.File]::ReadAllBytes($SrcUpk)
function ReadInt32([int]$p)  { return [System.BitConverter]::ToInt32($bytes, $p) }

# Скан тегів: проходимо UPropertyTag stream до None.
# Підтримуємо лише ті типи tag.size, які зустрічаються у Texture2D
# (IntProperty, FloatProperty, BoolProperty, ByteProperty з enum,
# NameProperty, StrProperty, ObjectProperty, ArrayProperty). Для невідомих —
# trust tag.size.
$p = $body + 4   # skip NetIndex.
while ($p -lt $end) {
    if ($p + 24 -gt $end) { break }
    $tagStart = $p
    $nameIdx = ReadInt32 $p
    $p += 8                   # name idx + inst.
    if ($nameIdx -eq $noneIdx) { $p = $tagStart + 8; break }
    $typeIdx = ReadInt32 $p
    $p += 8                   # type idx + inst.
    $size = ReadInt32 $p; $p += 4
    $arrIdx = ReadInt32 $p; $p += 4
    $tagType = $names[$typeIdx]
    if ($tagType -eq "ByteProperty") {
        # UE3 v888: body(size) = enum FName pair (8 bytes), then
        # ByteValue as FName pair (8 bytes) after.
        $p += $size + 8
    } elseif ($tagType -eq "BoolProperty") {
        # body=0, 1 byte value after.
        $p += $size + 1
    } else {
        $p += $size
    }
}
$utStart = $p
Write-Diag ("UTexture2D body start at 0x{0:x}" -f $utStart)

# SourceArt FByteBulkData (16 байт, int32 offset).
$srcFlags  = ReadInt32 $utStart
$srcCount  = ReadInt32 ($utStart + 4)
$srcDisk   = ReadInt32 ($utStart + 8)
$srcOff    = ReadInt32 ($utStart + 12)
Write-Diag ("SourceArt: Flags=0x{0:x} Count={1} Disk={2} Off=0x{3:x}" -f $srcFlags, $srcCount, $srcDisk, $srcOff)
$mipsStart = $utStart + 16 + $srcCount

# Mip count.
$mipCount = ReadInt32 $mipsStart
Write-Diag ("MipCount = $mipCount")
$cur = $mipsStart + 4

$mipsInfo = New-Object System.Collections.ArrayList
for ($mi = 0; $mi -lt $mipCount; $mi++) {
    $flags = ReadInt32 $cur
    $count = ReadInt32 ($cur + 4)
    $disk  = ReadInt32 ($cur + 8)
    $foff  = ReadInt32 ($cur + 12)
    # ВАЖЛИВО: гра, схоже, ігнорує BulkDataOffsetInFile і читає payload
    # одразу після header (підтверджено RU патчем, де offset не оновлений
    # після зсуву export-а, а гра все одно працює). Тому використовуємо
    # завжди header_end як payload offset.
    $payload = $cur + 16
    if ($foff -ne $payload) {
        $foffHex = $foff.ToString('x')
        $payHex = $payload.ToString('x')
        Write-Diag ("  Mip ${mi}: BulkOffset(0x$foffHex) != header_end(0x$payHex) — using header_end (game ignores BulkDataOffsetInFile)")
    }
    $outBin = Join-Path $OutDir ("$ObjectName.mip$mi.bin")
    [System.IO.File]::WriteAllBytes($outBin, $bytes[$payload..($payload + $count - 1)])
    $sizeX = ReadInt32 ($payload + $count)
    $sizeY = ReadInt32 ($payload + $count + 4)
    Write-Diag ("  Mip $mi @ 0x{0:x}: Count={1} SizeX={2} SizeY={3} -> $outBin" -f $cur, $count, $sizeX, $sizeY)
    [void]$mipsInfo.Add([pscustomobject]@{
        index = $mi
        flags = $flags
        size = $count
        sizeX = $sizeX
        sizeY = $sizeY
        payloadOffset = $payload
        binPath = $outBin
    })
    $cur = $payload + $count + 8
}

$summary = [pscustomobject]@{
    ok = $true
    name = $ObjectName
    mipCount = $mipCount
    mips = $mipsInfo
    propsFile = $propsJson
}
Write-Host ("RESULT_JSON: " + (ConvertTo-Json -InputObject $summary -Compress -Depth 5))
exit 0
