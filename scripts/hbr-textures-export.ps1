# Hotel Barcelona — Textures Export.
#
# Розпаковує Texture2D з .bundle за СПИСКОМ PathID (CSV). Якщо PathIds не
# вказано — експортує ВСІ Texture2D у bundle (як hbr-fonts-atlas-export.ps1
# по фільтру 'atlas', тільки без фільтра).
#
# Формат імені PNG повторює UABEA Next:
#   <m_Name>-<assetsFileNameInBundle>-<pathId>.png
# напр. "allmap_00-CAB-89c332e3a37c28aedc3cf762487a736e-8010679797385409155.png"
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -OutDir      : куди писати PNG (toolsDir/HBR/Textures/Unpack)
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями
#   -PathIds     : CSV int64 (optional). Порожньо/відсутньо → ВСІ Texture2D.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$false)] [string]$PathIds = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# Парсимо CSV PathID одразу в HashSet[int64] для O(1) lookup. Порожньо → null
# (фільтр вимикається).
$pathIdFilter = $null
if ($PathIds -and $PathIds.Trim().Length -gt 0) {
    $pathIdFilter = New-Object 'System.Collections.Generic.HashSet[int64]'
    foreach ($s in $PathIds.Split(',')) {
        $t = $s.Trim()
        if ($t.Length -eq 0) { continue }
        $v = [int64]0
        if ([int64]::TryParse($t, [ref]$v)) { [void]$pathIdFilter.Add($v) }
        else { Write-Diag "  skip invalid PathID token: '$t'" }
    }
    Write-Diag ("PathID filter: {0} entries" -f $pathIdFilter.Count)
}

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
# до PATH, аби P/Invoke їх знайшов. Декодеру вони не потрібні, але робимо за
# аналогією з textures-export.ps1/fonts-atlas-export.ps1.
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
$missingIds = $null
if ($null -ne $pathIdFilter) {
    # Копія для відстеження ще не знайдених — після обходу що залишиться,
    # це і є відсутні в bundle PathID.
    $missingIds = New-Object 'System.Collections.Generic.HashSet[int64]'
    foreach ($id in $pathIdFilter) { [void]$missingIds.Add($id) }
}

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
        if ($null -ne $pathIdFilter -and -not $pathIdFilter.Contains($pathId)) { $skipped++; continue }

        try {
            $base = $manager.GetBaseField($assetsInst, $info)
            if ($null -eq $base) { continue }
            $name = $null
            try { $name = $base["m_Name"].AsString } catch {}
            if (-not $name) { $name = "Texture2D" }

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
            if ($null -ne $missingIds) { [void]$missingIds.Remove($pathId) }

            [void]$exported.Add([pscustomobject]@{
                name = $name; pathId = $pathId; width = $w; height = $h; format = $fmt
                file = $outFile; size = $pngBytes.Length; assetsFile = $assetsFileName
            })
        } catch {
            Write-Warning ("PathID {0}: {1}" -f $pathId, $_.Exception.Message)
        }
    }
}

$missingArr = @()
if ($null -ne $missingIds) {
    $missingArr = @($missingIds)
    foreach ($m in $missingArr) { Write-Warning ("PathID {0} not found in bundle" -f $m) }
}

Write-Step ("DONE: exported {0} textures to {1} (skipped {2}; missing {3})" -f $exported.Count, $OutDir, $skipped, $missingArr.Count)
$summary = [pscustomobject]@{
    ok = $true; outDir = $OutDir; bundle = $BundlePath
    exported = $exported.ToArray(); total = $exported.Count
    skipped = $skipped; missing = $missingArr
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
exit 0
