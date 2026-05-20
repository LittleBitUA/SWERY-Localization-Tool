# TGL Mono Export — витягає MonoBehaviour-asset'и з Unity-bundle TGL у
# вигляді JSON-дампів (як HBR). Підтримує фільтр за m_Name (необов'язково).
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -OutDir      : куди писати <m_Name>-<bundleBaseName>-<pathId>.json
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями
#   -NameFilter  : optional pattern для m_Name (substring match). Пусто = всі.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [string]$NameFilter = ""
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
$bundleName = [System.IO.Path]::GetFileNameWithoutExtension($BundlePath)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Inline C# JSON-dumper: спершу пробуємо UABEA Next AssetExport.DumpJsonAsset
# через reflection (правильний managed-refs serialization), інакше fallback.
$csCode = @'
using System;
using System.IO;
using System.Text;
using System.Globalization;
using AssetsTools.NET;

public static class TglJsonExport {
    public static string LastErr = "";

    public static string Serialize(AssetTypeValueField root) {
        try {
            var uabeaAsm = System.Reflection.Assembly.Load("UABEANext4");
            var exporterType = uabeaAsm.GetType("UABEANext4.Logic.ImportExport.AssetExport");
            if (exporterType != null) {
                using (var ms = new MemoryStream()) {
                    var ctor = exporterType.GetConstructor(new Type[] { typeof(Stream) });
                    var exporter = ctor.Invoke(new object[] { ms });
                    var dumpMethod = exporterType.GetMethod("DumpJsonAsset", new Type[] { typeof(AssetTypeValueField) });
                    dumpMethod.Invoke(exporter, new object[] { root });
                    return Encoding.UTF8.GetString(ms.ToArray());
                }
            }
        } catch (Exception ex) {
            LastErr = "UABEA export failed, falling back: " + ex.Message;
        }
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
                    Indent(sb, depth + 1); Walk(kids[i], sb, depth + 1);
                    if (i < kids.Count - 1) sb.Append(',');
                    sb.Append('\n');
                }
                Indent(sb, depth);
            }
            sb.Append(']'); return;
        }
        var children = f.Children;
        if (children == null || children.Count == 0) { EmitPrimitive(f, sb); return; }
        sb.Append('{'); sb.Append('\n');
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
Write-Diag "Bundle AFIs: $afiCount; filter='$NameFilter'"

$totalExported = 0
$exported = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
$allNames = New-Object System.Collections.ArrayList

for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    $assetsInst = $null
    try { $assetsInst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx) } catch { continue }
    if ($null -eq $assetsInst) { continue }
    $null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

    # IL2CPP detection (TGL is IL2CPP).
    $dataDir = Split-Path -Parent (Split-Path -Parent $BundlePath)
    $il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
    $gameRoot = Split-Path -Parent $dataDir
    $gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
    if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly) -and $null -eq $manager.MonoTempGenerator) {
        try {
            $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
            $manager.MonoTempGenerator = $cppGen
            Write-Diag "  IL2CPP generator initialized"
        } catch { Write-Warning "  Cpp2IL ctor failed: $($_.Exception.Message)" }
    }

    # Pre-build map: MonoScript PathID → m_ClassName. Дозволяє фільтрувати
    # MonoBehaviour за class-name (наприклад "BufferedText"), бо у самих
    # MonoBehaviour `m_Name` зазвичай порожній.
    $scriptMap = @{}
    foreach ($scriptInfo in $assetsInst.file.AssetInfos) {
        if ($scriptInfo.TypeId -ne 115) { continue }  # MonoScript
        try {
            $sb = $manager.GetBaseField($assetsInst, $scriptInfo)
            $cn = $sb["m_ClassName"].AsString
            if ($cn) { $scriptMap[[int64]$scriptInfo.PathId] = $cn }
        } catch {}
    }
    Write-Diag ("  MonoScript map: {0} classes" -f $scriptMap.Count)

    foreach ($info in $assetsInst.file.AssetInfos) {
        if ($info.TypeId -ne 114) { continue }   # MonoBehaviour
        $assetPid = [int64]$info.PathId
        try {
            $base = $manager.GetBaseField($assetsInst, $info)
            if ($null -eq $base) { continue }
            $name = $null
            try { $name = $base["m_Name"].AsString } catch {}
            # Resolve class-name через m_Script.m_PathID → MonoScript.
            $className = $null
            try {
                $spid = [int64]$base["m_Script"]["m_PathID"].AsLong
                if ($scriptMap.ContainsKey($spid)) { $className = $scriptMap[$spid] }
            } catch {}
            $displayName = if ($name) { $name } elseif ($className) { $className } else { "_unnamed" }
            $cnLabel = if ($className) { $className } else { "?" }
            [void]$allNames.Add(("{0} ({1}) :: {2}" -f $displayName, $cnLabel, $assetPid))

            # Серіалізуємо у JSON.
            $jsonStr = [TglJsonExport]::Serialize($base)
            if ([string]::IsNullOrEmpty($jsonStr)) {
                [void]$failed.Add([pscustomobject]@{ pathId = $assetPid; name = $displayName; error = "serialize empty" })
                continue
            }
            # Filter:
            #  - порожній → всі.
            #  - тільки цифри → match за PathID.
            #  - інакше → substring у m_Name АБО class-name АБО у JSON-дампі.
            if ($NameFilter) {
                if ($NameFilter -match '^-?\d+$') {
                    if ([int64]$NameFilter -ne $assetPid) { continue }
                } else {
                    $nm = ($name -and ($name -like "*$NameFilter*"))
                    $cm = ($className -and ($className -like "*$NameFilter*"))
                    $jm = ($jsonStr -like "*$NameFilter*")
                    if (-not ($nm -or $cm -or $jm)) { continue }
                }
            }

            $safe = $displayName -replace '[\\/:\*\?"<>\|]', '_'
            $outFile = Join-Path $OutDir ("{0}-{1}-{2}.json" -f $safe, $bundleName, $assetPid)
            [System.IO.File]::WriteAllText($outFile, $jsonStr, $utf8NoBom)
            $totalExported++
            [void]$exported.Add([pscustomobject]@{ pathId = $assetPid; name = $name; file = $outFile })
            Write-Host ("[EXPORTED] {0} (PathID {1}) -> {2}" -f $name, $assetPid, $outFile)
        } catch {
            [void]$failed.Add([pscustomobject]@{ pathId = $assetPid; error = $_.Exception.Message })
            Write-Host ("[FAIL] PathID {0}: {1}" -f $assetPid, $_.Exception.Message)
        }
    }
}

Write-Step ("DONE: exported {0} MonoBehaviour to {1}" -f $totalExported, $OutDir)
# Унікальні m_Name, відсортовані — корисно показати у UI якщо фільтр не
# знайшов жодного асету (користувач побачить що насправді є в bundle).
$uniqueNames = $allNames | Sort-Object -Unique
$summary = [pscustomobject]@{
    ok = $true; outDir = $OutDir; bundle = $BundlePath
    exported = $exported.ToArray(); failed = $failed.ToArray(); total = $totalExported
    availableNames = @($uniqueNames)
    scannedMonoCount = $allNames.Count
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
