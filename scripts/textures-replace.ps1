# DP2 Textures Replace — підмінює пiксельні дані Texture2D одного PathID.
#
# Стратегія:
#   1. Прочитати PNG (StbImageSharp → RGBA32) і свапнути в BGRA32.
#   2. Знайти Texture2D у resources.assets, переконатися, що width/height/format
#      збігаються (інакше abort — щоб не зламати геометрію в грі).
#   3. Закодувати BGRA32 → байти у тому самому форматі (DXT5/BC3, тощо) через
#      AssetsTools.NET.Texture.TextureEncoderDecoder.
#   4. Якщо m_StreamData.path непорожній → байти лежать у .resS, тому пишемо
#      їх безпосередньо туди за offset (in-place patch; розмір збігається).
#      Якщо ні → оновлюємо inline image data у Texture2D.
#   5. Перепаковуємо resources.assets з .bak (як у fonts-replace.ps1).

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [Int64]$PathId,
    [Parameter(Mandatory=$true)] [string]$NewPngFile,
    [Parameter(Mandatory=$true)] [string]$OutputPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath))  { throw ".assets not found: $AssetsPath" }
if (-not (Test-Path $NewPngFile))  { throw "PNG not found: $NewPngFile" }
if (-not (Test-Path $UabeaDir))    { throw "UABEA dir not found: $UabeaDir" }

