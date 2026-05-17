# Hotel Barcelona Text Import — пакує JSON-дампи (Done/) назад у Unity bundle.
# Для кожного MonoBehaviour з мети (Meta/hbr-meta.json) шукає за PathID,
# завантажує відповідний Done/<file>.json, оновлює _Text-поля,
# викликає info.SetNewData, записує bundle у .tmp і свопає на оригінал.
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -DoneDir     : Documents\SWERY-Localization-Tool\HBR\Text\Done\
#   -MetaPath    : Documents\SWERY-Localization-Tool\HBR\Text\Meta\hbr-meta.json
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$DoneDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $DoneDir))    { throw "Done dir not found: $DoneDir" }
if (-not (Test-Path $MetaPath))   { throw "Meta file not found: $MetaPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

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

$metaText = [System.IO.File]::ReadAllText($MetaPath, [System.Text.Encoding]::UTF8)
$meta = $metaText | ConvertFrom-Json
Write-Diag ("Meta items: {0}" -f $meta.items.Count)

Write-Step "Loading bundle..."
$bundleInst = $manager.LoadBundleFile($BundlePath)
$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AFIs: $afiCount"

# Setup MonoBehaviour generator (IL2CPP / Mono).
$dataDir = Split-Path -Parent (Split-Path -Parent $BundlePath)
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    try {
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator ready"
    } catch {
        Write-Warning "Cpp2IL init failed: $($_.Exception.Message)"
    }
}

# Завантажуємо assets-файли з bundle. Зберігаємо інстанси для запису назад.
$afiInstances = @{}
for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    try {
        $inst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx)
        if ($null -ne $inst) {
            $afiInstances[$afiIdx] = $inst
            $null = $manager.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
        }
    } catch {}
}

# Helper: рекурсивно проходимо JSON-структуру і встановлюємо значення у
# AssetTypeValueField. Підтримуємо лише ті типи що нам треба:
# вкладені struct (children) та Array (через "Array" field).
$csCode = @'
using System;
using System.Collections.Generic;
using AssetsTools.NET;

public static class HbrPatcher {
    public static string LastErr = "";
    public static int Patched = 0;
    public static int Skipped = 0;

    public static bool Apply(AssetTypeValueField root, object jsonNode) {
        try {
            Patched = 0;
            Skipped = 0;
            ApplyNode(root, jsonNode);
            return true;
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return false;
        }
    }

    static void ApplyNode(AssetTypeValueField f, object node) {
        if (f == null || node == null) return;
        if (node is System.Management.Automation.PSObject ps) node = ps.BaseObject;
        // PSCustomObject → enumerate props.
        var psType = node.GetType().FullName ?? "";
        if (node is IDictionary<string, object> dict) {
            foreach (var kv in dict) ApplyChild(f, kv.Key, kv.Value);
        } else if (psType.StartsWith("System.Management.Automation.PSCustomObject")) {
            // skip — should have been BaseObject'd
        } else {
            // Try IEnumerable of properties via reflection (PSObject path).
            var t = node.GetType();
            foreach (var p in t.GetProperties()) {
                try {
                    var v = p.GetValue(node);
                    ApplyChild(f, p.Name, v);
                } catch {}
            }
        }
    }

