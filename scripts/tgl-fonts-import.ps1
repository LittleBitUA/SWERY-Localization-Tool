# TGL Fonts Import — записує оновлений Font JSON + PNG атласу назад у Unity
# CAB-файл гри The Good Life. Дзеркальна операція до tgl-fonts-extract.ps1.
#
# Поля що оновлюються:
#   • m_CharacterRects.Array — повний replace зі вмісту JSON (glyph rects);
#   • Texture2D pixel data — кодуємо PNG у поточний TextureFormat атласу.
#
# Решта Font/Texture полів (m_Name, m_Texture refs, m_FontSize, тощо) НЕ
# чіпаємо — pathID/FileID посилання залишаються інтактні.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$CabPath,
    [Parameter(Mandatory=$true)] [string]$FontJsonPath,
    [Parameter(Mandatory=$true)] [string]$AtlasPngPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $CabPath))       { throw "CAB не знайдено: $CabPath" }
if (-not (Test-Path $FontJsonPath))  { throw "Font JSON не знайдено: $FontJsonPath" }
if (-not (Test-Path $AtlasPngPath))  { throw "Atlas PNG не знайдено: $AtlasPngPath" }
if (-not (Test-Path $UabeaDir))      { throw "UABEA dir не знайдено: $UabeaDir" }

# Load DLLs.
$loadList = @(
    "Mono.Cecil.dll", "LibCpp2IL.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll", "AssetsTools.NET.Cpp2IL.dll",
    "AssetRipper.Primitives.dll", "AssetRipper.TextureDecoder.dll",
    "AssetsTools.NET.Texture.dll"
)
foreach ($name in $loadList) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}
$nativeDir = Join-Path $UabeaDir "runtimes/win-x64/native"
if (Test-Path $nativeDir) { $env:PATH = "$nativeDir;$env:PATH" }

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)

Write-Step "Loading $CabPath ..."
$bundleInst = $null
$assetsInst = $null
try {
    $bundleInst = $manager.LoadBundleFile($CabPath)
    Write-Diag "Loaded as Unity Asset Bundle"
    $assetsInst = $manager.LoadAssetsFileFromBundle($bundleInst, 0)
} catch {
    Write-Diag "Bundle load failed, trying raw AssetsFile..."
    $assetsInst = $manager.LoadAssetsFile($CabPath, $true)
}
if ($null -eq $assetsInst) { throw "Не вдалося прочитати файл як bundle або assets-file" }
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

# Read updated font JSON (our editor format = pretty-print AT.NET tree).
Write-Diag "Reading font JSON ..."
$jsonText = [System.IO.File]::ReadAllText($FontJsonPath, [System.Text.Encoding]::UTF8)
$json = $jsonText | ConvertFrom-Json -Depth 100
$fontName = $json.m_Name
$glyphs = $json.m_CharacterRects.Array
if (-not $glyphs -or $glyphs.Count -eq 0) { throw "JSON без m_CharacterRects.Array" }
Write-Diag ("Font: {0}, glyphs: {1}" -f $fontName, $glyphs.Count)

# Find font asset by m_Name.
$fontInfo = $null
foreach ($info in $assetsInst.file.AssetInfos) {
    if ($info.TypeId -ne 128) { continue }
    $b = $manager.GetBaseField($assetsInst, $info)
    $n = $null
    try { $n = $b["m_Name"].AsString } catch {}
    if ($n -eq $fontName) { $fontInfo = $info; break }
}
if ($null -eq $fontInfo) { throw "Font '$fontName' не знайдено у CAB" }
Write-Diag "Found font asset PathID=$($fontInfo.PathId)"

$base = $manager.GetBaseField($assetsInst, $fontInfo)
$arr = $base["m_CharacterRects"]["Array"]
if ($null -eq $arr) { throw "Поле m_CharacterRects.Array відсутнє" }

# Capture template для дочерних елементів (clone-from-first).
if ($arr.Children.Count -eq 0) { throw "Шаблон у m_CharacterRects.Array відсутній — нема з чого клонувати glyph" }
$proto = $arr.Children[0]

# Clear existing entries.
$arr.Children.Clear()

