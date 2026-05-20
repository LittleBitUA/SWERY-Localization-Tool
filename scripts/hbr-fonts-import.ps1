# Hotel Barcelona — Fonts Import (Pack back into bundle).
#
# Бере відредаговані файли з:
#   $MonoDir\<m_Name>-<assetsFileNameInBundle>-<pathId>.json   (TMP_FontAsset)
#   $AtlasDir\<m_Name>-<assetsFileNameInBundle>-<pathId>.png   (SDF atlas)
# і пакує їх назад у bundle. Bundle записується ОДНИМ Write — тим самим
# способом, що hbr-text-import.ps1; це критично, інакше Unity видає
# "Will not load AssetBundle" або "Read N bytes but expected M bytes".
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -AtlasDir    : Documents\SWERY-Localization-Tool\HBR\Fonts\Atlas\
#   -MonoDir     : Documents\SWERY-Localization-Tool\HBR\Fonts\MonoBehaviour\
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$AtlasDir,
    [Parameter(Mandatory=$true)] [string]$MonoDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $AtlasDir))   { Write-Diag "Atlas dir not present — атласи пропускаємо: $AtlasDir" }
if (-not (Test-Path $MonoDir))    { Write-Diag "Mono dir not present — TMP_FontAsset пропускаємо: $MonoDir" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

$loadList = @(
    "Mono.Cecil.dll", "LibCpp2IL.dll",
    "Newtonsoft.Json.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll", "AssetsTools.NET.Cpp2IL.dll",
    "AssetRipper.Primitives.dll", "AssetRipper.TextureDecoder.dll",
    "AssetsTools.NET.Texture.dll", "SkiaSharp.dll",
    "StbImageSharp.dll",
    "UABEANext4.dll"
)
foreach ($name in $loadList) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}

# native DLL'и текстурного енкодера лежать у runtimes/win-x64/native — додаємо
# до PATH, аби P/Invoke їх знайшов (textureencoder.dll, cuttlefish.dll, тощо).
$nativeDir = Join-Path $UabeaDir "runtimes/win-x64/native"
if (Test-Path $nativeDir) { $env:PATH = "$nativeDir;$env:PATH" }

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)
# Як у text-import.ps1: вмикаємо кеші, інакше ImportJsonAsset серіалізує
# MonoBehaviour без managed-references і Unity тримає 'Read N expected M'.
$manager.UseRefTypeManagerCache = $true
$manager.UseTemplateFieldCache = $true
$manager.UseMonoTemplateFieldCache = $true

Write-Step "Loading bundle: $BundlePath"
$bundleInst = $manager.LoadBundleFile($BundlePath)
$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AFIs: $afiCount"

# IL2CPP / Mono generator — повторюємо логіку text-import.
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

# Завантажуємо всі AFI + прогріваємо RefTypeCache. Це КРИТИЧНО — без цього
# ImportJsonAsset пропускає managed-references і гра вилітає.
$afiInstances = @{}
$afiByName = @{}

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
    $dirInfo = $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$afiIdx]
    try {
        $inst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx)
        if ($null -ne $inst) {
            $afiInstances[$afiIdx] = $inst
            $afiByName[$dirInfo.Name] = $afiIdx
            $null = $manager.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
            Initialize-RefTypeCache -mgr $manager -inst $inst
        }
    } catch {}
}

# Inline C# хелпери: ImportJsonAsset для MB + EncodePngTo для Texture2D.
$csCode = @'
using System;
using System.IO;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;
using UABEANext4.Logic.ImportExport;

public static class HbrFontsPatcher {
    public static string LastErr = "";

