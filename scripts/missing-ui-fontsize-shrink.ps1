# THE MISSING — зменшення UI.Text.m_FontData.m_FontSize для menu-title-text.
#
# Альтернатива до missing-ui-rect-expand: не чіпаємо rect (щоб text не виходив
# за межі screen), а ЗМЕНШУЄМО fontSize так щоб UA-переклад вміщувався у
# існуючий rect. Це менш ризиковано візуально (text лишається центрованим
# відносно того ж rect-у).
#
# Логіка: для кожного UI.Text/TextEx з полем m_Text:
#   - якщо fontSize >= MinFontSize І
#   - якщо estimateNeeded (UA-довжина) > rect.x →
#     зменшуємо fontSize до того, щоб estimateNeeded точно вмістилось.
#
# Параметри:
#   -DataDir, -UabeaDir
#   -MinFontSize  : (default 40) тільки тексти з фонтом ≥ N
#   -UaFactor     : (default 2.0) множник UA-довжини відносно EN/JP
#   -CharWidth    : (default 0.6) ширина літери відносно fontSize
#   -DryRun

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [int]$MinFontSize = 40,
    [double]$UaFactor = 2.0,
    [double]$CharWidth = 0.6,
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

Write-Step "Scanning (fs >= $MinFontSize, UA-factor ×$UaFactor, charWidth ×$CharWidth)..."

# Знайти RectTransform для GameObject (як у попередніх скриптах).
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

$touchedFiles = @{}
$pendingFixes = New-Object System.Collections.ArrayList

foreach ($f in $assetsFiles) {
    $inst = $null
    try {
        $inst = $mgr.LoadAssetsFile($f.FullName, $false)
        $null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
    } catch { continue }
    $touched = $false
    foreach ($ai in $inst.file.AssetInfos) {
        if ($ai.TypeId -ne 114) { continue }
        $base = $null
        try { $base = $mgr.GetBaseField($inst, $ai) } catch { continue }
        if ($null -eq $base) { continue }
        $txtField = $null
        try { $txtField = $base["m_Text"] } catch {}
        if ($null -eq $txtField -or $txtField.IsDummy) { continue }
        $fontDataField = $null
        try { $fontDataField = $base["m_FontData"] } catch {}
        if ($null -eq $fontDataField -or $fontDataField.IsDummy) { continue }
        $fsField = $null
        try { $fsField = $fontDataField["m_FontSize"] } catch {}
        if ($null -eq $fsField -or $fsField.IsDummy) { continue }
        $fontSize = [int]$fsField.AsInt
        if ($fontSize -lt $MinFontSize) { continue }
        $text = ""
        try { $text = $txtField.AsString } catch { continue }
        if (-not $text) { continue }
        if ($text.Length -le 3) { continue }
        # Multi-line text: для TMP-style wrap текст міряється по найдовшому
        # рядку (після \n), а не сумі. Інакше для disclaimer з 200 chars і
        # 8 \n формула вимагала б fs=14, але реально кожен рядок ~30 chars.
        $maxLineLen = 0
        foreach ($line in ($text -split "`n")) { if ($line.Length -gt $maxLineLen) { $maxLineLen = $line.Length } }
        if ($maxLineLen -le 3) { continue }
        $goPathId = 0
        try { $goPathId = [int64]$base["m_GameObject"]["m_PathID"].AsLong } catch {}
        if ($goPathId -le 0) { continue }
        $rtAi = Find-RectComponent $inst $goPathId
        if ($null -eq $rtAi) { continue }
        $rt = $null
        try { $rt = $mgr.GetBaseField($inst, $rtAi) } catch { continue }
        if ($null -eq $rt) { continue }
        $rectW = 0.0
        try { $rectW = [double]$rt["m_SizeDelta"]["x"].AsFloat } catch {}
        if ($rectW -le 0) { continue }
        $estimateNeeded = $maxLineLen * $fontSize * $CharWidth * $UaFactor
        if ($estimateNeeded -le $rectW) { continue }
        # Цільовий rect = 90% від актуального (10% margin), щоб text не
        # упирався у край (кирилиця може бути ширшою у конкретному шрифті).
        $targetW = $rectW * 0.9
        $newFs = [Math]::Floor($targetW / ($maxLineLen * $CharWidth * $UaFactor))
        if ($newFs -ge $fontSize) { continue }
        if ($newFs -lt 24) { $newFs = 24 } # readability floor — не ріжемо нижче 24px
        [void]$pendingFixes.Add([pscustomobject]@{
            file = $f.Name
            pathId = [int64]$ai.PathId
            text = $text
            rectW = [int]$rectW
            oldFs = $fontSize
            newFs = $newFs
        })
        if (-not $DryRun) {
            try {
                $fsField.AsInt = [int]$newFs
                $ai.SetNewData($base)
                $touched = $true
            } catch {
                Write-Warning "  apply fail pid=$($ai.PathId) — $($_.Exception.Message)"
            }
        }
    }
    if ($touched) { $touchedFiles[$f.FullName] = $inst } else { try { $inst.file.Reader.Close() } catch {} }
}

Write-Step ("pending-fixes={0}" -f $pendingFixes.Count)
foreach ($p in $pendingFixes) {
    Write-Host ("  {0} pid={1} rect={2} fs:{3}→{4} `"{5}`"" -f $p.file, $p.pathId, $p.rectW, $p.oldFs, $p.newFs, $p.text)
}

if ($DryRun) {
    Write-Step "Dry-run."
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; dryRun = $true; fixes = $pendingFixes.Count } | ConvertTo-Json -Compress))
    exit 0
}

$wrote = 0
foreach ($k in $touchedFiles.Keys) {
    $inst = $touchedFiles[$k]
    $bak = $k + ".uifs.bak"
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
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = $pendingFixes.Count; files = $wrote } | ConvertTo-Json -Compress))
exit 0
