# THE MISSING — Експорт UI.Text MonoBehaviour-ів у interface.txt.
#
# Витягує всі UI.Text компоненти з полем m_Text (Unity-стандартний UI.Text +
# нащадки типу TextEx). Фільтр AsciiOnly відсікає JP/CN тексти, які є
# runtime-placeholder'ами для msg.dat (їх перекладати не треба — це шкодить
# грі). За замовч. лишає тільки EN ASCII строки які реально показуються
# в UI (YES, NO, OPTION, CHAPTER SELECT тощо).
#
# Формат interface.txt:
#   # Заголовок-коментар
#
#   [<file>:<pathId>]
#   <m_Text у одну або багато ліній — до наступного `[...]` заголовку>
#
# Параметри:
#   -DataDir, -UabeaDir, -OutFile
#   -AsciiOnly        : фільтрувати JP/CN (default $true)
#   -MinLength        : мін. длина text для включення (default 1)
#   -MaxLength        : макс. длина для включення (default 200)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DataDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$OutFile,
    [switch]$IncludeNonAscii,
    [int]$MinLength = 1,
    [int]$MaxLength = 200
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

Write-Step "Exporting UI.Text → $OutFile (asciiOnly=$([bool](-not $IncludeNonAscii)))..."

# ASCII-литери / common punct / digits. Якщо рядок містить будь-який символ
# поза цим діапазоном — він НЕ ascii (JP/CN/UA-cyrillic).
$asciiRe = [regex]'^[\x09\x0A\x0D\x20-\x7E]+$'

$entries = New-Object System.Collections.ArrayList

foreach ($f in $assetsFiles) {
    $inst = $null
    try {
        $inst = $mgr.LoadAssetsFile($f.FullName, $false)
        $null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
    } catch { continue }
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
        if ($text.Length -lt $MinLength -or $text.Length -gt $MaxLength) { continue }
        if (-not $IncludeNonAscii) {
            if (-not $asciiRe.IsMatch($text)) { continue }
        }
        [void]$entries.Add([pscustomobject]@{
            file = $f.Name
            pathId = [int64]$ai.PathId
            text = $text
        })
    }
    try { $inst.file.Reader.Close() } catch {}
}
try { $mgr.UnloadAllAssetsFiles() } catch {}
try { $mgr.UnloadAll() } catch {}

# Stable sort: by file then pathId.
$sorted = $entries | Sort-Object file, pathId

# Write interface.txt — заголовок-коментар + блоки `[file:pathId]\ntext`.
$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# THE MISSING — Interface UI Text export")
[void]$lines.Add("# Кожен блок: `[file:pathId]` + текст під ним до наступного `[...]`.")
[void]$lines.Add("# Не міняй `[...]` заголовки — за ними import знаходить позиції у .assets.")
[void]$lines.Add("# Перекладай тільки сам текст. Багатолінійні значення зберігаються байт-у-байт.")
[void]$lines.Add("")
foreach ($e in $sorted) {
    [void]$lines.Add(("[{0}:{1}]" -f $e.file, $e.pathId))
    [void]$lines.Add($e.text)
    [void]$lines.Add("")
}

$dir = Split-Path $OutFile -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($OutFile, ($lines -join "`r`n"), [System.Text.UTF8Encoding]::new($false))

Write-Step ("DONE — exported {0} entries to {1}" -f $sorted.Count, $OutFile)
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; entries = $sorted.Count; outFile = $OutFile } | ConvertTo-Json -Compress))
exit 0
