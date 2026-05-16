# DP2 Textures Export — витягує Texture2D-ассети з resources.assets, декодує
# pixel-data (через AssetsTools.NET.Texture, з підтримкою m_StreamData/.resS)
# і записує PNG: <name>-<asset>-<pathId>.png — як robить UABEA Next plugin.
#
# Параметри:
#   -AssetsPath  : путь до resources.assets
#   -OutDir      : куди писати PNG
#   -UabeaDir    : тека з UABEA DLL'ями (AssetsTools.NET.dll + .Texture, SkiaSharp)
#   -PathIds     : опційний CSV перелік pathId; пусто = всі Texture2D

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [string]$PathIds = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw ".assets not found: $AssetsPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# Load required DLLs (порядок важливий: залежності спочатку).
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
    } else {
        Write-Diag "  $name not found in UABEA dir (skip)"
    }
}

# Inline C# хелпер: AssetsTools.NET.Texture сама вміє PNG через
# DecodeTextureImage(rawBytes, stream, ImageExportType.Png, flip).
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
                // 4-й аргумент — quality (для PNG ігнорується); flip Y робить
                // DecodeTextureImage сам, відповідно до orientation Unity.
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

$script:HelperReady = $false
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    (Join-Path $UabeaDir "AssetsTools.NET.Texture.dll"),
    (Join-Path $UabeaDir "SkiaSharp.dll"),
    'netstandard', 'System.Runtime', 'System.Collections', 'System.IO',
    'System.Runtime.InteropServices'
)
# CS1701/CS1702 — попередження про різницю мажорної версії System.Runtime між
# скомпільованим DLL і runtime (.NET 10). Це warning-as-error за замовч.
# /nowarn вимикає його — версії API сумісні, AssetsTools.NET.Texture працює.
try {
    Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop
    $script:HelperReady = $true
    Write-Diag "TexExport helper compiled OK"
} catch {
    throw "Не вдалося скомпілювати C# хелпер для текстур: $($_.Exception.Message)"
}

# Parse CSV pathId filter.
$wantedSet = $null
if ($PathIds.Trim() -ne "") {
    $wantedSet = New-Object System.Collections.Generic.HashSet[Int64]
    foreach ($p in ($PathIds -split ",")) {
        $v = [Int64]0
        if ([Int64]::TryParse($p.Trim(), [ref]$v)) { [void]$wantedSet.Add($v) }
    }
    Write-Diag ("PathId filter: {0}" -f (($wantedSet) -join ","))
}

Write-Step "Loading $AssetsPath ..."
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$null = $manager.LoadClassPackage($tpkPath)
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)
Write-Diag "Unity version: $($assetsInst.file.Metadata.UnityVersion)"

Write-Step "Scanning Texture2D assets (TypeId=28)..."
$exported = @()
$assetBaseName = [System.IO.Path]::GetFileNameWithoutExtension($AssetsPath) + [System.IO.Path]::GetExtension($AssetsPath)

foreach ($info in $assetsInst.file.AssetInfos) {
    if ($info.TypeId -ne 28) { continue }
    if ($null -ne $wantedSet -and -not $wantedSet.Contains([Int64]$info.PathId)) { continue }

    try {
        $base = $manager.GetBaseField($assetsInst, $info)
        if ($null -eq $base) { continue }

        $pngBytes = [TexExport]::DecodePng($assetsInst, $base)
        $w = [TexExport]::LastWidth
        $h = [TexExport]::LastHeight
        $fmt = [TexExport]::LastFormat
        $texName = [TexExport]::LastName
        if (-not $texName) { $texName = "Texture_$($info.PathId)" }

        if ($null -eq $pngBytes -or $pngBytes.Length -eq 0) {
            Write-Warning ("PathID {0} ({1}): {2}" -f $info.PathId, $texName, [TexExport]::LastError)
            continue
        }

        $safe = $texName -replace '[\\/:\*\?"<>\|]', '_'
        $outFile = Join-Path $OutDir ("{0}-{1}-{2}.png" -f $safe, $assetBaseName, $info.PathId)
        [System.IO.File]::WriteAllBytes($outFile, $pngBytes)
        Write-Host ("Exported {0} ({1}x{2}, fmt={3}, PathID {4}) -> {5} ({6:N0} bytes)" -f $texName, $w, $h, $fmt, $info.PathId, $outFile, $pngBytes.Length)

        $exported += [pscustomobject]@{
            name = $texName
            pathId = $info.PathId
            width = $w
            height = $h
            format = $fmt
            file = $outFile
            size = $pngBytes.Length
        }
    } catch {
        Write-Warning ("PathID {0}: {1}" -f $info.PathId, $_.Exception.Message)
    }
}

Write-Step ("DONE: exported {0} textures to {1}" -f $exported.Count, $OutDir)
$json = $exported | ConvertTo-Json -Depth 5 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
