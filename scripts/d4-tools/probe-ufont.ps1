# Знайде позицію UFont body (після DefaultProperties), дамп raw байтів.
# Просто допоможе очима побачити layout FFontCharacter.

[CmdletBinding()]
param(
    [string]$SrcUpk = "C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk",
    [string]$ObjectName = "talkfont",
    [string]$UelibDll = "C:/Users/bidlov/AppData/Local/Temp/uelib/extracted/lib/net8.0/Eliot.UELib.dll"
)

$ErrorActionPreference = "Stop"
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

$body = [int]$exp.SerialOffset
$end  = $body + [int]$exp.SerialSize
Write-Host ("Font export SerialOffset=0x{0:x} SerialSize=0x{1:x}" -f $body, $exp.SerialSize)

# Walker з ByteProperty/BoolProperty специфікою UE3 v888.
$p = $body + 4
while ($p -lt $end) {
    if ($p + 24 -gt $end) { break }
    $tagStart = $p
    $nameIdx = I32 $p
    $p += 8
    if ($nameIdx -eq $noneIdx) { $p = $tagStart + 8; break }
    $typeIdx = I32 $p; $p += 8
    $size = I32 $p; $p += 4
    $p += 4   # arrIdx
    $tagType = $names[$typeIdx]
    Write-Host ("  prop {0,-20} {1,-15} size={2}" -f $names[$nameIdx], $tagType, $size)
    if ($tagType -eq "ByteProperty")    { $p += $size + 8 }
    elseif ($tagType -eq "BoolProperty"){ $p += $size + 1 }
    else                                 { $p += $size }
}
$ufStart = $p
Write-Host ("UFont body start at 0x{0:x}" -f $ufStart)

# Hex dump перших 256 байт.
Write-Host "First 256 bytes of UFont body:"
for ($off = $ufStart; $off -lt $ufStart + 256; $off += 16) {
    $row = $bytes[$off..($off+15)]
    $h = ($row | ForEach-Object { "{0:x2}" -f $_ }) -join " "
    Write-Host ("  0x{0:x8}: {1}" -f $off, $h)
}

# int32 view перших 64 байт.
Write-Host ""
Write-Host "First 16 int32 values:"
for ($off = $ufStart; $off -lt $ufStart + 64; $off += 4) {
    $v = I32 $off
    Write-Host ("  0x{0:x8}: {1,10} = 0x{2:x8}" -f $off, $v, $v)
}
