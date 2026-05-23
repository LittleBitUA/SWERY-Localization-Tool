# THE MISSING — UI text scanner (UI.Text + TextEx + інші нащадки з m_Text).
#
# Шукає MonoBehaviour'и з полем `m_Text` (Unity-стандартний UI.Text, кастомний
# TextEx тощо), резолвить GameObject → RectTransform → sizeDelta, виводить
# таблицю кандидатів на обрізання. За цим списком можна точково правити
# UI-prefab'и (збільшити RectTransform.sizeDelta.x для заголовків меню тощо).
#
# Параметри:
#   -DataDir   : повний шлях до TheMISSING_Data
#   -UabeaDir  : тека з AssetsTools.NET DLL'ями
#   -OutFile   : (опц.) куди писати JSON
#   -OnlyCyrillic : (опц.) лише ті, чий m_Text містить кирилицю

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [string]$OutFile = "",
    [switch]$OnlyCyrillic
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
try {
    $monoGen = New-Object AssetsTools.NET.Extra.MonoCecilTempGenerator($managedDir)
    $mgr.MonoTempGenerator = $monoGen
    Write-Diag "MonoCecilTempGenerator ready"
} catch { throw "MonoCecil init failed: $($_.Exception.Message)" }

$assetsFiles = @()
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "sharedassets*.assets" -File | Sort-Object Name
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -Filter "resources.assets" -File
$assetsFiles += Get-ChildItem -LiteralPath $DataDir -File | Where-Object { $_.Name -match '^level\d+$' } | Sort-Object Name

Write-Step "Scanning $($assetsFiles.Count) .assets files (всі MonoBehaviour з полем m_Text)..."

$cyrRe = [regex]'\p{IsCyrillic}'

# Helpers — резолвинг PPtr GameObject → RectTransform. RectTransform у Unity
# має TypeId = 224 (CommonString id для класу).
function Get-RectSizeDelta {
    param($inst, $goPathId)
    if ($goPathId -le 0) { return $null }
    # Знаходимо GameObject у тому ж файлі.
    $goAi = $null
    foreach ($ai2 in $inst.file.AssetInfos) {
        if ([int64]$ai2.PathId -eq [int64]$goPathId) { $goAi = $ai2; break }
    }
    if ($null -eq $goAi) { return $null }
    if ($goAi.TypeId -ne 1) { return $null }  # TypeId 1 = GameObject
    $goBase = $null
    try { $goBase = $mgr.GetBaseField($inst, $goAi) } catch { return $null }
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
        $compAi = $null
        foreach ($ai3 in $inst.file.AssetInfos) {
            if ([int64]$ai3.PathId -eq $compPathId) { $compAi = $ai3; break }
        }
        if ($null -eq $compAi) { continue }
        # RectTransform = TypeId 224. (Transform = 4; RectTransform extends Transform.)
        if ($compAi.TypeId -ne 224) { continue }
        $rt = $null
        try { $rt = $mgr.GetBaseField($inst, $compAi) } catch { continue }
        if ($null -eq $rt) { continue }
        $sd = $null
        try { $sd = $rt["m_SizeDelta"] } catch {}
        if ($null -eq $sd) { continue }
        $x = 0; $y = 0
        try { $x = [single]$sd["x"].AsFloat } catch {}
        try { $y = [single]$sd["y"].AsFloat } catch {}
        return [pscustomobject]@{ x = $x; y = $y }
    }
    return $null
}

function Get-GoName {
    param($inst, $goPathId)
    if ($goPathId -le 0) { return "" }
    foreach ($ai2 in $inst.file.AssetInfos) {
        if ([int64]$ai2.PathId -eq [int64]$goPathId -and $ai2.TypeId -eq 1) {
            $b = $null
            try { $b = $mgr.GetBaseField($inst, $ai2) } catch { return "" }
            if ($null -eq $b) { return "" }
            try { return $b["m_Name"].AsString } catch { return "" }
        }
    }
    return ""
}

