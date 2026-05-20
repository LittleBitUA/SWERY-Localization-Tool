# Hotel Barcelona — Text Export.
# Витягає всі MonoBehaviour-asset'и з Unity-bundle, ім'я m_Name яких містить
# "_EN". Дамп — це повний JSON для кожного MonoBehaviour (як у dp2-text-export
# для DP2). Поверх — додаємо meta-файл з мапою m_Name → PathID + FileID,
# щоб re-pack знав куди писати.
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle (HOTEL BARCELONA\..._resources_assets_all_*.bundle)
#   -OutDir      : куди писати <m_Name>-<bundle>-<pathId>.json
#   -MetaPath    : куди писати hbr-meta.json (mapping для re-pack)
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями
#   -NameFilter  : pattern для m_Name (default "_EN").

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [string]$NameFilter = "_EN"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$metaDir = Split-Path -Parent $MetaPath
if ($metaDir -and -not (Test-Path $metaDir)) { New-Item -ItemType Directory -Path $metaDir -Force | Out-Null }

# Load DLLs (order matters).
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

Write-Step "Loading bundle: $BundlePath"
$bundleInst = $manager.LoadBundleFile($BundlePath)
if ($null -eq $bundleInst) { throw "Failed to load bundle" }

# AssetsFile усередині bundle може бути не один (rarely). Обходимо всі.
$totalExported = 0
$failed = New-Object System.Collections.ArrayList
$exportedList = New-Object System.Collections.ArrayList
$metaList = New-Object System.Collections.ArrayList
$bundleName = [System.IO.Path]::GetFileNameWithoutExtension($BundlePath)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Inline C#: JSON-serializer для MonoBehaviour.
#
# Прив'язано до UABEANext4.Logic.ImportExport.AssetExport.DumpJsonAsset, бо
# наш кастомний walker не вмів виводити блок ManagedReferencesRegistry
# (references: { version, RefIds }), і round-trip Import чекав цей JObject —
# 13 файлів HBR падали з InvalidOperationException на JValue→Item.
# Якщо UABEA-asm недоступний — використовуємо fallback-walker (без refs).
$csCode = @'
using System;
using System.IO;
using System.Text;
using AssetsTools.NET;

public static class HbrJsonExport {
    public static string LastErr = "";

    public static string Serialize(AssetTypeValueField root) {
        // Спершу пробуємо UABEANext через reflection — це гарантує симетрію
        // з ImportJsonAsset (managed-references registry зберігається у JSON).
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
        // Fallback — наш простий walker.
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

$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AssetsFiles inside: $afiCount"

for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    $assetsInst = $null
    try {
        $assetsInst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx)
    } catch {
        Write-Diag ("  AFI[{0}] is not assets-file: {1}" -f $afiIdx, $_.Exception.Message)
        continue
    }
    if ($null -eq $assetsInst) { continue }
    $unityVersion = $assetsInst.file.Metadata.UnityVersion
    $null = $manager.LoadClassDatabaseFromPackage($unityVersion)
    Write-Diag ("  AFI[{0}] Unity {1}, AssetInfos={2}" -f $afiIdx, $unityVersion, @($assetsInst.file.AssetInfos).Count)

    # IL2CPP / Mono detection — потрібно для розгортання MonoBehaviour fields.
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
        } catch {
            Write-Warning "  Cpp2IL ctor failed: $($_.Exception.Message)"
        }
    } elseif ((Test-Path $managedDir) -and $null -eq $manager.MonoTempGenerator) {
        try {
            $monoGen = New-Object AssetsTools.NET.MonoCecil.MonoCecilTempGenerator($managedDir)
            $manager.MonoTempGenerator = $monoGen
            Write-Diag "  Mono generator initialized"
        } catch {
            Write-Warning "  Mono ctor failed: $($_.Exception.Message)"
        }
    }

    foreach ($info in $assetsInst.file.AssetInfos) {
        if ($info.TypeId -ne 114) { continue }
        $assetPid = [int64]$info.PathId
        try {
            $base = $manager.GetBaseField($assetsInst, $info)
            if ($null -eq $base) { continue }
            $name = $null
            try { $name = $base["m_Name"].AsString } catch {}
            if (-not $name) { continue }
            if ($name -notlike "*$NameFilter*") { continue }

            $safe = $name -replace '[\\/:\*\?"<>\|]', '_'
            $outFile = Join-Path $OutDir ("{0}-{1}-{2}.json" -f $safe, $bundleName, $assetPid)
            $jsonStr = [HbrJsonExport]::Serialize($base)
            if ([string]::IsNullOrEmpty($jsonStr)) {
                [void]$failed.Add([pscustomobject]@{ pathId = $assetPid; name = $name; error = "Serialize empty" })
                continue
            }
            [System.IO.File]::WriteAllText($outFile, $jsonStr, $utf8NoBom)
            $totalExported++
            [void]$exportedList.Add([pscustomobject]@{
                pathId = $assetPid; name = $name; file = $outFile
            })
            # Meta: запис для re-pack.
            $scriptClass = $null
            try { $scriptClass = $base["m_Script"]["m_PathID"].AsLong } catch {}
            [void]$metaList.Add([pscustomobject]@{
                name      = $name
                file      = ("{0}-{1}-{2}.json" -f $safe, $bundleName, $assetPid)
                pathId    = $assetPid
                afiIndex  = $afiIdx
                typeId    = [int]$info.TypeId
                bundle    = $bundleName
                scriptPathId = $scriptClass
                unityVersion = $unityVersion
            })
            Write-Host ("[EXPORTED] {0} (PathID {1}) -> {2}" -f $name, $assetPid, $outFile)
        } catch {
            [void]$failed.Add([pscustomobject]@{ pathId = $assetPid; error = $_.Exception.Message })
            Write-Host ("[FAIL] PathID {0}: {1}" -f $assetPid, $_.Exception.Message)
        }
    }
}

# Записуємо meta.json (mapping для re-pack).
$meta = [pscustomobject]@{
    bundle = $BundlePath
    bundleName = $bundleName
    nameFilter = $NameFilter
    items = $metaList.ToArray()
    exportedAt = (Get-Date).ToString("o")
}
$metaJson = ConvertTo-Json -InputObject $meta -Depth 8
[System.IO.File]::WriteAllText($MetaPath, $metaJson, $utf8NoBom)
Write-Diag "Meta written: $MetaPath"

Write-Step ("DONE: exported {0} text MonoBehaviour to {1}" -f $totalExported, $OutDir)
$summary = [pscustomobject]@{
    ok = $true
    outDir = $OutDir
    metaPath = $MetaPath
    exported = $exportedList.ToArray()
    failed = $failed.ToArray()
    total = $totalExported
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
