# THE MISSING — UI.Text overflow / wrap config fix.
#
# MISSING використовує classic UnityEngine.UI.Text (uGUI), НЕ TextMeshPro.
# Поля у MonoBehaviour:
#   m_FontData.m_HorizontalOverflow   enum HorizontalWrapMode { Wrap=0, Overflow=1 }
#   m_FontData.m_VerticalOverflow     enum VerticalWrapMode { Truncate=0, Overflow=1 }
#   m_FontData.m_BestFit              bool
#
# Симптоми у грі (з перекладом UA):
#   - "Це Джей-Д"            ← horizontalOverflow=Overflow (1), вертикально не wraps
#   - "Хочу покататися на тук-ту"     ← те саме, або BestFit/обрізання
#   - "Я поруч … не пот / ребувала."  ← character-wrap, ймовірно `m_BestFit=true`
#                                        (Unity тоді ріже ПОСЕРЕД слова)
#
# Fix:
#   - HorizontalOverflow → Wrap (0)
#   - VerticalOverflow   → Overflow (1)
#   - m_BestFit          → false   (інакше Unity скейлить текст і ріже по символу)
#
# Параметри:
#   -DataDir   : повний шлях до TheMISSING_Data
#   -UabeaDir  : тека з AssetsTools.NET DLL'ями
#   -DryRun    : лише сканує, нічого не пише
#   -VerboseList : виводити кожен matched UI.Text MonoBehaviour

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [switch]$DryRun,
    [switch]$VerboseList
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DataDir)) { throw "DataDir not found: $DataDir" }
if (-not (Test-Path $UabeaDir)) { throw "UABEA dir not found: $UabeaDir" }

$loadList = @(
    "Mono.Cecil.dll", "LibCpp2IL.dll", "Newtonsoft.Json.dll",
    "AssetsTools.NET.dll", "AssetsTools.NET.MonoCecil.dll", "AssetsTools.NET.Cpp2IL.dll",
    "AssetRipper.Primitives.dll", "AssetRipper.TextureDecoder.dll"
)
foreach ($n in $loadList) {
    $p = Join-Path $UabeaDir $n
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}

$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)
$manager.UseRefTypeManagerCache = $true
$manager.UseTemplateFieldCache = $true
$manager.UseMonoTemplateFieldCache = $true

# Mono temp-generator: MISSING — це Mono build. UI.Text — НЕ MonoBehaviour
# (TypeId=114), а Component з core Unity (TypeId=??). Перевіримо: у Unity
# 2018 UnityEngine.UI.Text має ClassID 222 (Image) чи... ні. UI.Text — це
# MonoBehaviour, що походить від UnityEngine.UI.Text у UnityEngine.UI.dll.
# Тобто TypeId=114, серіалізований класс — UI.Text, потрібен TypeTree з UI.dll.
$managedDir = Join-Path $DataDir "Managed"
if (Test-Path $managedDir) {
    try {
        $monoGen = New-Object AssetsTools.NET.Extra.MonoCecilTempGenerator($managedDir)
        $manager.MonoTempGenerator = $monoGen
        Write-Diag "MonoCecilTempGenerator ready ($managedDir)"
    } catch { throw "MonoCecil init failed: $($_.Exception.Message)" }
} else {
    throw "Managed dir not found: $managedDir"
}

$assetsFiles = @()
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "sharedassets*.assets" -File | Sort-Object Name
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "resources.assets" -File
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "globalgamemanagers.assets" -File
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -File | Where-Object { $_.Name -match '^level\d+$' } | Sort-Object Name

Write-Step "Scanning $($assetsFiles.Count) .assets files for UI.Text components..."

$totalText = 0
$totalOverflowFix = 0
$totalBestFitFix = 0
$totalVertFix = 0
$touchedFiles = @{}
$pendingChanges = @{}

