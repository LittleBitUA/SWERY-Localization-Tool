# THE MISSING — розширення RectTransform.sizeDelta.x для menu-title-text.
#
# Проблема: m_Text у sharedassets — EN/JP-оригінал (наприклад "OPTION"), а
# UA-переклад підставляється runtime з msg.dat. RectTransform у prefab'і
# вирахували під EN-довжину; UA «НАЛАШТУВАННЯ» (12 літер) не влазить у
# rect width=540 → обрізається rect-mask'ом.
#
# Цей скрипт сканує MonoBehaviour-и з полем m_Text, для кожного з fontSize
# >= MinFontSize резолвить RectTransform → множить sizeDelta.x на ExpandRatio
# (мін. MinExpandTo). Бекап .uirect.bak.
#
# Параметри:
#   -DataDir       : повний шлях до TheMISSING_Data
#   -UabeaDir      : тека з AssetsTools.NET DLL'ями
#   -MinFontSize   : (default 40) тільки тексти з фонтом ≥ N
#   -ExpandRatio   : (default 1.6) множник rect.x
#   -MinExpandTo   : (default 800) мін. абсолютний rect.x після expand
#   -DryRun        : тільки звіт

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [int]$MinFontSize = 40,
    [double]$ExpandRatio = 1.6,
    [int]$MinExpandTo = 800,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DataDir)) { throw "DataDir not found: $DataDir" }
if (-not (Test-Path $UabeaDir)) { throw "UABEA dir not found: $UabeaDir" }

$loadList = @(
    "Mono.Cecil.dll", "LibCpp2IL.dll", "Newtonsoft.Json.dll",
    "AssetsTools.NET.dll", "AssetsTools.NET.MonoCecil.dll",
    "AssetsTools.NET.Cpp2IL.dll"
)
foreach ($n in $loadList) {
    $p = Join-Path $UabeaDir $n
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}

$tpk = Join-Path $UabeaDir "classdata.tpk"
$mgr = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $mgr.LoadClassPackage($tpk)
$mgr.UseRefTypeManagerCache = $true
$mgr.UseTemplateFieldCache = $true
$mgr.UseMonoTemplateFieldCache = $true

$managedDir = Join-Path $DataDir "Managed"
if (-not (Test-Path $managedDir)) { throw "Managed dir not found: $managedDir" }
$monoGen = New-Object AssetsTools.NET.Extra.MonoCecilTempGenerator($managedDir)
$mgr.MonoTempGenerator = $monoGen

$assetsFiles = @()
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "sharedassets*.assets" -File | Sort-Object Name
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "resources.assets" -File
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -File | Where-Object { $_.Name -match '^level\d+$' } | Sort-Object Name

Write-Step "Scanning $($assetsFiles.Count) .assets files (fs >= $MinFontSize, expand ×$ExpandRatio min $MinExpandTo)..."

$touchedFiles = @{}   # path → instance
$pendingFixes = New-Object System.Collections.ArrayList

# RectTransform PathId resolver: для GameObject PPtr знаходить RectTransform
# component у тому ж файлі.
function Find-RectComponent {
    param($inst, $goPathId)
    foreach ($ai in $inst.file.AssetInfos) {
        if ([int64]$ai.PathId -ne [int64]$goPathId) { continue }
        if ($ai.TypeId -ne 1) { return $null }
        $goBase = $null
        try { $goBase = $mgr.GetBaseField($inst, $ai) } catch { return $null }
        if ($null -eq $goBase) { return $null }
        $comps = $null
        try { $comps = $goBase["m_Component"]["Array"] } catch { return $null }
        if ($null -eq $comps) { return $null }
        foreach ($entry in $comps.Children) {
            $compPtr = $null
            try { $compPtr = $entry["component"] } catch { try { $compPtr = $entry } catch {} }
            if ($null -eq $compPtr) { continue }
            $compPathId = 0
            try { $compPathId = [int64]$compPtr["m_PathID"].AsLong } catch {}
            if ($compPathId -le 0) { continue }
            foreach ($ai2 in $inst.file.AssetInfos) {
                if ([int64]$ai2.PathId -eq $compPathId -and $ai2.TypeId -eq 224) { return $ai2 }
            }
        }
        return $null
    }
    return $null
}

