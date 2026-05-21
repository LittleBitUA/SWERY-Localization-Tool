# Hotel Barcelona — Textures Replace.
#
# Бере PNG(и) і запаковує їх у `.bundle` за PathID. На відміну від DP2
# (resources.assets + окремий .resS), HBR-текстури живуть у Unity Asset Bundle,
# тому шлях один: переключаємо Texture2D на INLINE-режим (image data ← нові
# байти, m_StreamData очищаємо), і пишемо bundle ОДНИМ uncompressed-Write,
# тим самим патерном, що hbr-text-import / hbr-fonts-import.
#
# Один .bundle.textures.bak створюється ТІЛЬКИ ПРИ ПЕРШОМУ replace —
# подальші replace патчать live-bundle, не перезаписуючи бекап.
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями
#   -InputJson   : шлях до JSON-файла зі списком замін
#                  [{ "pathId": "8010679797385409155", "pngPath": "C:\\...\\allmap_00.png" }, ...]
#                  (передаємо через файл, бо CSV з шляхами Windows-style з '\'
#                   та пробілами кругом погано escape'ятиметься через PowerShell args)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$InputJson
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $InputJson))  { throw "InputJson not found: $InputJson" }

$replaceItems = $null
try {
    $raw = [System.IO.File]::ReadAllText($InputJson, [System.Text.Encoding]::UTF8)
    $replaceItems = $raw | ConvertFrom-Json
} catch { throw "InputJson parse failed: $($_.Exception.Message)" }
if ($null -eq $replaceItems) { throw "InputJson empty" }
# JSON може бути одиничним об'єктом — гарантуємо масив.
if ($replaceItems -isnot [System.Collections.IEnumerable] -or $replaceItems -is [string]) {
    $replaceItems = @($replaceItems)
}
if (@($replaceItems).Count -eq 0) { throw "InputJson: no items to replace" }

# Pre-validate PNG paths — fail fast, до завантаження bundle і DLL'їв.
foreach ($item in $replaceItems) {
    if (-not $item.pathId) { throw "InputJson: missing pathId in one of items" }
    if (-not $item.pngPath) { throw "InputJson: missing pngPath for PathID $($item.pathId)" }
    if (-not (Test-Path $item.pngPath)) { throw "PNG not found: $($item.pngPath) (PathID $($item.pathId))" }
}

$loadList = @(
    "Mono.Cecil.dll", "LibCpp2IL.dll",
    "Newtonsoft.Json.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll", "AssetsTools.NET.Cpp2IL.dll",
    "AssetRipper.Primitives.dll", "AssetRipper.TextureDecoder.dll",
    "AssetsTools.NET.Texture.dll", "SkiaSharp.dll",
    "StbImageSharp.dll"
)
foreach ($name in $loadList) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}

# Native encoder DLL'и (textureencoder.dll, cuttlefish.dll) у runtimes\win-x64\native.
$nativeDir = Join-Path $UabeaDir "runtimes/win-x64/native"
if (Test-Path $nativeDir) { $env:PATH = "$nativeDir;$env:PATH" }

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)
# RefType cache потрібен для MonoBehaviour-сусідів у тому ж AFI — без нього
# Write серіалізує managed-references неповно і гра падає (Read N expected M).
$manager.UseRefTypeManagerCache = $true
$manager.UseTemplateFieldCache = $true
$manager.UseMonoTemplateFieldCache = $true

Write-Step "Loading bundle: $BundlePath"
$bundleInst = $manager.LoadBundleFile($BundlePath)
$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AFIs: $afiCount"

# IL2CPP / Mono temp-generator — той самий патерн, що hbr-fonts-import.
$dataDir = Split-Path -Parent (Split-Path -Parent $BundlePath)
$managedDir = Join-Path $dataDir "Managed"
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    try {
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator ready"
    } catch { Write-Warning "Cpp2IL init failed: $($_.Exception.Message)" }
} elseif (Test-Path $managedDir) {
    try {
        $monoGen = New-Object AssetsTools.NET.MonoCecil.MonoCecilTempGenerator($managedDir)
        $manager.MonoTempGenerator = $monoGen
    } catch {}
}

$afiInstances = @{}

