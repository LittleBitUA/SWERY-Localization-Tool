# TGL Fonts Extract — витягує Font asset + Texture2D з CAB-файлу гри The
# Good Life у вигляді JSON + PNG, готових до редагування у нашому редакторі.
#
# Шлях у грі (приклад):
#   StreamingAssets\c0718fc478f6943d\CAB-83791d225c8f42b2781983c4943eb597
#
# Цей файл — звичайний Unity AssetsFile (Sub-Bundle CAB-блок). Містить
# Font (TypeId=128) і Texture2D (TypeId=28), пов'язані через m_Texture.PathID.
#
# Параметри:
#   -CabPath    : повний шлях до CAB-файла гри
#   -OutDir     : куди писати <FontName>.json + Font Texture-…-<absPathId>.png
#   -UabeaDir   : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$CabPath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    # Експортуємо лише Font asset, m_Name якого містить цей фільтр.
    # За замовч. — "ChiaroStd" (latin+cyrillic для UA-локалізації TGL); CJK-шрифти
    # NotoSansSC/TC пропускаються бо їх не редагують для української.
    [string]$FontNameFilter = "ChiaroStd"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $CabPath)) { throw "CAB не знайдено: $CabPath" }
if (-not (Test-Path $UabeaDir)) { throw "UABEA dir не знайдено: $UabeaDir" }
if (-not (Test-Path $OutDir))   { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# Load DLLs (порядок важливий).
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

# Native libs для текстур (Decode).
$nativeDir = Join-Path $UabeaDir "runtimes/win-x64/native"
if (Test-Path $nativeDir) { $env:PATH = "$nativeDir;$env:PATH" }

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)

Write-Step "Loading $CabPath ..."
# TGL зберігає шрифти у Unity Asset Bundle (файл `c0718fc...` 17MB), всередині
# якого лежить CAB-entry з Font/Texture assets. Спочатку пробуємо LoadBundleFile,
# при помилці фолбекаємо на raw LoadAssetsFile.
$bundleInst = $null
$assetsInst = $null
try {
    $bundleInst = $manager.LoadBundleFile($CabPath)
    Write-Diag "Loaded as Unity Asset Bundle"
    $assetsInst = $manager.LoadAssetsFileFromBundle($bundleInst, 0)
} catch {
    Write-Diag "Bundle load failed ($($_.Exception.Message)), trying raw AssetsFile..."
    $assetsInst = $manager.LoadAssetsFile($CabPath, $true)
}
if ($null -eq $assetsInst) { throw "Не вдалося прочитати файл як bundle або assets-file" }
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)
Write-Diag "Unity version: $($assetsInst.file.Metadata.UnityVersion)"

# Збираємо Font asset(s) і Texture2D.
$fonts = New-Object System.Collections.ArrayList
$textures = @{}
foreach ($info in $assetsInst.file.AssetInfos) {
    if ($info.TypeId -eq 128) { [void]$fonts.Add($info) }
    elseif ($info.TypeId -eq 28) { $textures[[int64]$info.PathId] = $info }
}
Write-Diag ("Found: fonts={0}, textures={1}" -f $fonts.Count, $textures.Count)

# Дамп імен усіх шрифтів — щоб бачити що там у bundle (для діагностики фільтра).
$allNames = New-Object System.Collections.ArrayList
foreach ($info in $fonts) {
    $b = $manager.GetBaseField($assetsInst, $info)
    $nm = $null
    try { $nm = $b["m_Name"].AsString } catch {}
    if (-not $nm) { $nm = "Font_$($info.PathId)" }
    [void]$allNames.Add($nm)
    Write-Diag ("  Font: '{0}' (PathID {1})" -f $nm, $info.PathId)
}

# Якщо фільтр виключає ВСЕ — попередимо і знімемо фільтр.
if ($FontNameFilter) {
    $matched = $allNames | Where-Object { $_ -like "*$FontNameFilter*" }
    if ($null -eq $matched -or @($matched).Count -eq 0) {
        Write-Diag "WARN: фільтр '$FontNameFilter' не співпав з жодним зі шрифтів — експортую ВСІ"
        $FontNameFilter = ""
    }
}

