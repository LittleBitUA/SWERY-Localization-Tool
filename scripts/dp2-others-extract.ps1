# DP2 Others Extract — витягає UILabel MonoBehaviour-asset'и з sharedassets1.assets
# як JSON-дампи. Дзеркальна логіка до dp2-text-export.ps1, лише з префіксом
# імені файлу "UILabel-<assetBaseName>-<pathId>.json" (бо у UILabel-ів m_Name
# зазвичай порожній, а ми хочемо однозначну назву для імпорту назад).
#
# Параметри:
#   -AssetsPath    : повний шлях до sharedassets1.assets
#   -OutDir        : куди писати JSON-дампи (зазвичай <toolsDir>/DP2/Others/Original)
#   -UabeaDir      : тека з AssetsTools.NET DLL'ями
#   -PathIds       : кома-розділений список PathID для експорту (обов'язково)
#
# Емітить:
#   [STEP] / [DIAG] діагностику + per-file прогрес "[EXPORTED] <name> ..." щоб
#   frontend міг показувати кількість оброблених файлів у real-time.
#   RESULT_JSON: {ok, outDir, exported: [...], failed: [...], total} у кінці.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$PathIds
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw ".assets not found: $AssetsPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# Парсимо список PathID-ів. Порожній не допускаємо — це Others, ми завжди знаємо PathID.
$wantedIds = New-Object System.Collections.Generic.HashSet[int64]
foreach ($p in $PathIds.Split(",")) {
    $trimmed = $p.Trim()
    if ($trimmed) {
        $val = [int64]0
        if ([int64]::TryParse($trimmed, [ref]$val)) { [void]$wantedIds.Add($val) }
    }
}
if ($wantedIds.Count -eq 0) { throw "PathIds list is empty after parsing: '$PathIds'" }
Write-Diag ("Wanted PathIDs: {0}" -f $wantedIds.Count)

# Load DLLs (порядок важливий — Cecil/Cpp2IL потребують base assemblies спочатку).
$loadList = @(
    "Mono.Cecil.dll", "LibCpp2IL.dll",
    "AssetsTools.NET.dll",
    "AssetsTools.NET.MonoCecil.dll", "AssetsTools.NET.Cpp2IL.dll"
)
foreach ($name in $loadList) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)

Write-Step "Loading $AssetsPath ..."
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
if ($null -eq $assetsInst) { throw "Failed to load assets file" }
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)
Write-Diag "Unity version: $($assetsInst.file.Metadata.UnityVersion)"

# MonoBehaviour template generator (Cpp2IL для DP2 IL2CPP, Mono для fallback).
$dataDir = Split-Path -Parent $AssetsPath
$managedDir = Join-Path $dataDir "Managed"
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
$genReady = $false

if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    Write-Diag "Detected IL2CPP runtime"
    try {
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator initialized."
        $genReady = $true
    } catch {
        $inner = $_.Exception
        $depth = 0
        while ($null -ne $inner -and $depth -lt 5) {
            Write-Warning ("Cpp2IL ctor failed [{0}]: {1} ({2})" -f $depth, $inner.Message, $inner.GetType().FullName)
            $inner = $inner.InnerException
            $depth++
        }
    }
}

if (-not $genReady -and (Test-Path $managedDir)) {
    try {
        $monoGen = New-Object AssetsTools.NET.MonoCecil.MonoCecilTempGenerator($managedDir)
        $manager.MonoTempGenerator = $monoGen
        Write-Diag "MonoCecilTempGenerator initialized: $managedDir"
        $genReady = $true
    } catch {
        Write-Warning "Failed to init MonoCecilTempGenerator: $($_.Exception.Message)"
    }
}

if (-not $genReady) {
    Write-Warning "No MonoBehaviour template generator available — UILabel fields won't be readable."
}

# Inline C#: рекурсивний JSON-серіалізатор AssetTypeValueField. Той самий
# підхід, що у dp2-text-export.ps1.
$csCode = @'
using System;
using System.IO;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;

public static class OthersJsonExport {
    public static string LastErr = "";
    public static string Serialize(AssetTypeValueField root) {
        try {
            var sb = new StringBuilder(1 << 16);
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
        try { EscapeJson(f.AsString ?? "", sb); return; } catch { }
        try { sb.Append(f.AsLong.ToString(System.Globalization.CultureInfo.InvariantCulture)); return; } catch { }
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
        Indent(sb, depth);
        sb.Append('}');
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    'netstandard', 'System.Runtime', 'System.IO', 'System.Collections'
)
Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop

# Префікс імені файлу — захардкоджений "UILabel", бо у UILabel-ів m_Name
# зазвичай порожній. assetBaseName = "sharedassets1.assets" (повна назва з ext).
$assetBaseName = [System.IO.Path]::GetFileName($AssetsPath)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$exported = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
$total = 0

# Будуємо швидкий мап PathID -> AssetFileInfo, щоб обробити саме потрібні
# (а не пробігати всі AssetInfos).
# NOTE: PowerShell reserves $pid (process ID) — use $assetPid.
$infoByPid = @{}
foreach ($info in $assetsInst.file.AssetInfos) {
    $assetPid = [int64]$info.PathId
    $infoByPid[$assetPid] = $info
}

foreach ($wanted in $wantedIds) {
    $total++
    $info = $null
    if ($infoByPid.ContainsKey([int64]$wanted)) { $info = $infoByPid[[int64]$wanted] }
    if ($null -eq $info) {
        [void]$failed.Add([pscustomobject]@{ pathId = $wanted; error = "PathID not found in assets" })
        Write-Host ("[FAIL] PathID {0}: not in assets" -f $wanted)
        continue
    }
    try {
        $base = $manager.GetBaseField($assetsInst, $info)
        if ($null -eq $base) {
            [void]$failed.Add([pscustomobject]@{ pathId = $wanted; error = "GetBaseField returned null" })
            Write-Host ("[FAIL] PathID {0}: no base field" -f $wanted)
            continue
        }
        $outFile = Join-Path $OutDir ("UILabel-{0}-{1}.json" -f $assetBaseName, $wanted)
        $jsonStr = [OthersJsonExport]::Serialize($base)
        if ([string]::IsNullOrEmpty($jsonStr)) {
            [void]$failed.Add([pscustomobject]@{ pathId = $wanted; error = "Serialize empty: " + [OthersJsonExport]::LastErr })
            Write-Host ("[FAIL] PathID {0}: serialize empty" -f $wanted)
            continue
        }
        [System.IO.File]::WriteAllText($outFile, $jsonStr, $utf8NoBom)
        [void]$exported.Add([pscustomobject]@{
            pathId = $wanted
            file = $outFile
            size = $jsonStr.Length
        })
        Write-Host ("[EXPORTED] UILabel (PathID {0}) -> {1} ({2:N0} bytes)" -f $wanted, $outFile, $jsonStr.Length)
    } catch {
        [void]$failed.Add([pscustomobject]@{ pathId = $wanted; error = $_.Exception.Message })
        Write-Host ("[FAIL] PathID {0}: {1}" -f $wanted, $_.Exception.Message)
    }
}

Write-Step ("DONE: exported {0}/{1} UILabel assets to {2}" -f $exported.Count, $total, $OutDir)
$summary = [pscustomobject]@{
    ok = $true
    outDir = $OutDir
    exported = $exported.ToArray()
    failed = $failed.ToArray()
    total = $total
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
