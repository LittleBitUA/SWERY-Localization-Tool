# THE MISSING — Fonts Import (v2: raw-byte splice).
# Алгоритм:
#   1. Для кожного запису з meta дістаємо сирі байти asset'а через Reader.
#   2. Magic-scan локалізує блок m_FontData ([uint32 length][magic+payload]).
#   3. Перебудовуємо asset bytes: header_before + new_length + new_font_bytes + align(4) + tail_after.
#   4. info.SetNewData(rebuilt).
# Решта asset-полів (m_FontNames, m_FallbackFonts тощо) лишаються без змін —
# просто рухаємось далі по байтах. Лоадер Unity терпить, поки структура vector
# валідна.
#
# Параметри: -AssetsRoot, -ReplaceDir, -MetaPath, -UabeaDir.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsRoot,
    [Parameter(Mandatory=$true)] [string]$ReplaceDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsRoot)) { throw "assets-root not found: $AssetsRoot" }
if (-not (Test-Path $ReplaceDir)) { throw "replace dir not found: $ReplaceDir" }
if (-not (Test-Path $MetaPath))   { throw "meta not found: $MetaPath" }

$loadList = @("Mono.Cecil.dll","LibCpp2IL.dll","Newtonsoft.Json.dll","AssetsTools.NET.dll","AssetsTools.NET.MonoCecil.dll","AssetsTools.NET.Cpp2IL.dll","UABEANext4.dll")
foreach ($n in $loadList) { $p=Join-Path $UabeaDir $n; if (Test-Path $p) { try { $null=[System.Reflection.Assembly]::LoadFrom($p) } catch {} } }

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$mgr = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $mgr.LoadClassPackage($tpkPath)

$metaText = [System.IO.File]::ReadAllText($MetaPath, [System.Text.Encoding]::UTF8)
$metaTextSafe = [regex]::Replace($metaText, '"pathId"\s*:\s*(-?\d+)', '"pathId":"$1"')
$meta = $metaTextSafe | ConvertFrom-Json
Write-Diag ("Meta items: {0}" -f $meta.items.Count)