    static void ApplyChild(AssetTypeValueField parent, string name, object value) {
        if (string.IsNullOrEmpty(name)) return;
        AssetTypeValueField child = null;
        try { child = parent[name]; } catch {}
        if (child == null) { Skipped++; return; }
        if (value == null) return;
        if (value is System.Management.Automation.PSObject ps) value = ps.BaseObject;
        // Array — наша JSON-структура містить { "Array": [...] }.
        if (value is object[] arr) {
            // Не повинно тут — Array лежить як object[] всередині дочірнього "Array".
            try {
                var children = child.Children;
                for (int i = 0; i < Math.Min(children.Count, arr.Length); i++) {
                    ApplyNode(children[i], arr[i]);
                }
            } catch {}
            return;
        }
        var vt = value.GetType().FullName ?? "";
        if (vt.StartsWith("System.Management.Automation.PSCustomObject") ||
            vt == "System.Collections.Hashtable" ||
            value is IDictionary<string, object>) {
            ApplyNode(child, value);
            return;
        }
        // Primitive.
        try {
            if (value is string s) {
                child.AsString = s;
                Patched++;
                return;
            }
            if (value is bool b) { child.AsBool = b; Patched++; return; }
            if (value is double d) { child.AsDouble = d; Patched++; return; }
            if (value is long l) { child.AsLong = l; Patched++; return; }
            if (value is int ii) { child.AsInt = ii; Patched++; return; }
            // fallback — try string assignment.
            child.AsString = value.ToString() ?? "";
            Patched++;
        } catch { Skipped++; }
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    'netstandard', 'System.Runtime', 'System.Collections',
    'System.Management.Automation'
)
try { Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { throw "HbrPatcher compile fail: $($_.Exception.Message)" }

$applied = 0
$failed = New-Object System.Collections.ArrayList

foreach ($item in $meta.items) {
    $afiIdx = [int]$item.afiIndex
    $assetPid = [int64]$item.pathId
    $doneFile = Join-Path $DoneDir $item.file
    if (-not (Test-Path $doneFile)) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "Done file missing: $doneFile" })
        Write-Host ("[SKIP] {0}: no Done file" -f $item.name)
        continue
    }
    if (-not $afiInstances.ContainsKey($afiIdx)) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "AFI $afiIdx not loaded" })
        continue
    }
    $assetsInst = $afiInstances[$afiIdx]
    $info = $null
    foreach ($ai in $assetsInst.file.AssetInfos) {
        if ([int64]$ai.PathId -eq $assetPid) { $info = $ai; break }
    }
    if ($null -eq $info) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "PathID $assetPid not found" })
        continue
    }
    try {
        $base = $manager.GetBaseField($assetsInst, $info)
        $raw = [System.IO.File]::ReadAllText($doneFile, [System.Text.Encoding]::UTF8)
        $json = $raw | ConvertFrom-Json
        $ok = [HbrPatcher]::Apply($base, $json)
        if (-not $ok) {
            [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "Patcher: " + [HbrPatcher]::LastErr })
            Write-Host ("[FAIL] {0}: {1}" -f $item.name, [HbrPatcher]::LastErr)
            continue
        }
        $info.SetNewData($base)
        $applied++
        Write-Host ("[PATCHED] {0} (PathID {1}, fields={2})" -f $item.name, $assetPid, [HbrPatcher]::Patched)
    } catch {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = $_.Exception.Message })
        Write-Host ("[FAIL] {0}: {1}" -f $item.name, $_.Exception.Message)
    }
}

# Write bundle back.
Write-Step "Writing bundle..."
$bak = $BundlePath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $BundlePath -Destination $bak -Force
    Write-Diag "Backup → $bak"
}
$writeTarget = $BundlePath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    # Оновлюємо кожен assets-file у bundle-directory.
    foreach ($k in $afiInstances.Keys) {
        $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$k].SetNewData($afiInstances[$k].file)
    }
    $bundleInst.file.Write($writer)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}
foreach ($k in $afiInstances.Keys) {
    try { $afiInstances[$k].file.Reader.Close() } catch {}
}
try { $bundleInst.file.Reader.Close() } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Move-Item -LiteralPath $writeTarget -Destination $BundlePath -Force
$outSize = (Get-Item $BundlePath).Length
Write-Step ("DONE → {0} ({1:N0} bytes), applied {2}, failed {3}" -f $BundlePath, $outSize, $applied, $failed.Count)

$summary = [pscustomobject]@{
    ok = $true; bundle = $BundlePath; size = $outSize
    applied = $applied; failed = $failed.ToArray()
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
