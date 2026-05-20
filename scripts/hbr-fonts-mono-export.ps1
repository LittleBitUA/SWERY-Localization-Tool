# Hotel Barcelona — Fonts MonoBehaviour Export.
#
# Розпаковує всі MonoBehaviour-ассети, m_Name яких починається з "FOT-" або
# "FOT_" — це
# серіалізовані TMP_FontAsset (м_GlyphTable, m_CharacterTable, m_FaceInfo,
# m_AtlasTextures, m_KerningTable тощо). Дамп — UABEA-сумісний JSON через
# UABEANext4.Logic.ImportExport.AssetExport.DumpJsonAsset (reflection),
# fallback — власний walker.
#
# HBR — IL2CPP, тож для розгортання MonoBehaviour-полів треба
# Cpp2IlTempGenerator(global-metadata.dat, GameAssembly.dll).
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -OutDir      : куди писати <m_Name>-<assetsFileNameInBundle>-<pathId>.json
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
    "Mono.Cecil.dll", "LibCpp2IL.dll",
    "Newtonsoft.Json.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll", "AssetsTools.NET.Cpp2IL.dll",
    "UABEANext4.dll"
)
foreach ($name in $loadList) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)
$manager.UseRefTypeManagerCache = $true
$manager.UseTemplateFieldCache = $true
$manager.UseMonoTemplateFieldCache = $true

Write-Step "Loading bundle: $BundlePath"
$bundleInst = $manager.LoadBundleFile($BundlePath)
if ($null -eq $bundleInst) { throw "Failed to load bundle" }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Inline C# JSON-dumper — той самий Walker, що в hbr-text-export.ps1. Не
# використовуємо UABEA Next AssetExport.DumpJsonAsset: для TMP_FontAsset воно
# обрізає MonoBehaviour Base wrapper (m_GameObject/m_Enabled/m_Script/m_Name),
# а ImportJsonAsset потім падає з "Missing field m_GameObject". Наш Walker
# проходить ВСІ children від root → гарантовано повна обгортка.
$csCode = @'
using System;
using System.IO;
using System.Text;
using System.Globalization;
using AssetsTools.NET;

public static class HbrFontJsonExport {
    public static string LastErr = "";

    public static string Serialize(AssetTypeValueField root) {
        try {
            var sb = new StringBuilder(1 << 18);
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
            case "bool": try { sb.Append(f.AsBool ? "true" : "false"); return; } catch { } break;
            case "float": case "double":
                try { sb.Append(f.AsDouble.ToString(CultureInfo.InvariantCulture)); return; } catch { } break;
            case "string":
                try { EscapeJson(f.AsString ?? "", sb); return; } catch { } break;
            case "SInt8": case "UInt8": case "SInt16": case "UInt16":
            case "int": case "unsigned int": case "SInt32": case "UInt32":
            case "SInt64": case "UInt64": case "long long": case "unsigned long long":
            case "long": case "unsigned long":
                try { sb.Append(f.AsLong.ToString(CultureInfo.InvariantCulture)); return; } catch { }
                try { sb.Append(f.AsInt.ToString(CultureInfo.InvariantCulture)); return; } catch { } break;
        }
        try { EscapeJson(f.AsString ?? "", sb); return; } catch { }
        try { sb.Append(f.AsLong.ToString(CultureInfo.InvariantCulture)); return; } catch { }
        sb.Append("null");
    }
    static void Walk(AssetTypeValueField f, StringBuilder sb, int depth) {
        if (f == null) { sb.Append("null"); return; }
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
        Indent(sb, depth); sb.Append('}');
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    'netstandard', 'System.Runtime', 'System.IO', 'System.Collections'
)
Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop

$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AssetsFiles inside: $afiCount"

$exported = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
$scannedMono = 0

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
    $unityVersion = $assetsInst.file.Metadata.UnityVersion
    $null = $manager.LoadClassDatabaseFromPackage($unityVersion)

    # IL2CPP / Mono detection.
    $dataDir = Split-Path -Parent (Split-Path -Parent $BundlePath)
    $managedDir = Join-Path $dataDir "Managed"
    $il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
    $gameRoot = Split-Path -Parent $dataDir
    $gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
    if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly) -and $null -eq $manager.MonoTempGenerator) {
        try {
            $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
            $manager.MonoTempGenerator = $cppGen
            Write-Diag "  IL2CPP generator initialized"
        } catch { Write-Warning "  Cpp2IL ctor failed: $($_.Exception.Message)" }
    } elseif ((Test-Path $managedDir) -and $null -eq $manager.MonoTempGenerator) {
        try {
            $monoGen = New-Object AssetsTools.NET.MonoCecil.MonoCecilTempGenerator($managedDir)
            $manager.MonoTempGenerator = $monoGen
            Write-Diag "  Mono generator initialized"
        } catch { Write-Warning "  Mono ctor failed: $($_.Exception.Message)" }
    }

    foreach ($info in $assetsInst.file.AssetInfos) {
        if ($info.TypeId -ne 114) { continue }  # MonoBehaviour
        $scannedMono++
        $pathId = [int64]$info.PathId
        try {
            $base = $manager.GetBaseField($assetsInst, $info)
            if ($null -eq $base) { continue }
            $name = $null
            try { $name = $base["m_Name"].AsString } catch {}
            if (-not $name) { continue }
            # Префікс TMP_FontAsset у HBR — або FOT-<...>, або FOT_<...> (зустрі-
            # чаються обидва, напр. FOT-ComicMysteryStd-DB та FOT_NEWCINEMAA-D).
            # -match case-insensitive за замовчуванням. ^FOT[-_] покриває обидва.
            if ($name -notmatch '^FOT[-_]') { continue }

            $jsonStr = [HbrFontJsonExport]::Serialize($base)
            if ([string]::IsNullOrEmpty($jsonStr)) {
                [void]$failed.Add([pscustomobject]@{ pathId = $pathId; name = $name; error = "serialize empty" })
                continue
            }
            $safe = $name -replace '[\\/:\*\?"<>\|]', '_'
            $outFile = Join-Path $OutDir ("{0}-{1}-{2}.json" -f $safe, $assetsFileName, $pathId)
            [System.IO.File]::WriteAllText($outFile, $jsonStr, $utf8NoBom)
            Write-Host ("[EXPORTED] {0} (PathID {1}) -> {2} ({3:N0} bytes)" -f $name, $pathId, $outFile, $jsonStr.Length)
            [void]$exported.Add([pscustomobject]@{
                pathId = $pathId; name = $name; file = $outFile; assetsFile = $assetsFileName
            })
        } catch {
            [void]$failed.Add([pscustomobject]@{ pathId = $pathId; error = $_.Exception.Message })
            Write-Warning ("PathID {0}: {1}" -f $pathId, $_.Exception.Message)
        }
    }
}

Write-Step ("DONE: exported {0} FOT-/FOT_ MonoBehaviour to {1} (scanned {2} MB total, {3} failed)" -f $exported.Count, $OutDir, $scannedMono, $failed.Count)
$summary = [pscustomobject]@{
    ok = $true; outDir = $OutDir; bundle = $BundlePath
    exported = $exported.ToArray(); failed = $failed.ToArray()
    total = $exported.Count; scannedMono = $scannedMono
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
exit 0