foreach ($f in $assetsFiles) {
    $fullAssets = $f.FullName
    $assetsInst = $null
    try {
        $assetsInst = $manager.LoadAssetsFile($fullAssets, $false)
        $null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)
    } catch {
        Write-Diag "  skip $($f.Name): load fail — $($_.Exception.Message)"
        continue
    }
    $textInFile = 0
    $changedInFile = New-Object System.Collections.ArrayList
    foreach ($ai in $assetsInst.file.AssetInfos) {
        if ($ai.TypeId -ne 114) { continue }
        $base = $null
        try { $base = $manager.GetBaseField($assetsInst, $ai) } catch { continue }
        if ($null -eq $base) { continue }
        # UI.Text має поле m_FontData (struct). Якщо нема — це не UI.Text.
        $fontData = $null
        try { $fontData = $base["m_FontData"] } catch {}
        if ($null -eq $fontData -or $fontData.IsDummy) { continue }
        $hOverField = $null
        $vOverField = $null
        $bestFitField = $null
        try { $hOverField = $fontData["m_HorizontalOverflow"] } catch {}
        try { $vOverField = $fontData["m_VerticalOverflow"] } catch {}
        try { $bestFitField = $fontData["m_BestFit"] } catch {}
        if ($null -eq $hOverField -or $hOverField.IsDummy) { continue }
        $totalText++; $textInFile++

        $hOver = [int]$hOverField.AsInt
        $vOver = if ($null -ne $vOverField -and -not $vOverField.IsDummy) { [int]$vOverField.AsInt } else { 0 }
        $bestFit = if ($null -ne $bestFitField -and -not $bestFitField.IsDummy) { [bool]$bestFitField.AsBool } else { $false }

        $needHFix = ($hOver -eq 1)              # Overflow → Wrap
        $needVFix = ($vOver -eq 0)              # Truncate → Overflow
        $needBFFix = $bestFit                   # BestFit on → off

        if ($needHFix) { $totalOverflowFix++ }
        if ($needVFix) { $totalVertFix++ }
        if ($needBFFix) { $totalBestFitFix++ }

        if (-not ($needHFix -or $needVFix -or $needBFFix)) { continue }

        if ($VerboseList) {
            Write-Host ("  [{0}] PathID {1} hOver={2} vOver={3} bestFit={4}" -f $f.Name, $ai.PathId, $hOver, $vOver, $bestFit)
        }

        if (-not $DryRun) {
            try {
                if ($needHFix) { $hOverField.AsInt = 0 }
                if ($needVFix -and $null -ne $vOverField -and -not $vOverField.IsDummy) { $vOverField.AsInt = 1 }
                if ($needBFFix -and $null -ne $bestFitField -and -not $bestFitField.IsDummy) { $bestFitField.AsBool = $false }
                $ai.SetNewData($base)
                [void]$changedInFile.Add([pscustomobject]@{ pathId = [int64]$ai.PathId; hOver = $hOver; vOver = $vOver; bestFit = $bestFit })
            } catch {
                Write-Warning "  PathID $($ai.PathId): apply fail — $($_.Exception.Message)"
            }
        }
    }
    if ($textInFile -gt 0) {
        Write-Diag ("  {0}: UI.Text={1}, fixes-pending={2}" -f $f.Name, $textInFile, $changedInFile.Count)
    }
    if ($changedInFile.Count -gt 0) {
        $touchedFiles[$fullAssets] = $assetsInst
        $pendingChanges[$fullAssets] = $changedInFile
    } else {
        try { $assetsInst.file.Reader.Close() } catch {}
    }
}

Write-Step ("SCAN DONE: UI.Text found={0}, overflow=Overflow→Wrap={1}, vOverflow=Truncate→Overflow={2}, bestFit on→off={3}" -f $totalText, $totalOverflowFix, $totalVertFix, $totalBestFitFix)

if ($DryRun) {
    Write-Step "Dry-run — нічого не записано."
    $summary = [pscustomobject]@{
        ok = $true; dryRun = $true
        uiTextTotal = $totalText
        hOverflowFixable = $totalOverflowFix
        vOverflowFixable = $totalVertFix
        bestFitFixable = $totalBestFitFix
        filesAffected = $touchedFiles.Count
    }
    Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Compress))
    exit 0
}

$writtenFiles = 0
foreach ($k in $touchedFiles.Keys) {
    $assetsInst = $touchedFiles[$k]
    $bak = $k + ".tmpfix.bak"
    if (-not (Test-Path $bak)) {
        Copy-Item -LiteralPath $k -Destination $bak -Force
        Write-Diag "  backup -> $bak"
    }
    $tmp = $k + ".tmp"
    $writer = $null
    try {
        $writer = New-Object AssetsTools.NET.AssetsFileWriter($tmp)
        $assetsInst.file.Write($writer, 0)
    } finally {
        if ($null -ne $writer) { $writer.Close() }
    }
    try { $assetsInst.file.Reader.Close() } catch {}
    Move-Item -LiteralPath $tmp -Destination $k -Force
    $writtenFiles++
    Write-Host ("[WROTE] {0} (fixes={1})" -f (Split-Path $k -Leaf), $pendingChanges[$k].Count)
}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Write-Step ("APPLY DONE: wrote {0} .assets files" -f $writtenFiles)
$summary = [pscustomobject]@{
    ok = $true; dryRun = $false
    uiTextTotal = $totalText
    hOverflowFixed = $totalOverflowFix
    vOverflowFixed = $totalVertFix
    bestFitFixed = $totalBestFitFix
    filesWritten = $writtenFiles
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Compress))
exit 0