$scanned = 0
foreach ($f in $assetsFiles) {
    $inst = $null
    try {
        $inst = $mgr.LoadAssetsFile($f.FullName, $false)
        $null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
    } catch { continue }
    $touched = $false
    foreach ($ai in $inst.file.AssetInfos) {
        if ($ai.TypeId -ne 114) { continue }
        $scanned++
        $base = $null
        try { $base = $mgr.GetBaseField($inst, $ai) } catch { continue }
        if ($null -eq $base) { continue }
        $txtField = $null
        try { $txtField = $base["m_Text"] } catch {}
        if ($null -eq $txtField -or $txtField.IsDummy) { continue }
        $fontSize = 0
        try { $fontSize = [int]$base["m_FontData"]["m_FontSize"].AsInt } catch {}
        if ($fontSize -lt $MinFontSize) { continue }
        $text = ""
        try { $text = $txtField.AsString } catch { continue }
        if (-not $text) { continue }
        $goPathId = 0
        try { $goPathId = [int64]$base["m_GameObject"]["m_PathID"].AsLong } catch {}
        if ($goPathId -le 0) { continue }
        $rtAi = Find-RectComponent $inst $goPathId
        if ($null -eq $rtAi) { continue }
        $rt = $null
        try { $rt = $mgr.GetBaseField($inst, $rtAi) } catch { continue }
        if ($null -eq $rt) { continue }
        $sdField = $null
        try { $sdField = $rt["m_SizeDelta"] } catch {}
        if ($null -eq $sdField) { continue }
        $oldX = 0.0
        try { $oldX = [double]$sdField["x"].AsFloat } catch {}
        if ($oldX -le 0) { continue }
        # Skip короткі labels (числа, "/" та інше — мала ймовірність UA-localize).
        if ($text.Length -le 3) { continue }
        # estimate: середня літера ≈ fontSize × 0.6 (для пропорційних шрифтів).
        # UA-factor 2.0 — UA-переклад може бути у 1.5-2× довший за EN/JP
        # ("OPTION" 6 chars → "НАЛАШТУВАННЯ" 12 chars; "Settings" 8 → "Опції" 5
        # ⊕ "Налаштування" 12). Беремо запас з гарантією.
        $estimateNeeded = $text.Length * $fontSize * 0.6 * 2.0
        # Якщо rect уже достатньо широкий під UA — пропускаємо.
        if ($estimateNeeded -le $oldX) { continue }
        # Розширюємо до max(estimateNeeded, oldX × ExpandRatio), не нижче MinExpandTo.
        $finalX = [Math]::Max([Math]::Max($estimateNeeded, $oldX * $ExpandRatio), $MinExpandTo)
        [void]$pendingFixes.Add([pscustomobject]@{
            file = $f.Name
            pathId = [int64]$ai.PathId
            text = $text
            fontSize = $fontSize
            oldRectW = [int]$oldX
            newRectW = [int]$finalX
        })
        if (-not $DryRun) {
            try {
                $sdField["x"].AsFloat = [single]$finalX
                $rtAi.SetNewData($rt)
                $touched = $true
            } catch {
                Write-Warning "  apply fail pid=$($ai.PathId) — $($_.Exception.Message)"
            }
        }
    }
    if ($touched) { $touchedFiles[$f.FullName] = $inst } else { try { $inst.file.Reader.Close() } catch {} }
}

Write-Step ("Scanned MonoBehaviour=$scanned, pending-fixes={0}" -f $pendingFixes.Count)
foreach ($p in ($pendingFixes | Select-Object -First 30)) {
    Write-Host ("  {0} pid={1} fs={2} `"{3}`" : {4} → {5}" -f $p.file, $p.pathId, $p.fontSize, $p.text, $p.oldRectW, $p.newRectW)
}

if ($DryRun) {
    Write-Step "Dry-run, нічого не записано."
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; dryRun = $true; fixes = $pendingFixes.Count } | ConvertTo-Json -Compress))
    exit 0
}

if ($pendingFixes.Count -eq 0) {
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = 0 } | ConvertTo-Json -Compress))
    exit 0
}

$wrote = 0
foreach ($k in $touchedFiles.Keys) {
    $inst = $touchedFiles[$k]
    $bak = $k + ".uirect.bak"
    if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $k -Destination $bak -Force; Write-Diag "  backup -> $bak" }
    $tmp = $k + ".tmp"
    $writer = $null
    try {
        $writer = New-Object AssetsTools.NET.AssetsFileWriter($tmp)
        $inst.file.Write($writer, 0)
    } finally { if ($null -ne $writer) { $writer.Close() } }
    try { $inst.file.Reader.Close() } catch {}
    Move-Item -LiteralPath $tmp -Destination $k -Force
    $wrote++
    Write-Host ("[WROTE] $(Split-Path $k -Leaf)")
}
try { $mgr.UnloadAllAssetsFiles() } catch {}
try { $mgr.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Write-Step ("DONE — files written: $wrote, fixes applied: {0}" -f $pendingFixes.Count)
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = $pendingFixes.Count; files = $wrote } | ConvertTo-Json -Compress))
exit 0