# Inline C# для PNG-експорту (як у textures-export.ps1).
$csCode = @'
using System;
using System.IO;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;

public static class TexExp {
    public static string LastErr = "";
    public static byte[] DecodePng(AssetsFileInstance afi, AssetTypeValueField baseField) {
        try {
            TextureFile tex = TextureFile.ReadTextureFile(baseField);
            byte[] raw = tex.FillPictureData(afi);
            if (raw == null || raw.Length == 0) { LastErr = "FillPictureData empty"; return null; }
            using (var ms = new MemoryStream()) {
                bool ok = tex.DecodeTextureImage(raw, ms, ImageExportType.Png, 100);
                if (!ok) { LastErr = "DecodeTextureImage=false"; return null; }
                return ms.ToArray();
            }
        } catch (Exception ex) { LastErr = ex.GetType().Name + ": " + ex.Message; return null; }
    }
}

public static class FontJsonExport {
    public static string LastErr = "";
    public static string Serialize(AssetTypeValueField root) {
        try {
            var sb = new StringBuilder(1 << 20);
            Walk(root, sb, 0);
            return sb.ToString();
        } catch (Exception ex) { LastErr = ex.GetType().Name + ": " + ex.Message; return null; }
    }
    static void Indent(StringBuilder sb, int n) { for (int i = 0; i < n; i++) sb.Append("  "); }
    static void EscapeJson(string s, StringBuilder sb) {
        sb.Append('"');
        for (int i = 0; i < s.Length; i++) {
            char c = s[i];
            switch (c) {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
    static bool IsArray(AssetTypeValueField f) {
        try { return f.TemplateField != null && f.TemplateField.IsArray; } catch { return false; }
    }
    static string TypeName(AssetTypeValueField f) {
        try { return f.TemplateField != null ? f.TemplateField.Type : ""; } catch { return ""; }
    }
    static void EmitPrimitive(AssetTypeValueField f, StringBuilder sb) {
        var t = TypeName(f);
        switch (t) {
            case "bool":   try { sb.Append(f.AsBool ? "true" : "false"); return; } catch { } break;
            case "float":
            case "double":
                try { sb.Append(f.AsDouble.ToString(System.Globalization.CultureInfo.InvariantCulture)); return; } catch { } break;
            case "string":
                try { EscapeJson(f.AsString ?? "", sb); return; } catch { } break;
            case "SInt8": case "UInt8": case "SInt16": case "UInt16":
            case "int": case "unsigned int": case "SInt32": case "UInt32":
            case "SInt64": case "UInt64": case "long long": case "unsigned long long":
            case "long": case "unsigned long":
                try { sb.Append(f.AsLong.ToString(System.Globalization.CultureInfo.InvariantCulture)); return; } catch { }
                try { sb.Append(f.AsInt.ToString(System.Globalization.CultureInfo.InvariantCulture)); return; } catch { } break;
        }
        // Fallback: try string then long.
        try { EscapeJson(f.AsString ?? "", sb); return; } catch { }
        try { sb.Append(f.AsLong.ToString(System.Globalization.CultureInfo.InvariantCulture)); return; } catch { }
        sb.Append("null");
    }
    static void Walk(AssetTypeValueField f, StringBuilder sb, int depth) {
        if (f == null) { sb.Append("null"); return; }
        // ARRAY: f IS the array → its Children are items.
        // Unity dumps vector<T> as struct with one child named "Array" that
        // carries IsArray=true. We emit the inner array as {"Array": [...]}
        // when we're inside that struct; the recursive call below handles it.
        if (IsArray(f)) {
            sb.Append('[');
            var kids = f.Children;
            if (kids != null && kids.Count > 0) {
                sb.Append('\n');
                for (int i = 0; i < kids.Count; i++) {
                    Indent(sb, depth + 1);
                    Walk(kids[i], sb, depth + 1);
                    if (i < kids.Count - 1) sb.Append(',');
                    sb.Append('\n');
                }
                Indent(sb, depth);
            }
            sb.Append(']');
            return;
        }
        var children = f.Children;
        if (children == null || children.Count == 0) {
            EmitPrimitive(f, sb);
            return;
        }
        sb.Append('{');
        sb.Append('\n');
        for (int i = 0; i < children.Count; i++) {
            var c = children[i];
            Indent(sb, depth + 1);
            EscapeJson(c.FieldName ?? "", sb);
            sb.Append(": ");
            Walk(c, sb, depth + 1);
            if (i < children.Count - 1) sb.Append(',');
            sb.Append('\n');
        }
        Indent(sb, depth);
        sb.Append('}');
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    (Join-Path $UabeaDir "AssetsTools.NET.Texture.dll"),
    'netstandard', 'System.Runtime', 'System.IO', 'System.Collections'
)
Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop

$exported = @()
foreach ($fontInfo in $fonts) {
    $base = $manager.GetBaseField($assetsInst, $fontInfo)
    if ($null -eq $base) { continue }
    $name = $base["m_Name"].AsString
    if (-not $name) { $name = "Font_$($fontInfo.PathId)" }

    # Фільтр за назвою (ChiaroStd за замовч.). CJK-шрифти NotoSansSC/TC не
    # потрібні для української — пропускаємо.
    if ($FontNameFilter -and ($name -notlike "*$FontNameFilter*")) {
        Write-Diag "  Skip $name (filter: '$FontNameFilter')"
        continue
    }

    $safeName = $name -replace '[\\/:\*\?"<>\|]', '_'
    Write-Step "Exporting font: $name (PathID $($fontInfo.PathId))"

    $jsonOut = Join-Path $OutDir ("{0}-CAB--{1}.json" -f $safeName, ([math]::Abs([int64]$fontInfo.PathId)))
    try {
        $jsonStr = [FontJsonExport]::Serialize($base)
        if ([string]::IsNullOrEmpty($jsonStr)) {
            throw "Serialize повернув порожньо: $([FontJsonExport]::LastErr)"
        }
        # UTF-8 БЕЗ BOM: дефолтний `[System.Text.Encoding]::UTF8` у .NET включає
        # BOM, через що Node JSON.parse падав на першому символі (﻿).
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($jsonOut, $jsonStr, $utf8NoBom)
        Write-Diag "  JSON → $jsonOut ($($jsonStr.Length) bytes)"
    } catch {
        Write-Diag ("  JSON export failed: {0}" -f $_.Exception.Message)
        continue
    }

    # Шукаємо texture pair через m_Texture.m_PathID.
    $texPathId = $null
    try { $texPathId = [int64]$base["m_Texture"]["m_PathID"].AsLong } catch {}
    if ($null -ne $texPathId -and $textures.ContainsKey($texPathId)) {
        $texInfo = $textures[$texPathId]
        $texBase = $manager.GetBaseField($assetsInst, $texInfo)
        $texName = ""
        try { $texName = $texBase["m_Name"].AsString } catch {}
        if (-not $texName) { $texName = "FontTexture" }
        $safeTex = $texName -replace '[\\/:\*\?"<>\|]', '_'
        $pngOut = Join-Path $OutDir ("{0}-CAB--{1}.png" -f $safeTex, ([math]::Abs($texPathId)))
        $png = [TexExp]::DecodePng($assetsInst, $texBase)
        if ($null -eq $png) {
            Write-Diag ("  Texture decode failed: {0}" -f [TexExp]::LastErr)
        } else {
            [System.IO.File]::WriteAllBytes($pngOut, $png)
            Write-Diag "  PNG → $pngOut"
        }
        $exported += [pscustomobject]@{ name = $name; pathId = $fontInfo.PathId; texPathId = $texPathId; json = $jsonOut; png = $pngOut }
    } else {
        Write-Diag "  WARN: texture pair not found in this CAB"
        $exported += [pscustomobject]@{ name = $name; pathId = $fontInfo.PathId; texPathId = $null; json = $jsonOut; png = $null }
    }
}

Write-Step ("DONE: exported {0} font(s) → {1}" -f $exported.Count, $OutDir)
# Примусова обгортка у масив: PowerShell ConvertTo-Json для 1 елемента вертає
# `{...}` замість `[{...}]`, тоді JS-парсер на frontend бачить object, не array.
$json = ConvertTo-Json -InputObject @($exported) -Depth 5 -Compress
if (-not $json) { $json = "[]" }
Write-Host "RESULT_JSON: $json"
exit 0