function Initialize-RefTypeCache {
    param($mgr, $inst)
    $cnt = 0
    foreach ($ai in $inst.file.AssetInfos) {
        if ($ai.TypeId -ne 114) { continue }
        try { $null = $mgr.GetBaseField($inst, $ai); $cnt++ } catch {}
    }
    Write-Diag "  RefTypeCache: prefetched $cnt MonoBehaviour fields"
}

for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    try {
        $inst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx)
        if ($null -ne $inst) {
            $afiInstances[$afiIdx] = $inst
            $null = $manager.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
            Initialize-RefTypeCache -mgr $manager -inst $inst
        }
    } catch {}
}

$csCode = @'
using System;
using AssetsTools.NET;
using AssetsTools.NET.Texture;

public static class HbrTexPatcher {
    public static string LastErr = "";
    public static int LastEncW;
    public static int LastEncH;
    public static int LastMipCount;

    // mipCount: рівно стільки рівнів, скільки має оригінальна текстура.
    // Для UI-текстур у HBR-бандлі зазвичай 1, але якщо m_MipCount > 1 —
    // треба згенерувати повний chain, інакше Unity показуватиме «сніг» при
    // на нижчих рівнях деталізації.
    public static byte[] EncodePngTo(string pngPath, int fmt, int mipCount) {
        try {
            if (mipCount <= 0) mipCount = 1;
            int w = 0, h = 0;
            byte[][] mips = TextureEncoderWrapper.ConvertImage(pngPath, mipCount, (TextureFormat)fmt, out w, out h, 100);
            LastEncW = w; LastEncH = h;
            if (mips == null || mips.Length == 0) { LastErr = "ConvertImage → null/empty"; return null; }
            LastMipCount = mips.Length;
            int total = 0;
            for (int i = 0; i < mips.Length; i++) { if (mips[i] == null) { LastErr = "mip " + i + " null"; return null; } total += mips[i].Length; }
            if (total == 0) { LastErr = "all mips empty"; return null; }
            byte[] result = new byte[total];
            int offset = 0;
            for (int i = 0; i < mips.Length; i++) {
                Buffer.BlockCopy(mips[i], 0, result, offset, mips[i].Length);
                offset += mips[i].Length;
            }
            return result;
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    (Join-Path $UabeaDir "AssetsTools.NET.Texture.dll"),
    'netstandard', 'System.Runtime'
)
try { Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { throw "HbrTexPatcher compile fail: $($_.Exception.Message)" }

$applied = 0
$failed = New-Object System.Collections.ArrayList
$touchedAfi = New-Object 'System.Collections.Generic.HashSet[int]'

foreach ($item in $replaceItems) {
    $targetPathId = [int64]0
    if (-not [int64]::TryParse([string]$item.pathId, [ref]$targetPathId)) {
        [void]$failed.Add([pscustomobject]@{ pathId = $item.pathId; reason = "PathID not int64" })
        Write-Host ("[FAIL] PathID '{0}': not a valid int64" -f $item.pathId)
        continue
    }
    $pngPath = [string]$item.pngPath
    Write-Step ("Patching PathID {0} ← {1}" -f $targetPathId, $pngPath)

    $foundAfiIdx = -1
    $foundInfo = $null
    foreach ($k in $afiInstances.Keys) {
        $inst = $afiInstances[$k]
        foreach ($ai in $inst.file.AssetInfos) {
            if ([int64]$ai.PathId -eq $targetPathId) { $foundAfiIdx = $k; $foundInfo = $ai; break }
        }
        if ($null -ne $foundInfo) { break }
    }
    if ($null -eq $foundInfo) {
        [void]$failed.Add([pscustomobject]@{ pathId = $targetPathId; reason = "PathID not found in any AFI" })
        Write-Host ("[FAIL] PathID {0}: not found" -f $targetPathId)
        continue
    }
    if ($foundInfo.TypeId -ne 28) {
        [void]$failed.Add([pscustomobject]@{ pathId = $targetPathId; reason = "TypeId $($foundInfo.TypeId) != 28 (Texture2D)" })
        Write-Host ("[FAIL] PathID {0}: TypeId {1} != 28" -f $targetPathId, $foundInfo.TypeId)
        continue
    }
    try {
        $assetsInst = $afiInstances[$foundAfiIdx]
        $base = $manager.GetBaseField($assetsInst, $foundInfo)
        $origW = [int]$base["m_Width"].AsInt
        $origH = [int]$base["m_Height"].AsInt
        $origFmt = [int]$base["m_TextureFormat"].AsInt
        $origMipCount = 1
        try { $origMipCount = [int]$base["m_MipCount"].AsInt } catch {}
        if ($origMipCount -le 0) { $origMipCount = 1 }

        $encoded = [HbrTexPatcher]::EncodePngTo($pngPath, $origFmt, $origMipCount)
        if ($null -eq $encoded) {
            [void]$failed.Add([pscustomobject]@{ pathId = $targetPathId; reason = "Encode: " + [HbrTexPatcher]::LastErr })
            Write-Host ("[FAIL] PathID {0}: {1}" -f $targetPathId, [HbrTexPatcher]::LastErr)
            continue
        }
        $newW = [HbrTexPatcher]::LastEncW
        $newH = [HbrTexPatcher]::LastEncH

        # INLINE-режим: пікселі ⇒ image data, m_StreamData очищаємо. Це
        # повністю-підтримуваний Unity-шлях; bundle стане трохи більшим, але
        # переписувати .resS-блок усередині bundle складно — не варто.
        $streamPath = ""
        try { $streamPath = $base["m_StreamData"]["path"].AsString } catch {}

        $imgDataField = $base["image data"]
        if ($null -eq $imgDataField) { throw "image data field missing" }
        try { $imgDataField.AsByteArray = $encoded }
        catch {
            $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::ByteArray, $encoded)
            $imgDataField.Value = $atv
        }
        $base["m_CompleteImageSize"].AsInt = $encoded.Length
        if ($newW -ne $origW) { $base["m_Width"].AsInt = $newW }
        if ($newH -ne $origH) { $base["m_Height"].AsInt = $newH }
        if (-not [string]::IsNullOrWhiteSpace($streamPath)) {
            try { $base["m_StreamData"]["path"].AsString = "" } catch {}
            try { $base["m_StreamData"]["offset"].AsLong = 0 } catch {
                try { $base["m_StreamData"]["offset"].AsInt = 0 } catch {}
            }
            try { $base["m_StreamData"]["size"].AsLong = 0 } catch {
                try { $base["m_StreamData"]["size"].AsInt = 0 } catch {}
            }
            Write-Diag ("  inlined: cleared m_StreamData ('{0}')" -f $streamPath)
        }
        $foundInfo.SetNewData($base)
        [void]$touchedAfi.Add($foundAfiIdx)
        $applied++
        Write-Host ("[PATCHED] PathID {0} ({1}x{2} fmt={3}, bytes={4})" -f $targetPathId, $newW, $newH, $origFmt, $encoded.Length)
    } catch {
        [void]$failed.Add([pscustomobject]@{ pathId = $targetPathId; reason = $_.Exception.Message })
        Write-Host ("[FAIL] PathID {0}: {1}" -f $targetPathId, $_.Exception.Message)
    }
}

if ($applied -eq 0) {
    Write-Step "Nothing applied — bundle untouched."
    $summary = [pscustomobject]@{
        ok = $false; bundle = $BundlePath; applied = 0
        failed = $failed.ToArray(); reason = "no-applied"
    }
    Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
    exit 1
}

Write-Step "Writing bundle (single uncompressed Write — same as UABEA Save)…"
$bak = $BundlePath + ".textures.bak"
$bakCreated = $false
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $BundlePath -Destination $bak -Force
    $bakCreated = $true
    Write-Diag "Backup → $bak"
}

$writeTarget = $BundlePath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    foreach ($k in $touchedAfi) {
        $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$k].SetNewData($afiInstances[$k].file)
    }
    $bundleInst.file.Write($writer)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}
foreach ($k in $afiInstances.Keys) {
    try { $afiInstances[$k].file.Reader.Close() } catch {}
}
try { $bundleInst.file.Reader.Close() } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Move-Item -LiteralPath $writeTarget -Destination $BundlePath -Force
$outSize = (Get-Item $BundlePath).Length
$bakSize = (Get-Item $bak).Length

Write-Step ("DONE → {0} ({1:N0} bytes; .textures.bak {2:N0}), applied {3}, failed {4}" -f $BundlePath, $outSize, $bakSize, $applied, $failed.Count)
$summary = [pscustomobject]@{
    ok = $true; bundle = $BundlePath; size = $outSize; bakSize = $bakSize; bakCreated = $bakCreated
    applied = $applied; failed = $failed.ToArray()
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
exit 0