$rows = New-Object System.Collections.ArrayList
$stats = @{ total = 0; withMText = 0; withCyr = 0 }

foreach ($f in $assetsFiles) {
    $inst = $null
    try {
        $inst = $mgr.LoadAssetsFile($f.FullName, $false)
        $null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
    } catch { continue }
    foreach ($ai in $inst.file.AssetInfos) {
        if ($ai.TypeId -ne 114) { continue }
        $stats.total++
        $base = $null
        try { $base = $mgr.GetBaseField($inst, $ai) } catch { continue }
        if ($null -eq $base) { continue }
        $txtField = $null
        try { $txtField = $base["m_Text"] } catch {}
        if ($null -eq $txtField -or $txtField.IsDummy) { continue }
        $text = ""
        try { $text = $txtField.AsString } catch { continue }
        $stats.withMText++
        if (-not $text) { continue }
        $isCyr = $cyrRe.IsMatch($text)
        if ($OnlyCyrillic -and -not $isCyr) { continue }
        if ($isCyr) { $stats.withCyr++ }

        # fontSize з m_FontData (якщо UI.Text-style).
        $fontSize = 0
        try { $fontSize = [int]$base["m_FontData"]["m_FontSize"].AsInt } catch {}
        # GameObject PPtr → name + RectTransform.sizeDelta.
        $goPathId = 0
        try { $goPathId = [int64]$base["m_GameObject"]["m_PathID"].AsLong } catch {}
        $rect = $null
        try { $rect = Get-RectSizeDelta $inst $goPathId } catch {}
        $goName = ""
        try { $goName = Get-GoName $inst $goPathId } catch {}

        [void]$rows.Add([pscustomobject]@{
            file = $f.Name
            pathId = [int64]$ai.PathId
            goName = $goName
            text = $text
            len = $text.Length
            cyrillic = $isCyr
            fontSize = $fontSize
            rectW = if ($rect) { [int]$rect.x } else { -1 }
            rectH = if ($rect) { [int]$rect.y } else { -1 }
        })
    }
    try { $inst.file.Reader.Close() } catch {}
}
try { $mgr.UnloadAllAssetsFiles() } catch {}
try { $mgr.UnloadAll() } catch {}

Write-Diag ("Stats: TypeId=114 total={0}, з полем m_Text={1}, з кирилицею={2}" -f $stats.total, $stats.withMText, $stats.withCyr)

$sorted = $rows | Sort-Object @{Expression='cyrillic';Descending=$true}, @{Expression='len';Descending=$true}
$top = if ($OnlyCyrillic) { $sorted } else { $sorted | Select-Object -First 80 }

Write-Step ("Listed {0} rows" -f @($top).Count)
Write-Host ""
Write-Host ("{0,-22} {1,-10} {2,-22} {3,5} {4,5} {5,5} {6,5} {7}" -f "FILE", "PATHID", "GO_NAME", "LEN", "CYR", "FS", "RECTW", "TEXT")
Write-Host ("-" * 130)
foreach ($r in $top) {
    $preview = $r.text -replace "[\r\n]+", " " | ForEach-Object { $_ }
    if ($preview.Length -gt 50) { $preview = $preview.Substring(0, 47) + "..." }
    Write-Host ("{0,-22} {1,-10} {2,-22} {3,5} {4,5} {5,5} {6,5} {7}" -f $r.file, $r.pathId, ($r.goName -replace '\s', '_').Substring(0, [Math]::Min(22, $r.goName.Length)), $r.len, $(if ($r.cyrillic) { "Y" } else { "n" }), $r.fontSize, $r.rectW, $preview)
}

if ($OutFile) {
    $dir = Split-Path $OutFile -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, ($sorted | ConvertTo-Json -Depth 4 -Compress), [System.Text.UTF8Encoding]::new($false))
    Write-Step "JSON written to $OutFile (всі $($sorted.Count) рядків)"
}
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; total = $stats.total; withMText = $stats.withMText; withCyr = $stats.withCyr; rows = $sorted.Count } | ConvertTo-Json -Compress))
exit 0