# Групуємо meta-items за assets-файлом.
$byAssets = @{}
foreach ($it in $meta.items) {
    $key = $it.assets
    if (-not $byAssets.ContainsKey($key)) { $byAssets[$key] = New-Object System.Collections.ArrayList }
    [void]$byAssets[$key].Add($it)
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

# Знаходимо позицію m_FontData у raw-байтах за magic-патернами.
function Find-FontDataBlock {
    param([byte[]]$bytes)
    $magics = @("00010000","4F54544F","74746366","774F4646","774F4632","74727565")
    for ($i = 4; $i -le $bytes.Length - 12; $i++) {
        $m = ("{0:X2}{1:X2}{2:X2}{3:X2}" -f $bytes[$i],$bytes[$i+1],$bytes[$i+2],$bytes[$i+3])
        if ($magics -notcontains $m) { continue }
        $lenLE = [BitConverter]::ToUInt32($bytes, $i - 4)
        if ($lenLE -lt 1024 -or $lenLE -gt ($bytes.Length - $i)) { continue }
        return [pscustomobject]@{ lengthOff = $i - 4; payloadOff = $i; oldLength = $lenLE }
    }
    return $null
}

$appliedTotal = 0
$failed = New-Object System.Collections.ArrayList
$dirtyAssets = New-Object System.Collections.ArrayList

foreach ($key in $byAssets.Keys) {
    $assetsPath = Join-Path $AssetsRoot $key
    if (-not (Test-Path $assetsPath)) {
        foreach ($it in $byAssets[$key]) { [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="assets file not found: $key" }) }
        continue
    }
    Write-Step ("Patching {0}" -f $key)
    $inst = $mgr.LoadAssetsFile($assetsPath, $true)
    if ($null -eq $inst) {
        foreach ($it in $byAssets[$key]) { [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="LoadAssetsFile returned null" }) }
        continue
    }
    $null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
    $localApplied = 0
    foreach ($it in $byAssets[$key]) {
        $assetPid = [int64]::Parse([string]$it.pathId)
        $replaceFile = Join-Path $ReplaceDir $it.file
        if (-not (Test-Path $replaceFile)) {
            [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="replacement missing: $($it.file)" }); continue
        }
        $info = $null
        foreach ($ai in $inst.file.AssetInfos) {
            if ([int64]$ai.PathId -eq $assetPid) { $info = $ai; break }
        }
        if ($null -eq $info) {
            [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="PathID $assetPid not found in $key" }); continue
        }
        try {
            $rawBytes = Get-AssetRawBytes -inst $inst -info $info
            if ($null -eq $rawBytes) {
                [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="cannot read raw bytes" }); continue
            }
            $block = Find-FontDataBlock -bytes $rawBytes
            if ($null -eq $block) {
                [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="m_FontData magic not found" }); continue
            }
            $newFontBytes = [System.IO.File]::ReadAllBytes($replaceFile)
            if ($newFontBytes.Length -lt 16) {
                [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="replacement too small (<16 bytes)" }); continue
            }
            # Перевіряємо що це справді шрифт (magic OTTO / 00 01 00 00 / тощо).
            $rmagic = ("{0:X2}{1:X2}{2:X2}{3:X2}" -f $newFontBytes[0],$newFontBytes[1],$newFontBytes[2],$newFontBytes[3])
            $validMagics = @("00010000","4F54544F","74746366","774F4646","774F4632","74727565")
            if ($validMagics -notcontains $rmagic) {
                [void]$failed.Add([pscustomobject]@{ name=$it.name; reason="replacement is not TTF/OTF (magic=$rmagic)" }); continue
            }

            # Будуємо новий asset blob: до length-offset + новий length(4) + новий font + align(4) + tail після old payload.
            $oldEnd = $block.payloadOff + $block.oldLength
            $oldAligned = ($oldEnd + 3) -band -bnot 3
            $tailStart = $oldAligned
            $tailLen = $rawBytes.Length - $tailStart
            $newLen = $newFontBytes.Length
            $newAligned = ($newLen + 3) -band -bnot 3
            $padBytes = $newAligned - $newLen

            $newSize = $block.lengthOff + 4 + $newAligned + $tailLen
            $newAsset = New-Object byte[] $newSize
            [Array]::Copy($rawBytes, 0, $newAsset, 0, $block.lengthOff)
            $lenBytes = [BitConverter]::GetBytes([uint32]$newLen)
            [Array]::Copy($lenBytes, 0, $newAsset, $block.lengthOff, 4)
            [Array]::Copy($newFontBytes, 0, $newAsset, $block.lengthOff + 4, $newLen)
            # Padding-байти уже 0 (за замовч.).
            [Array]::Copy($rawBytes, $tailStart, $newAsset, $block.lengthOff + 4 + $newAligned, $tailLen)

            $info.SetNewData($newAsset)
            $localApplied++
            $appliedTotal++
            Write-Host ("[REPLACED] {0} (PathID {1}, {2:N0}→{3:N0} bytes)" -f $it.name, $assetPid, $block.oldLength, $newLen)
        } catch {
            [void]$failed.Add([pscustomobject]@{ name=$it.name; reason=$_.Exception.Message })
        }
    }

    if ($localApplied -gt 0) {
        $bak = $assetsPath + ".fonts.bak"
        if (-not (Test-Path $bak)) {
            Copy-Item -LiteralPath $assetsPath -Destination $bak -Force
            Write-Diag ("backup → {0}" -f $bak)
        }
        $tmp = $assetsPath + ".tmp"
        $writer = $null
        try {
            $writer = New-Object AssetsTools.NET.AssetsFileWriter($tmp)
            $inst.file.Write($writer)
        } finally {
            if ($null -ne $writer) { $writer.Close() }
        }
        try { $inst.file.Reader.Close() } catch {}
        try { $mgr.UnloadAssetsFile($assetsPath) } catch {}
        $inst = $null
        [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
        $ok = $false
        for ($i=0; $i -lt 10; $i++) {
            try {
                if (Test-Path $assetsPath) { Remove-Item -LiteralPath $assetsPath -Force -ErrorAction Stop }
                Move-Item -LiteralPath $tmp -Destination $assetsPath -Force -ErrorAction Stop
                $ok = $true; break
            } catch { Start-Sleep -Milliseconds 500 }
        }
        if (-not $ok) {
            try { Copy-Item -LiteralPath $tmp -Destination $assetsPath -Force; Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; $ok = $true } catch {}
        }
        if (-not $ok) { throw "Cannot swap $assetsPath — закрий Steam/гру і повтори." }
        [void]$dirtyAssets.Add($key)
    } else {
        try { $mgr.UnloadAssetsFile($assetsPath) } catch {}
    }
}
try { $mgr.UnloadAll() } catch {}

Write-Step ("DONE: applied {0}, failed {1}" -f $appliedTotal, $failed.Count)
$summary = [pscustomobject]@{ ok=$true; applied=$appliedTotal; failed=$failed.ToArray(); changedAssets=$dirtyAssets.ToArray() }
Write-Host ("RESULT_JSON: {0}" -f ($summary | ConvertTo-Json -Compress))
exit 0
