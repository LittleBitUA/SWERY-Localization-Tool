# TGL Mono Import — патчить ОДИН MonoBehaviour-asset усередині bundle через
# JSON-дамп. Якщо PathId зазначено — патчиться за ним; інакше вгадуємо з
# імені файла `<m_Name>-<bundleName>-<pathId>.json`.
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -JsonPath    : JSON-дамп (raw form, як від AssetExport.DumpJsonAsset)
#   -PathId      : optional int64; якщо нема — береться з імені файла
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$JsonPath,
    [string]$PathId = "",
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $JsonPath))   { throw "JSON not found: $JsonPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

# Якщо PathId не зазначено — витягуємо з імені файла (формат
# `<m_Name>-<bundleName>-<pathId>.json`). Парсимо REGEX'ом з кінця:
# split-on-dash ламається коли PathID від'ємний — `--5460…` дає
# порожній елемент між дефісами і знак мінус губиться.
$assetPid = [int64]0
if ($PathId) { $assetPid = [int64]$PathId }
else {
    $fname = [System.IO.Path]::GetFileNameWithoutExtension($JsonPath)
    if (-not ($fname -match '(-?\d+)$')) { throw ("Can't infer PathId from filename: " + $fname) }
    $assetPid = [int64]$matches[1]
}
Write-Diag "Target PathID: $assetPid"

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
$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AFIs: $afiCount"

# IL2CPP / Cpp2Il.
$dataDir = Split-Path -Parent (Split-Path -Parent $BundlePath)
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    try {
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator ready"
    } catch { Write-Warning "Cpp2IL init failed: $($_.Exception.Message)" }
}

# Завантажуємо всі assets-файли і шукаємо asset з PathId.
$assetsInst = $null
$assetInfo = $null
$assetAfiIdx = -1
for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    try {
        $inst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx)
        if ($null -eq $inst) { continue }
        $null = $manager.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
        # Pre-fill RefTypeManager cache.
        foreach ($ai in $inst.file.AssetInfos) {
            if ($ai.TypeId -ne 114) { continue }
            try { $null = $manager.GetBaseField($inst, $ai) } catch {}
        }
        foreach ($ai in $inst.file.AssetInfos) {
            if ([int64]$ai.PathId -eq $assetPid) {
                $assetsInst = $inst
                $assetInfo = $ai
                $assetAfiIdx = $afiIdx
                break
            }
        }
        if ($null -ne $assetInfo) { break }
    } catch {}
}
if ($null -eq $assetInfo) { throw "Asset with PathID $assetPid not found in bundle" }
Write-Diag "Found asset in AFI[$assetAfiIdx] (TypeId=$($assetInfo.TypeId))"

# Inline C# ImportJson — той самий шлях, що HBR.
$csCode = @'
using System;
using System.IO;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using UABEANext4.Logic.ImportExport;

public static class TglMonoPatcher {
    public static string LastErr = "";
    public static int Patched = 0;

    public static byte[] ImportJson(AssetsManager manager, AssetsFileInstance inst, AssetTypeTemplateField template, string jsonRaw) {
        try {
            byte[] inBytes = Encoding.UTF8.GetBytes(jsonRaw);
            using (var ms = new MemoryStream(inBytes)) {
                var refMan = manager.GetRefTypeManager(inst);
                var importer = new AssetImport(ms, refMan);
                string error;
                byte[] bytes = importer.ImportJsonAsset(template, out error);
                if (!string.IsNullOrEmpty(error)) { LastErr = error; return null; }
                if (bytes == null) { LastErr = "ImportJsonAsset returned null"; return null; }
                Patched = bytes.Length;
                return bytes;
            }
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    (Join-Path $UabeaDir "UABEANext4.dll"),
    'netstandard', 'System.Runtime', 'System.IO', 'System.Collections'
)
Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop

# Patch.
$null = $manager.GetBaseField($assetsInst, $assetInfo)
$tpl = $manager.GetTemplateBaseField($assetsInst, $assetInfo)
$raw = [System.IO.File]::ReadAllText($JsonPath, [System.Text.Encoding]::UTF8)
$assetBytes = [TglMonoPatcher]::ImportJson($manager, $assetsInst, $tpl, $raw)
if ($null -eq $assetBytes) { throw ("ImportJsonAsset failed: " + [TglMonoPatcher]::LastErr) }
$assetInfo.SetNewData($assetBytes)
Write-Host ("[PATCHED] PathID {0} bytes={1}" -f $assetPid, $assetBytes.Length)

# Write bundle назад (uncompressed, як HBR — те саме що UABEA Save Selected).
$bak = $BundlePath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $BundlePath -Destination $bak -Force
    Write-Diag "Backup → $bak"
}
$writeTarget = $BundlePath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$assetAfiIdx].SetNewData($assetsInst.file)
    $bundleInst.file.Write($writer)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}
try { $assetsInst.file.Reader.Close() } catch {}
try { $bundleInst.file.Reader.Close() } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Move-Item -LiteralPath $writeTarget -Destination $BundlePath -Force
$outSize = (Get-Item $BundlePath).Length
Write-Step ("DONE → {0} ({1:N0} bytes)" -f $BundlePath, $outSize)

$summary = [pscustomobject]@{
    ok = $true; bundle = $BundlePath; size = $outSize
    pathId = $assetPid; patchedBytes = [TglMonoPatcher]::Patched
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
