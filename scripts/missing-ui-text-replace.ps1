# THE MISSING — масова заміна UI.Text.m_Text за словником.
#
# Бере JSON `[ { "from": "YES", "to": "Так" }, ... ]` і для кожного
# UI.Text MonoBehaviour'у з m_Text що EXACT-збігається з `from` —
# підмінює на `to`. Зберігає у тих самих .assets-файлах з .uitxt.bak.
#
# Параметри:
#   -DataDir, -UabeaDir
#   -MappingJson  : шлях до JSON з масивом замін
#   -DryRun       : тільки звіт

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$MappingJson,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DataDir)) { throw "DataDir not found: $DataDir" }
if (-not (Test-Path $UabeaDir)) { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $MappingJson)) { throw "MappingJson not found: $MappingJson" }

$rawJson = [System.IO.File]::ReadAllText($MappingJson, [System.Text.Encoding]::UTF8)
$mappingArr = $rawJson | ConvertFrom-Json
$map = @{}
foreach ($m in $mappingArr) {
    if ($null -eq $m.from -or $null -eq $m.to) { continue }
    $map[[string]$m.from] = [string]$m.to
}
Write-Diag "Mapping entries: $($map.Count)"
foreach ($k in $map.Keys) { Write-Diag "  `"$k`" → `"$($map[$k])`"" }

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

Write-Step "Scanning $($assetsFiles.Count) .assets files for exact m_Text matches..."

$touchedFiles = @{}
$applied = New-Object System.Collections.ArrayList

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
        $text = ""
        try { $text = $txtField.AsString } catch { continue }
        if ($null -eq $text -or $text -eq "") { continue }
        if (-not $map.ContainsKey($text)) { continue }
        $newText = $map[$text]
        [void]$applied.Add([pscustomobject]@{
            file = $f.Name
            pathId = [int64]$ai.PathId
            from = $text
            to = $newText
        })
        if (-not $DryRun) {
            try {
                $txtField.AsString = $newText
                $ai.SetNewData($base)
                $touched = $true
            } catch {
                Write-Warning "  apply fail pid=$($ai.PathId) — $($_.Exception.Message)"
            }
        }
    }
    if ($touched) { $touchedFiles[$f.FullName] = $inst } else { try { $inst.file.Reader.Close() } catch {} }
}

Write-Step ("Matched {0} positions across {1} files" -f $applied.Count, $touchedFiles.Count)
foreach ($a in ($applied | Select-Object -First 20)) {
    Write-Host ("  {0} pid={1} `"{2}`" → `"{3}`"" -f $a.file, $a.pathId, $a.from, $a.to)
}
if ($applied.Count -gt 20) { Write-Host ("  … та ще {0}" -f ($applied.Count - 20)) }

if ($DryRun) {
    Write-Step "Dry-run."
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; dryRun = $true; matched = $applied.Count } | ConvertTo-Json -Compress))
    exit 0
}

$wrote = 0
foreach ($k in $touchedFiles.Keys) {
    $inst = $touchedFiles[$k]
    $bak = $k + ".uitxt.bak"
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

Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = $applied.Count; files = $wrote } | ConvertTo-Json -Compress))
exit 0
