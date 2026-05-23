# THE MISSING — Імпорт interface.txt назад у sharedassets/levels.
#
# Парсить interface.txt (формат: блоки `[file:pathId]\ntext\n\n`), знаходить
# відповідні UI.Text MonoBehaviour'и у .assets, замінює m_Text. Sanity:
# якщо в interface.txt текст ідентичний поточному m_Text — нічого не пише
# (пропускає, не зайвий .bak/disk-write). Бекап `.uitxt.bak` створюється
# один раз на кожен файл-донор.
#
# Параметри:
#   -DataDir, -UabeaDir
#   -InFile     : шлях до interface.txt

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$InFile,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DataDir)) { throw "DataDir not found: $DataDir" }
if (-not (Test-Path $UabeaDir)) { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $InFile))   { throw "InFile not found: $InFile" }

# Parse interface.txt. Header `[file:pathId]` на власній лінії, далі текст
# до наступного `[...]` (на власній лінії). Прибираємо trailing newline між
# текстом і наступним header.
$raw = [System.IO.File]::ReadAllText($InFile, [System.Text.Encoding]::UTF8)
$raw = $raw -replace "`r`n", "`n"

$headerRe = [regex]'^\[(?<file>[^\]:]+):(?<pid>\d+)\]\s*$'
$entriesByFile = @{}
$matches = New-Object System.Collections.ArrayList

$lines = $raw -split "`n"
$current = $null
$buf = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $lines.Length; $i++) {
    $ln = $lines[$i]
    $m = $headerRe.Match($ln)
    if ($m.Success) {
        if ($null -ne $current) {
            # Flush попередній block.
            $text = (($buf -join "`n") -replace "(\r?\n)+$", "")
            $current.text = $text
            [void]$matches.Add($current)
        }
        $current = [pscustomobject]@{ file = $m.Groups['file'].Value; pathId = [int64]$m.Groups['pid'].Value; text = "" }
        $buf.Clear() | Out-Null
        continue
    }
    if ($null -eq $current) { continue }   # коментар або preamble
    [void]$buf.Add($ln)
}
if ($null -ne $current) {
    $text = (($buf -join "`n") -replace "(\r?\n)+$", "")
    $current.text = $text
    [void]$matches.Add($current)
}

# Index by file → list of {pathId, text}
foreach ($m in $matches) {
    if (-not $entriesByFile.ContainsKey($m.file)) { $entriesByFile[$m.file] = @() }
    $entriesByFile[$m.file] += @{ pathId = $m.pathId; text = $m.text }
}
Write-Diag "Parsed $($matches.Count) blocks across $($entriesByFile.Count) files"

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

$touchedFiles = @{}
$applied = 0
$skippedSame = 0
$missing = New-Object System.Collections.ArrayList

foreach ($fileName in $entriesByFile.Keys) {
    $fullPath = Join-Path $DataDir $fileName
    if (-not (Test-Path $fullPath)) {
        Write-Warning "  file not found: $fileName — skip $($entriesByFile[$fileName].Count) entries"
        continue
    }
    $inst = $null
    try {
        $inst = $mgr.LoadAssetsFile($fullPath, $false)
        $null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
    } catch { continue }
    $touched = $false
    $byPid = @{}
    foreach ($e in $entriesByFile[$fileName]) { $byPid[[int64]$e.pathId] = [string]$e.text }
    foreach ($ai in $inst.file.AssetInfos) {
        $pid = [int64]$ai.PathId
        if (-not $byPid.ContainsKey($pid)) { continue }
        if ($ai.TypeId -ne 114) { continue }
        $base = $null
        try { $base = $mgr.GetBaseField($inst, $ai) } catch { continue }
        if ($null -eq $base) { continue }
        $txtField = $null
        try { $txtField = $base["m_Text"] } catch {}
        if ($null -eq $txtField -or $txtField.IsDummy) { continue }
        $current = ""
        try { $current = $txtField.AsString } catch {}
        $newText = $byPid[$pid]
        if ($current -eq $newText) { $skippedSame++; continue }
        if (-not $DryRun) {
            try {
                $txtField.AsString = $newText
                $ai.SetNewData($base)
                $touched = $true
            } catch {
                Write-Warning "  apply fail $fileName pid=$pid — $($_.Exception.Message)"
                continue
            }
        }
        $applied++
        $byPid.Remove($pid) | Out-Null
    }
    foreach ($missingPid in $byPid.Keys) {
        [void]$missing.Add([pscustomobject]@{ file = $fileName; pathId = $missingPid })
    }
    if ($touched) { $touchedFiles[$fullPath] = $inst } else { try { $inst.file.Reader.Close() } catch {} }
}

Write-Step ("Applied={0}, skipped (same)={1}, missing-in-assets={2}" -f $applied, $skippedSame, $missing.Count)

if ($DryRun) {
    Write-Step "Dry-run."
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; dryRun = $true; applied = $applied; skippedSame = $skippedSame; missing = $missing.Count } | ConvertTo-Json -Compress))
    exit 0
}

if ($applied -eq 0) {
    try { $mgr.UnloadAllAssetsFiles() } catch {}
    try { $mgr.UnloadAll() } catch {}
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = 0; skippedSame = $skippedSame; missing = $missing.Count } | ConvertTo-Json -Compress))
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

Write-Step "DONE."
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = $applied; skippedSame = $skippedSame; missing = $missing.Count; files = $wrote } | ConvertTo-Json -Compress))
exit 0