    public static byte[] ImportJson(AssetsManager manager, AssetsFileInstance inst, AssetTypeTemplateField template, string jsonRaw) {
        try {
            byte[] inBytes = Encoding.UTF8.GetBytes(jsonRaw);
            using (var ms = new MemoryStream(inBytes)) {
                var refMan = manager.GetRefTypeManager(inst);
                var importer = new AssetImport(ms, refMan);
                string error;
                byte[] bytes = importer.ImportJsonAsset(template, out error);
                if (!string.IsNullOrEmpty(error)) { LastErr = error; return null; }
                if (bytes == null) { LastErr = "ImportJsonAsset returned null"; return null; }
                return bytes;
            }
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }

    public static int LastEncW;
    public static int LastEncH;
    public static byte[] EncodePngTo(string pngPath, int fmt) {
        try {
            int w = 0, h = 0;
            byte[][] mips = TextureEncoderWrapper.ConvertImage(pngPath, 1, (TextureFormat)fmt, out w, out h, 100);
            LastEncW = w; LastEncH = h;
            if (mips != null && mips.Length > 0 && mips[0] != null && mips[0].Length > 0) return mips[0];
            LastErr = "ConvertImage → null/empty";
            return null;
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
    (Join-Path $UabeaDir "UABEANext4.dll"),
    'netstandard', 'System.Runtime', 'System.IO',
    'System.Collections'
)
try { Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { throw "HbrFontsPatcher compile fail: $($_.Exception.Message)" }

# Парсимо назви файлів: <m_Name>-<CAB-...>-<pathId>.<ext>
# pathId може бути від'ємний → у файлі тоді дві риски підряд перед числом.
function Parse-FontFileName {
    param([string]$fileName)
    $m = [regex]::Match($fileName, '^(?<name>.+)-(?<afi>CAB-[a-f0-9]+)-(?<pid>-?\d+)\.(png|json)$', 'IgnoreCase')
    if (-not $m.Success) { return $null }
    return [pscustomobject]@{
        name = $m.Groups['name'].Value
        afiName = $m.Groups['afi'].Value
        pathId = [int64]$m.Groups['pid'].Value
    }
}

$monoApplied = 0
$atlasApplied = 0
$failed = New-Object System.Collections.ArrayList

# ── MonoBehaviour ──────────────────────────────────────────────────────
if (Test-Path $MonoDir) {
    Write-Step "Importing MonoBehaviour (TMP_FontAsset)…"
    $jsonFiles = Get-ChildItem -LiteralPath $MonoDir -Filter "*.json" -File -ErrorAction SilentlyContinue
    foreach ($jf in $jsonFiles) {
        $parsed = Parse-FontFileName $jf.Name
        if ($null -eq $parsed) {
            [void]$failed.Add([pscustomobject]@{ file = $jf.Name; reason = "filename pattern mismatch" })
            continue
        }
        if (-not $afiByName.ContainsKey($parsed.afiName)) {
            [void]$failed.Add([pscustomobject]@{ file = $jf.Name; reason = "AFI '$($parsed.afiName)' not in bundle" })
            continue
        }
        $assetsInst = $afiInstances[$afiByName[$parsed.afiName]]
        $info = $null
        foreach ($ai in $assetsInst.file.AssetInfos) {
            if ([int64]$ai.PathId -eq $parsed.pathId) { $info = $ai; break }
        }
        if ($null -eq $info) {
            [void]$failed.Add([pscustomobject]@{ file = $jf.Name; reason = "PathID $($parsed.pathId) not found" })
            continue
        }
        if ($info.TypeId -ne 114) {
            [void]$failed.Add([pscustomobject]@{ file = $jf.Name; reason = "TypeId $($info.TypeId) != 114 (MonoBehaviour)" })
            continue
        }
        try {
            # Прогріваємо template + refTypeMan через GetBaseField.
            $null = $manager.GetBaseField($assetsInst, $info)
            $tpl = $manager.GetTemplateBaseField($assetsInst, $info)
            $raw = [System.IO.File]::ReadAllText($jf.FullName, [System.Text.Encoding]::UTF8)
            $bytes = [HbrFontsPatcher]::ImportJson($manager, $assetsInst, $tpl, $raw)
            if ($null -eq $bytes) {
                [void]$failed.Add([pscustomobject]@{ file = $jf.Name; reason = "ImportJson: " + [HbrFontsPatcher]::LastErr })
                Write-Host ("[FAIL] {0}: {1}" -f $jf.Name, [HbrFontsPatcher]::LastErr)
                continue
            }
            $info.SetNewData($bytes)
            $monoApplied++
            Write-Host ("[PATCHED-MB] {0} (PathID {1}, bytes={2})" -f $parsed.name, $parsed.pathId, $bytes.Length)
        } catch {
            [void]$failed.Add([pscustomobject]@{ file = $jf.Name; reason = $_.Exception.Message })
            Write-Host ("[FAIL] {0}: {1}" -f $jf.Name, $_.Exception.Message)
        }
    }
}

# ── Texture2D (Atlas PNG) ──────────────────────────────────────────────
# Логіка така ж, як у DP2 textures-replace.ps1 (inline-режим), бо у asset-
# bundle стрімінгу немає — пікселі завжди лежать в `image data` всередині
# самого Texture2D. Розмір/формат можуть змінитись — m_Width/Height/
# m_CompleteImageSize оновлюємо, AssetsTools.NET сам перерахує offsets під
# час Write.
if (Test-Path $AtlasDir) {
    Write-Step "Importing Texture2D atlases…"
    $pngFiles = Get-ChildItem -LiteralPath $AtlasDir -Filter "*.png" -File -ErrorAction SilentlyContinue
    foreach ($pf in $pngFiles) {
        $parsed = Parse-FontFileName $pf.Name
        if ($null -eq $parsed) {
            [void]$failed.Add([pscustomobject]@{ file = $pf.Name; reason = "filename pattern mismatch" })
            continue
        }
        if (-not $afiByName.ContainsKey($parsed.afiName)) {
            [void]$failed.Add([pscustomobject]@{ file = $pf.Name; reason = "AFI '$($parsed.afiName)' not in bundle" })
            continue
        }
        $assetsInst = $afiInstances[$afiByName[$parsed.afiName]]
        $info = $null
        foreach ($ai in $assetsInst.file.AssetInfos) {
            if ([int64]$ai.PathId -eq $parsed.pathId) { $info = $ai; break }
        }
        if ($null -eq $info) {
            [void]$failed.Add([pscustomobject]@{ file = $pf.Name; reason = "PathID $($parsed.pathId) not found" })
            continue
        }
        if ($info.TypeId -ne 28) {
            [void]$failed.Add([pscustomobject]@{ file = $pf.Name; reason = "TypeId $($info.TypeId) != 28 (Texture2D)" })
            continue
        }
        try {
            $base = $manager.GetBaseField($assetsInst, $info)
            $origW = [int]$base["m_Width"].AsInt
            $origH = [int]$base["m_Height"].AsInt
            $origFmt = [int]$base["m_TextureFormat"].AsInt
            $encoded = [HbrFontsPatcher]::EncodePngTo($pf.FullName, $origFmt)
            if ($null -eq $encoded) {
                [void]$failed.Add([pscustomobject]@{ file = $pf.Name; reason = "Encode: " + [HbrFontsPatcher]::LastErr })
                Write-Host ("[FAIL] {0}: {1}" -f $pf.Name, [HbrFontsPatcher]::LastErr)
                continue
            }
            $newW = [HbrFontsPatcher]::LastEncW
            $newH = [HbrFontsPatcher]::LastEncH

            # У HBR-bundle атласи зазвичай мають m_StreamData.path =
            # "archive:/CAB-…/CAB-….resS" — пікселі живуть в archive-resource
            # всередині самого bundle. Перезаписувати .resS-блок bundle важко;
            # значно простіше переключити Texture2D на INLINE: складуємо нові
            # байти в `image data`, очищаємо m_StreamData. Unity має fallback
            # на inline-pixel-data — це повністю підтримуваний шлях. Bundle
            # стане трохи більшим, але працює без додаткових кроків.
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
            # Очистити streaming — інакше Unity ігнорує inline image data.
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
            $info.SetNewData($base)
            $atlasApplied++
            Write-Host ("[PATCHED-TEX] {0} ({1}x{2} fmt={3}, PathID {4}, bytes={5})" -f $parsed.name, $newW, $newH, $origFmt, $parsed.pathId, $encoded.Length)
        } catch {
            [void]$failed.Add([pscustomobject]@{ file = $pf.Name; reason = $_.Exception.Message })
            Write-Host ("[FAIL] {0}: {1}" -f $pf.Name, $_.Exception.Message)
        }
    }
}

# ── Write bundle (single Write, як у text-import) ───────────────────────
Write-Step "Writing bundle (single uncompressed Write — same as UABEA Save)…"
$bak = $BundlePath + ".fonts.bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $BundlePath -Destination $bak -Force
    Write-Diag "Backup → $bak"
}

$writeTarget = $BundlePath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    foreach ($k in $afiInstances.Keys) {
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
Write-Step ("DONE → {0} ({1:N0} bytes; .fonts.bak {2:N0}), MB applied {3}, atlas applied {4}, failed {5}" -f $BundlePath, $outSize, $bakSize, $monoApplied, $atlasApplied, $failed.Count)

$summary = [pscustomobject]@{
    ok = $true; bundle = $BundlePath; size = $outSize; bakSize = $bakSize
    monoApplied = $monoApplied; atlasApplied = $atlasApplied
    failed = $failed.ToArray()
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
exit 0
