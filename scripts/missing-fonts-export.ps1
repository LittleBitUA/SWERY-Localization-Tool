# THE MISSING — Fonts Export (v3: швидкий raw-byte scan без TypeTree).
#
# Оптимізації проти v2:
#   - НЕ викликаємо LoadClassPackage / LoadClassDatabaseFromPackage / GetBaseField
#     для кожного asset'а (TypeTree-парсинг — найповільніша частина).
#   - LoadAssetsFile($path, $false) — без завантаження dependencies.
#   - Пре-фільтр assets-файлів: спочатку проходимо метадату й пропускаємо ті,
#     що не містять TypeId=128 (Font). У grobalgamemanagers.assets та більшості
#     sharedassets їх немає взагалі.
#   - m_Name парсимо РУЧНО з перших байт asset'а (uint32 LE length + ASCII).
#
# Magic-scan ловить TTF (00 01 00 00), OTF (OTTO), TTC (ttcf), WOFF/WOFF2,
# Apple-true. 4 байти ПЕРЕД magic'ом = uint32 LE довжина font-blob.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw "assets not found: $AssetsPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$metaDir = Split-Path -Parent $MetaPath
if ($metaDir -and -not (Test-Path $metaDir)) { New-Item -ItemType Directory -Path $metaDir -Force | Out-Null }

$loadList = @("Mono.Cecil.dll","LibCpp2IL.dll","Newtonsoft.Json.dll","AssetsTools.NET.dll","AssetsTools.NET.MonoCecil.dll","AssetsTools.NET.Cpp2IL.dll","UABEANext4.dll")
foreach ($n in $loadList) { $p=Join-Path $UabeaDir $n; if (Test-Path $p) { try { $null=[System.Reflection.Assembly]::LoadFrom($p) } catch {} } }

$mgr = New-Object AssetsTools.NET.Extra.AssetsManager

$dataDir = Split-Path -Parent $AssetsPath
$allFiles = New-Object System.Collections.ArrayList
[void]$allFiles.Add($AssetsPath)
Get-ChildItem -LiteralPath $dataDir -Filter "sharedassets*.assets" -File | ForEach-Object {
    if ($_.FullName -ne $AssetsPath -and $_.Name -notmatch '\.resS$') {
        [void]$allFiles.Add($_.FullName)
    }
}
Write-Diag ("Scan {0} assets-files" -f $allFiles.Count)

$MAGICS = @{ "00010000"="ttf"; "4F54544F"="otf"; "74746366"="ttc"; "774F4646"="woff"; "774F4632"="woff2"; "74727565"="ttf" }

function Find-FontInBytes {
    param([byte[]]$bytes, [int]$startAt = 4)
    if ($bytes.Length -lt 16) { return $null }
    for ($i = $startAt; $i -le $bytes.Length - 12; $i++) {
        $magic = ("{0:X2}{1:X2}{2:X2}{3:X2}" -f $bytes[$i], $bytes[$i+1], $bytes[$i+2], $bytes[$i+3])
        if (-not $MAGICS.ContainsKey($magic)) { continue }
        $lenLE = [BitConverter]::ToUInt32($bytes, $i - 4)
        if ($lenLE -lt 1024 -or $lenLE -gt ($bytes.Length - $i)) { continue }
        return [pscustomobject]@{ start = $i; length = $lenLE; ext = $MAGICS[$magic] }
    }
    return $null
}

function Get-AssetRawBytes {
    param($inst, $info)
    $reader = $inst.file.Reader
    $oldPos = $reader.Position
    try {
        $offset = $null
        try { $offset = $info.GetAbsoluteByteOffset($inst.file) } catch {}
        if ($null -eq $offset) { try { $offset = $info.AbsoluteByteOffset } catch {} }
        if ($null -eq $offset) { try { $offset = $inst.file.Header.DataOffset + $info.ByteOffset } catch {} }
        if ($null -eq $offset) { return $null }
        $reader.Position = $offset
        return $reader.ReadBytes([int]$info.ByteSize)
    } catch { return $null }
    finally { $reader.Position = $oldPos }
}

