# Hotel Barcelona — Fonts Atlas Export.
#
# Розпаковує всі Texture2D з bundle, де m_Name містить "atlas" (case-insensitive)
# — це SDF-атласи TMP-шрифтів. Формат імені файлу повторює UABEA Next:
#   <m_Name>-<assetsFileNameInBundle>-<pathId>.png
# напр. "FOT-ComicMysteryStd-DB Atlas-CAB-89c332e3a37c28aedc3cf762487a736e--1777873811223092169.png"
#
# Декодер той самий, що в DP2 textures-export.ps1 — AssetsTools.NET.Texture,
# який сам коректно опрацьовує A8/R8/RGBA32/BC* і поверне готовий PNG.
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -OutDir      : куди писати PNG
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$loadList = @(
    "Mono.Cecil.dll",
    "LibCpp2IL.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll",
    "AssetsTools.NET.Cpp2IL.dll",
    "AssetRipper.Primitives.dll",
    "AssetRipper.TextureDecoder.dll",
    "AssetsTools.NET.Texture.dll",
    "SkiaSharp.dll"
)
foreach ($name in $loadList) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) {
        try { $null = [System.Reflection.Assembly]::LoadFrom($p) }
        catch { Write-Diag "  load $name failed: $($_.Exception.Message)" }
    }
}

# native DLL'и текстурного енкодера лежать у runtimes/win-x64/native — додаємо
# до PATH, аби P/Invoke їх знайшов. Декодер ці бібліотеки сам не вантажить, але
# для consistency з textures-export.ps1 робимо те саме.
$nativeDir = Join-Path $UabeaDir "runtimes/win-x64/native"
if (Test-Path $nativeDir) { $env:PATH = "$nativeDir;$env:PATH" }

$csCode = @'
using System;
using System.IO;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;

public static class TexExport {
    public static int LastWidth;
    public static int LastHeight;
    public static int LastFormat;
    public static string LastName = "";
    public static string LastError = "";

    public static byte[] DecodePng(AssetsFileInstance afi, AssetTypeValueField baseField) {
        try {
            TextureFile tex = TextureFile.ReadTextureFile(baseField);
            LastName = tex.m_Name ?? "";
            LastWidth = tex.m_Width;
            LastHeight = tex.m_Height;
            LastFormat = (int)tex.m_TextureFormat;

            byte[] rawData = tex.FillPictureData(afi);
            if (rawData == null || rawData.Length == 0) {
                LastError = "FillPictureData null/empty";
                return null;
            }
            using (var ms = new MemoryStream()) {
                bool ok = tex.DecodeTextureImage(rawData, ms, ImageExportType.Png, 100);
                if (!ok) {
                    LastError = "DecodeTextureImage returned false (format " + tex.m_TextureFormat + ")";
                    return null;
                }
                return ms.ToArray();
            }
        } catch (Exception ex) {
            LastError = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }
}
'@

$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    (Join-Path $UabeaDir "AssetsTools.NET.Texture.dll"),
    (Join-Path $UabeaDir "SkiaSharp.dll"),
    'netstandard', 'System.Runtime', 'System.Collections', 'System.IO',
    'System.Runtime.InteropServices'
)
try {
    Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop
    Write-Diag "TexExport helper compiled OK"
} catch {
    throw "Не вдалося скомпілювати C# хелпер для текстур: $($_.Exception.Message)"
}

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)

Write-Step "Loading bundle: $BundlePath"
$bundleInst = $manager.LoadBundleFile($BundlePath)
if ($null -eq $bundleInst) { throw "Failed to load bundle" }

$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AssetsFiles inside: $afiCount"

$exported = New-Object System.Collections.ArrayList
$skipped = 0

for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    $dirInfo = $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$afiIdx]
    $assetsFileName = $dirInfo.Name
    $assetsInst = $null
    try { $assetsInst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx) }
    catch {
        Write-Diag ("  AFI[{0}] '{1}' not assets-file: {2}" -f $afiIdx, $assetsFileName, $_.Exception.Message)
        continue
    }
    if ($null -eq $assetsInst) { continue }
    $null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)
    Write-Diag ("  AFI[{0}] '{1}' Unity {2}, AssetInfos={3}" -f $afiIdx, $assetsFileName, $assetsInst.file.Metadata.UnityVersion, @($assetsInst.file.AssetInfos).Count)

    foreach ($info in $assetsInst.file.AssetInfos) {
        if ($info.TypeId -ne 28) { continue }  # Texture2D
        $pathId = [int64]$info.PathId
        try {
            $base = $manager.GetBaseField($assetsInst, $info)
            if ($null -eq $base) { continue }
            $name = $null
            try { $name = $base["m_Name"].AsString } catch {}
            if (-not $name) { continue }
            # Case-insensitive substring match "atlas".
            if ($name -notmatch '(?i)atlas') { $skipped++; continue }

            $pngBytes = [TexExport]::DecodePng($assetsInst, $base)
            if ($null -eq $pngBytes -or $pngBytes.Length -eq 0) {
                Write-Warning ("PathID {0} ({1}): {2}" -f $pathId, $name, [TexExport]::LastError)
                continue
            }

            $safe = $name -replace '[\\/:\*\?"<>\|]', '_'
            $outFile = Join-Path $OutDir ("{0}-{1}-{2}.png" -f $safe, $assetsFileName, $pathId)
            [System.IO.File]::WriteAllBytes($outFile, $pngBytes)
            $w = [TexExport]::LastWidth
            $h = [TexExport]::LastHeight
            $fmt = [TexExport]::LastFormat
            Write-Host ("[EXPORTED] {0} ({1}x{2}, fmt={3}, PathID {4}) -> {5} ({6:N0} bytes)" -f $name, $w, $h, $fmt, $pathId, $outFile, $pngBytes.Length)

            [void]$exported.Add([pscustomobject]@{
                name = $name; pathId = $pathId; width = $w; height = $h; format = $fmt
                file = $outFile; size = $pngBytes.Length; assetsFile = $assetsFileName
            })
        } catch {
            Write-Warning ("PathID {0}: {1}" -f $pathId, $_.Exception.Message)
        }
    }
}

Write-Step ("DONE: exported {0} atlases to {1} (skipped {2} non-atlas Texture2D)" -f $exported.Count, $OutDir, $skipped)
$summary = [pscustomobject]@{
    ok = $true; outDir = $OutDir; bundle = $BundlePath
    exported = $exported.ToArray(); total = $exported.Count; skipped = $skipped
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
exit 0