# Inline C#: append a glyph entry by deep-cloning proto і встановлюючи поля.
$csCode = @'
using System;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
public static class FontImport {
    public static string LastErr = "";
    public static bool AppendGlyph(AssetTypeValueField arr, AssetTypeValueField proto,
        int index, float uvX, float uvY, float uvW, float uvH,
        float vX, float vY, float vW, float vH, float advance, bool flipped) {
        try {
            // AssetsTools.NET v3.2+: CreateFromTemplate видалено,
            // використовуємо ValueBuilder.DefaultValueFieldFromTemplate.
            var item = ValueBuilder.DefaultValueFieldFromTemplate(proto.TemplateField);
            item["index"].AsInt = index;
            item["uv"]["x"].AsFloat = uvX;
            item["uv"]["y"].AsFloat = uvY;
            item["uv"]["width"].AsFloat = uvW;
            item["uv"]["height"].AsFloat = uvH;
            item["vert"]["x"].AsFloat = vX;
            item["vert"]["y"].AsFloat = vY;
            item["vert"]["width"].AsFloat = vW;
            item["vert"]["height"].AsFloat = vH;
            item["advance"].AsFloat = advance;
            try { item["flipped"].AsBool = flipped; } catch {}
            arr.Children.Add(item);
            return true;
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return false;
        }
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    'netstandard', 'System.Runtime', 'System.Collections'
)
try { Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { throw "Не вдалося скомпілювати FontImport: $($_.Exception.Message)" }

Write-Step "Rebuilding m_CharacterRects.Array..."
$added = 0
foreach ($g in $glyphs) {
    $ok = [FontImport]::AppendGlyph(
        $arr, $proto,
        [int]$g.index,
        [float]$g.uv.x, [float]$g.uv.y, [float]$g.uv.width, [float]$g.uv.height,
        [float]$g.vert.x, [float]$g.vert.y, [float]$g.vert.width, [float]$g.vert.height,
        [float]$g.advance, [bool]$g.flipped
    )
    if ($ok) { $added++ } else {
        throw "Glyph index=$($g.index) append fail: $([FontImport]::LastErr)"
    }
}
Write-Diag "Glyphs added: $added"

# Texture pair — encode atlas PNG у поточний TextureFormat.
$texPathId = $null
try { $texPathId = [int64]$base["m_Texture"]["m_PathID"].AsLong } catch {}
if ($null -eq $texPathId) { throw "m_Texture.m_PathID не знайдено у font asset" }

$texInfo = $null
foreach ($info in $assetsInst.file.AssetInfos) {
    if ([int64]$info.PathId -eq [int64]$texPathId) { $texInfo = $info; break }
}
if ($null -eq $texInfo) { throw "Texture2D з PathID $texPathId не знайдено у CAB" }
$texBase = $manager.GetBaseField($assetsInst, $texInfo)

Write-Step "Encoding atlas PNG → TextureFormat..."
$csTexCode = @'
using System;
using AssetsTools.NET.Texture;
public static class FontTexImport {
    public static string LastErr = "";
    public static byte[] Encode(string pngPath, int fmt) {
        try {
            int w = 0, h = 0;
            // UABEA Next: нова сигнатура з mipCount + повертає масив рівнів.
            //   ConvertImage(string path, int mipCount, TextureFormat fmt,
            //                out int w, out int h, int quality) -> byte[][]
            byte[][] mips = TextureEncoderWrapper.ConvertImage(pngPath, 1, (TextureFormat)fmt, out w, out h, 100);
            if (mips == null || mips.Length == 0 || mips[0] == null || mips[0].Length == 0) {
                LastErr = "ConvertImage null/empty";
                return null;
            }
            return mips[0]; // mip-level 0 (повний розмір)
        } catch (Exception ex) { LastErr = ex.GetType().Name + ": " + ex.Message; return null; }
    }
}
'@
$texRefs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.Texture.dll"),
    'netstandard', 'System.Runtime'
)
try { Add-Type -TypeDefinition $csTexCode -ReferencedAssemblies $texRefs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { throw "FontTexImport compile fail: $($_.Exception.Message)" }

$texFmt = [int]$texBase["m_TextureFormat"].AsInt
$encoded = [FontTexImport]::Encode($AtlasPngPath, $texFmt)
if ($null -eq $encoded) { throw "Texture encode fail: $([FontTexImport]::LastErr)" }
Write-Diag ("Encoded {0} bytes (fmt={1})" -f $encoded.Length, $texFmt)

# Update Texture2D pixel data + image size.
$texBase["m_CompleteImageSize"].AsInt = $encoded.Length
try {
    $texBase["image data"]["Array"].AsByteArray = $encoded
} catch {
    $texBase["image data"].AsByteArray = $encoded
}
$texInfo.SetNewData($texBase)

# m_StreamData очищаємо (бо ми пишемо inline, не у .resS).
try {
    $texBase["m_StreamData"]["offset"].AsLong = 0
    $texBase["m_StreamData"]["size"].AsLong = 0
    $texBase["m_StreamData"]["path"].AsString = ""
    $texInfo.SetNewData($texBase)
    Write-Diag "m_StreamData cleared"
} catch {}

# Update font asset з оновленим Array.
$fontInfo.SetNewData($base)
Write-Step "Font + Texture updated in memory"

# Write CAB back (з .bak один раз).
$bak = $CabPath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $CabPath -Destination $bak -Force
    Write-Diag "Backup → $bak"
}

$writeTarget = $CabPath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    if ($null -ne $bundleInst) {
        # Bundle-flow: оновлюємо asset file всередині bundle, потім записуємо
        # bundle цілком (з тим самим compressed-форматом, що й оригінал).
        Write-Diag "Writing as Unity Asset Bundle..."
        $bundleInst.file.BlockAndDirInfo.DirectoryInfos[0].SetNewData($assetsInst.file)
        $bundleInst.file.Write($writer)
    } else {
        Write-Diag "Writing as raw AssetsFile..."
        $assetsInst.file.Write($writer, 0)
    }
} finally {
    if ($null -ne $writer) { $writer.Close() }
}
try { $assetsInst.file.Reader.Close() } catch {}
try { if ($null -ne $bundleInst) { $bundleInst.file.Reader.Close() } } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Move-Item -LiteralPath $writeTarget -Destination $CabPath -Force
$outSize = (Get-Item $CabPath).Length
Write-Step ("DONE → {0} ({1:N0} bytes)" -f $CabPath, $outSize)
Write-Host ("RESULT_JSON: {{`"ok`":true,`"output`":`"{0}`",`"size`":{1},`"glyphs`":{2}}}" -f ($CabPath -replace '\\','/'), $outSize, $added)
exit 0