$loadList = @(
    "Mono.Cecil.dll",
    "LibCpp2IL.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll",
    "AssetsTools.NET.Cpp2IL.dll",
    "AssetRipper.Primitives.dll",
    "AssetRipper.TextureDecoder.dll",
    "AssetsTools.NET.Texture.dll",
    "StbImageSharp.dll"
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

# native DLL'и (textureencoder.dll, cuttlefish.dll, PVRTexLib.dll) лежать у
# runtimes/win-x64/native/ — додаємо до PATH, щоб P/Invoke їх знайшов.
$nativeDir = Join-Path $UabeaDir "runtimes/win-x64/native"
if (Test-Path $nativeDir) {
    $env:PATH = "$nativeDir;$env:PATH"
    Write-Diag "Native dir prepended to PATH: $nativeDir"
} else {
    Write-Diag "Native dir not found: $nativeDir"
}

# Inline C#: TextureEncoderWrapper.ConvertImage(pngPath, fmt, out w, out h, quality)
# уміє кодувати DXT5/BC7/тощо через native libs (AssetRipper.TextureDecoder).
$csCode = @'
using System;
using AssetsTools.NET.Texture;

public static class TexImport {
    public static int LastWidth;
    public static int LastHeight;
    public static string LastError = "";
    public static bool NativeOk;

    public static byte[] EncodePngTo(string pngPath, int fmt) {
        try {
            NativeOk = TextureEncoderWrapper.NativeLibrariesSupported();
            int w = 0, h = 0;
            // UABEA Next: ConvertImage(path, mipCount, TextureFormat, out w, out h, quality) -> byte[][]
            byte[][] mips = TextureEncoderWrapper.ConvertImage(pngPath, 1, (TextureFormat)fmt, out w, out h, 100);
            LastWidth = w;
            LastHeight = h;
            if (mips != null && mips.Length > 0 && mips[0] != null && mips[0].Length > 0) return mips[0];
            LastError = "ConvertImage → null/empty (NativeOk=" + NativeOk + ")";
            return null;
        } catch (Exception ex) {
            LastError = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }
}
'@

$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.Texture.dll"),
    'netstandard', 'System.Runtime'
)
try {
    Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop
    Write-Diag "TexImport helper compiled OK"
} catch {
    throw "Не вдалося скомпілювати C# хелпер для імпорту текстур: $($_.Exception.Message)"
}

Write-Step "Loading $AssetsPath ..."
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$null = $manager.LoadClassPackage($tpkPath)
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

$target = $null
foreach ($info in $assetsInst.file.AssetInfos) {
    if ([Int64]$info.PathId -eq $PathId) { $target = $info; break }
}
if ($null -eq $target) { throw "PathID $PathId not found in $AssetsPath" }
if ($target.TypeId -ne 28) { throw "PathID $PathId is not Texture2D (TypeId=$($target.TypeId))" }

$base = $manager.GetBaseField($assetsInst, $target)
$nameField = $base["m_Name"]
$texName = $nameField.AsString
$origW = [int]$base["m_Width"].AsInt
$origH = [int]$base["m_Height"].AsInt
$origFmt = [int]$base["m_TextureFormat"].AsInt
$origCompleteSize = [int]$base["m_CompleteImageSize"].AsInt
Write-Diag "Target: $texName (PathID $PathId), $origW x $origH, fmt=$origFmt, completeSize=$origCompleteSize"

# PNG → encoded у m_TextureFormat через TextureEncoderWrapper.ConvertImage.
$encoded = [TexImport]::EncodePngTo($NewPngFile, $origFmt)
if ($null -eq $encoded) { throw "Encode failed: $([TexImport]::LastError)" }
Write-Diag ("Native encoder support: {0}" -f [TexImport]::NativeOk)
$newW = [TexImport]::LastWidth
$newH = [TexImport]::LastHeight
Write-Diag "PNG: $newW x $newH, encoded bytes=$($encoded.Length)"

if ($newW -ne $origW -or $newH -ne $origH) {
    throw "PNG dimensions ($newW x $newH) != Texture2D ($origW x $origH). Resize the PNG to match before replacing."
}
if ($encoded.Length -ne $origCompleteSize) {
    throw "Encoded size ($($encoded.Length)) != original m_CompleteImageSize ($origCompleteSize). Aborting — would break offset table."
}

# Streaming info?
$streamPathField = $base["m_StreamData"]["path"]
$streamOffsetField = $base["m_StreamData"]["offset"]
$streamSizeField = $base["m_StreamData"]["size"]
$streamPath = $streamPathField.AsString
$streamOffset = [Int64]$streamOffsetField.AsLong
$streamSize = [Int64]$streamSizeField.AsLong
$useStream = -not [string]::IsNullOrWhiteSpace($streamPath)
Write-Diag "Stream: path='$streamPath' offset=$streamOffset size=$streamSize"

if ($useStream) {
    # Стандартні формати шляху Unity: "archive:/CAB-XYZ/<name>" або просто
    # ім'я файла. Реальний файл — це <assetsBaseName>.resS у тій самій теці.
    $resSCandidate = $AssetsPath + ".resS"
    if (-not (Test-Path $resSCandidate)) {
        # Витягуємо ім'я з path (після останнього '/').
        $tail = [System.IO.Path]::GetFileName($streamPath.Replace("\","/").TrimEnd("/"))
        $resSCandidate = Join-Path (Split-Path $AssetsPath -Parent) $tail
    }
    if (-not (Test-Path $resSCandidate)) {
        throw "resS streaming file not found near $AssetsPath (tried '$($AssetsPath).resS' and '$resSCandidate')"
    }
    if ($streamSize -ne $encoded.Length) {
        throw "Stream size ($streamSize) != encoded size ($($encoded.Length))"
    }

    # Backup .resS (один раз).
    $resSBak = $resSCandidate + ".bak"
    if (-not (Test-Path $resSBak)) {
        Copy-Item -LiteralPath $resSCandidate -Destination $resSBak -Force
        Write-Diag "Backup .resS -> $resSBak"
    }

    Write-Step "In-place patch $resSCandidate @ $streamOffset ($($encoded.Length) bytes)..."
    $fs = [System.IO.File]::Open($resSCandidate, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $null = $fs.Seek([Int64]$streamOffset, [System.IO.SeekOrigin]::Begin)
        $fs.Write($encoded, 0, $encoded.Length)
    } finally {
        $fs.Dispose()
    }
    Write-Step ("DONE -> resS patched in-place ({0:N0} bytes at offset {1})" -f $encoded.Length, $streamOffset)
    # ConvertTo-Json коректно екранує бекслеші у Windows-шляхах (E:\Foo\Bar →
    # "E:\\Foo\\Bar"); ручний format-string з .Replace("\\","/") ламав JSON, бо
    # в PowerShell-рядку "\\" — це два бекслеші, а у шляху лише один.
    $result = [pscustomobject]@{
        ok = $true
        mode = "resS-inplace"
        resS = $resSCandidate
        offset = $streamOffset
        size = $encoded.Length
    }
    Write-Host ("RESULT_JSON: " + ($result | ConvertTo-Json -Compress))
    exit 0
}

# Inline image data — оновлюємо в Texture2D і перепаковуємо assets.
Write-Step "Inline pixel data — оновлюю Texture2D і перепаковую assets"
$imgDataField = $base["image data"]
if ($null -eq $imgDataField) { throw "image data field missing on Texture2D" }
try {
    $imgDataField.AsByteArray = $encoded
} catch {
    $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::ByteArray, $encoded)
    $imgDataField.Value = $atv
}
$base["m_CompleteImageSize"].AsInt = $encoded.Length
$target.SetNewData($base)

$normSrc = [System.IO.Path]::GetFullPath($AssetsPath)
$normDst = [System.IO.Path]::GetFullPath($OutputPath)
$inPlace = ($normSrc -ieq $normDst)
$writeTarget = if ($inPlace) { $OutputPath + ".tmp" } else { $OutputPath }

Write-Step "Writing $writeTarget ..."
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    $assetsInst.file.Write($writer, 0)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}

if ($inPlace) {
    try { $assetsInst.file.Reader.Close() } catch {}
    try { $manager.UnloadAllAssetsFiles() } catch {}
    try { $manager.UnloadAll() } catch {}
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()

    $bakPath = $AssetsPath + ".bak"
    if (-not (Test-Path $bakPath)) {
        Copy-Item -LiteralPath $AssetsPath -Destination $bakPath -Force
        Write-Diag "Backup -> $bakPath"
    }
    Move-Item -LiteralPath $writeTarget -Destination $OutputPath -Force
}

$outSize = (Get-Item $OutputPath).Length
Write-Step ("DONE -> {0} ({1:N0} bytes)" -f $OutputPath, $outSize)
Write-Host ("RESULT_JSON: {{`"ok`":true,`"mode`":`"inline`",`"output`":`"{0}`",`"size`":{1}}}" -f $OutputPath.Replace("\\","/").Replace("`"","\\`""), $outSize)
exit 0
