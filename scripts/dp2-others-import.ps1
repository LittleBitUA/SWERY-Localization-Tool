# DP2 Others Import — пакує перекладене поле `mText` з UILabel-JSON-ів
# у sharedassets1.assets. Дзеркальна логіка до dp2-others-extract.ps1.
#
# Параметри:
#   -AssetsPath    : повний шлях до sharedassets1.assets (in-place перезапис)
#   -JsonDir       : тека з UILabel-*.json (зазвичай <toolsDir>/DP2/Others/Done)
#   -UabeaDir      : тека з AssetsTools.NET DLL'ями
#
# Емітить:
#   [STEP]/[DIAG] діагностику + RESULT_JSON у кінці.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$JsonDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw ".assets not found: $AssetsPath" }
if (-not (Test-Path $JsonDir))    { throw "JSON dir not found: $JsonDir" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

# Load DLLs у потрібному порядку (Cecil/Cpp2IL перед AssetsTools.NET).
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

# MonoBehaviour template generator (Cpp2IL для DP2 IL2CPP, fallback Mono).
$dataDir = Split-Path -Parent $AssetsPath
$managedDir = Join-Path $dataDir "Managed"
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
$genReady = $false
if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    try {
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator initialized."
        $genReady = $true
    } catch {
        Write-Warning ("Cpp2IL ctor failed: {0}" -f $_.Exception.Message)
    }
}
if (-not $genReady -and (Test-Path $managedDir)) {
    try {
        $monoGen = New-Object AssetsTools.NET.MonoCecil.MonoCecilTempGenerator($managedDir)
        $manager.MonoTempGenerator = $monoGen
        Write-Diag "MonoCecilTempGenerator initialized: $managedDir"
        $genReady = $true
    } catch {
        Write-Warning ("MonoCecil ctor failed: {0}" -f $_.Exception.Message)
    }
}
if (-not $genReady) {
    throw "No MonoBehaviour template generator available — cannot read/write UILabel fields."
}

# Збираємо JSON-и у мапу PathID -> file path. Ім'я має формат
# `UILabel-<assetBaseName>-<PathID>.json`. Витягуємо PathID хвостом.
Write-Step "Indexing UILabel JSON dumps in $JsonDir ..."
$jsonByPathId = @{}
$jsonFiles = Get-ChildItem -Path $JsonDir -Filter "UILabel-*.json" -File |
             Where-Object { $_.Name -notmatch '\.bak\.json$' }
foreach ($jf in $jsonFiles) {
    if ($jf.Name -match '-(\d+)\.json$') {
        [int64]$assetPid = $Matches[1]
        $jsonByPathId[$assetPid] = $jf.FullName
    }
}
Write-Host ("Found {0} UILabel JSON dumps with PathID." -f $jsonByPathId.Count)
if ($jsonByPathId.Count -eq 0) {
    Write-Step "Nothing to import — skipping write."
    $summary = [pscustomobject]@{ ok = $true; outputPath = $AssetsPath; imported = 0; skipped = 0; errors = 0; note = "empty" }
    Write-Host "RESULT_JSON: $(ConvertTo-Json -InputObject $summary -Compress)"
    exit 0
}

# Set-StringField helper — пробує два підходи (AsString = ...; fallback на Value).
function Set-StringField {
    param($Field, [string]$Value)
    if ($null -eq $Field) { return $false }
    try { $Field.AsString = $Value; return $true } catch {}
    try {
        $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::String, $Value)
        $Field.Value = $atv
        return $true
    } catch {}
    return $false
}

$imported = 0
$skipped = 0
$errors = 0
$processed = 0
$total = $jsonByPathId.Count

foreach ($info in $assetsInst.file.AssetInfos) {
    $assetPid = [int64]$info.PathId
    if (-not $jsonByPathId.ContainsKey($assetPid)) { continue }
    $processed++
    $jsonFile = $jsonByPathId[$assetPid]
    try {
        $jsonText = [System.IO.File]::ReadAllText($jsonFile, [System.Text.Encoding]::UTF8)
        $cmd = Get-Command ConvertFrom-Json
        if ($cmd.Parameters.ContainsKey("Depth")) {
            $jsonObj = $jsonText | ConvertFrom-Json -Depth 200
        } else {
            $jsonObj = $jsonText | ConvertFrom-Json
        }
        $newText = $null
        try { $newText = [string]$jsonObj.mText } catch {}
        if ($null -eq $newText) {
            Write-Diag ("PathID={0}: JSON has no mText — skip" -f $assetPid)
            $skipped++; continue
        }

        $baseField = $manager.GetBaseField($assetsInst, $info)
        if ($null -eq $baseField) {
            Write-Warning ("PathID={0}: GetBaseField returned null" -f $assetPid)
            $errors++; continue
        }
        $mTextField = $null
        try { $mTextField = $baseField["mText"] } catch {}
        if ($null -eq $mTextField) {
            Write-Diag ("PathID={0}: no mText child — not a UILabel? skip" -f $assetPid)
            $skipped++; continue
        }
        if (-not (Set-StringField $mTextField $newText)) {
            Write-Warning ("PathID={0}: failed to set mText" -f $assetPid)
            $errors++; continue
        }
        $info.SetNewData($baseField)
        $imported++
    } catch {
        $errors++
        Write-Warning ("PathID={0} {1}: {2}" -f $assetPid, ($jsonFile | Split-Path -Leaf), $_.Exception.Message)
    }
    if (($processed % 25) -eq 0) {
        Write-Host ("  ... {0} / {1}" -f $processed, $total)
    }
}

Write-Step ("Imported: {0}, Skipped: {1}, Errors: {2}" -f $imported, $skipped, $errors)
if ($imported -eq 0) {
    Write-Diag "Nothing to write — exiting without touching .assets."
    $summary = [pscustomobject]@{ ok = $true; outputPath = $AssetsPath; imported = 0; skipped = $skipped; errors = $errors; note = "no-writes" }
    Write-Host "RESULT_JSON: $(ConvertTo-Json -InputObject $summary -Compress)"
    exit 0
}

# In-place перезапис: .assets file lock тримає AssetsManager. Тому пишемо у
# `.tmp` поруч, потім розвантажуємо менеджер і атомарно перейменовуємо.
$writeTarget = $AssetsPath + ".tmp"
Write-Step "Writing $writeTarget ..."
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    $assetsInst.file.Write($writer, 0)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}

try { $assetsInst.file.Reader.Close() } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

# Backup raз — не перетираємо існуючий .bak (це може бути єдина чиста копія).
$bakPath = $AssetsPath + ".bak"
if (-not (Test-Path $bakPath)) {
    Copy-Item -LiteralPath $AssetsPath -Destination $bakPath -Force
    Write-Diag "Backup created: $bakPath"
} else {
    Write-Diag "Backup already exists, keeping: $bakPath"
}

Move-Item -LiteralPath $writeTarget -Destination $AssetsPath -Force
$outSize = (Get-Item $AssetsPath).Length
Write-Step ("DONE -> {0} ({1:N0} bytes)" -f $AssetsPath, $outSize)

$summary = [pscustomobject]@{
    ok = $true
    outputPath = $AssetsPath
    imported = $imported
    skipped = $skipped
    errors = $errors
}
Write-Host "RESULT_JSON: $(ConvertTo-Json -InputObject $summary -Compress)"
exit 0