function Parse-NameFromRawBytes {
    param([byte[]]$bytes)
    if ($bytes.Length -lt 8) { return @{ name = ""; afterName = 0 } }
    $nameLen = [BitConverter]::ToInt32($bytes, 0)
    if ($nameLen -lt 0 -or $nameLen -gt 256) { return @{ name = ""; afterName = 0 } }
    $name = [System.Text.Encoding]::UTF8.GetString($bytes, 4, $nameLen)
    # 4-байт alignment.
    $afterName = (4 + $nameLen + 3) -band -bnot 3
    return @{ name = $name; afterName = $afterName }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$totalExported = 0
$totalChecked = 0
$metaList = New-Object System.Collections.ArrayList

foreach ($af in $allFiles) {
    $afBaseName = [System.IO.Path]::GetFileName($af)
    $inst = $null
    try {
        # $false → не вантажимо dependencies (вони не потрібні для raw-bytes).
        $inst = $mgr.LoadAssetsFile($af, $false)
    } catch {
        Write-Diag ("AF load fail {0}: {1}" -f $afBaseName, $_.Exception.Message)
        continue
    }
    if ($null -eq $inst) { continue }

    # Швидкий пре-фільтр: чи містить файл хоч один Font (TypeId=128).
    $fontInfos = @($inst.file.AssetInfos | Where-Object { $_.TypeId -eq 128 })
    if ($fontInfos.Count -eq 0) {
        try { $mgr.UnloadAssetsFile($af) } catch {}
        continue
    }
    Write-Diag ("{0}: {1} Font assets" -f $afBaseName, $fontInfos.Count)

    foreach ($ai in $fontInfos) {
        $totalChecked++
        $rawBytes = Get-AssetRawBytes -inst $inst -info $ai
        if ($null -eq $rawBytes -or $rawBytes.Length -lt 32) { continue }
        $parsed = Parse-NameFromRawBytes -bytes $rawBytes
        $name = $parsed.name
        $found = Find-FontInBytes -bytes $rawBytes -startAt $parsed.afterName
        if ($null -eq $found) { continue }
        $fontBytes = New-Object byte[] $found.length
        [Array]::Copy($rawBytes, $found.start, $fontBytes, 0, $found.length)
        $safeName = if ($name) { $name -replace '[\\/:*?"<>|]','_' } else { "font" }
        $outFile = Join-Path $OutDir ("{0}-{1}.{2}" -f $safeName, $ai.PathId, $found.ext)
        [System.IO.File]::WriteAllBytes($outFile, $fontBytes)
        $totalExported++
        [void]$metaList.Add([pscustomobject]@{
            name = $name; file = [System.IO.Path]::GetFileName($outFile); pathId = $ai.PathId
            typeId = 128; assets = $afBaseName; fontSize = $found.length; ext = $found.ext
        })
        Write-Host ("[EXPORTED] {0} ({1}, {2:N0} bytes)" -f $name, $found.ext, $found.length)
    }
    try { $mgr.UnloadAssetsFile($af) } catch {}
}
try { $mgr.UnloadAll() } catch {}
$sw.Stop()

$meta = [pscustomobject]@{
    assets       = [System.IO.Path]::GetFileName($AssetsPath)
    exportedAt   = (Get-Date).ToString("o")
    items        = $metaList.ToArray()
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MetaPath, ($meta | ConvertTo-Json -Depth 5), $utf8)

Write-Step ("DONE: exported {0} of {1} Font-assets in {2:N1}s" -f $totalExported, $totalChecked, $sw.Elapsed.TotalSeconds)
Write-Host ("RESULT_JSON: {0}" -f (([pscustomobject]@{ ok=$true; total=$totalExported; checked=$totalChecked; seconds=[math]::Round($sw.Elapsed.TotalSeconds,2); outDir=$OutDir; metaPath=$MetaPath }) | ConvertTo-Json -Compress))
exit 0
