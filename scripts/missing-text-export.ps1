# THE MISSING — Text Export.
# Витягає всі TextAssets (TypeId=49) з resources.assets, ім'я m_Name яких
# збігається з pattern'ом `msg\d{4}en`. Дамп — це СИРИЙ m_Script payload
# (custom binary з магіком "MSG."), без Unity-wrap. Наш JS-парсер
# (src/games/missing/parser.ts) знає обидва формати (з wrap'ом і без) і
# автоматично визначає за магіком.
#
# Параметри:
#   -AssetsPath  : повний шлях до resources.assets (TheMISSING_Data\resources.assets)
#   -OutDir      : куди писати <m_Name>-<pathId>.dat
#   -MetaPath    : куди писати missing-meta.json (mapping для re-pack)
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw "resources.assets not found: $AssetsPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$metaDir = Split-Path -Parent $MetaPath
if ($metaDir -and -not (Test-Path $metaDir)) { New-Item -ItemType Directory -Path $metaDir -Force | Out-Null }

# Load AssetsTools.NET DLLs.
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

Write-Step "Loading assets: $AssetsPath"
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
if ($null -eq $assetsInst) { throw "Failed to load assets" }
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)
Write-Diag ("AssetInfos count: {0}" -f $assetsInst.file.AssetInfos.Count)

# TextAsset TypeId — 49 у Unity. m_Name + m_Script (string).
$totalExported = 0
$failed = New-Object System.Collections.ArrayList
$metaList = New-Object System.Collections.ArrayList
$nameRe = [regex]'^msg\d{4}en$'

foreach ($ai in $assetsInst.file.AssetInfos) {
    if ($ai.TypeId -ne 49) { continue }
    try {
        $base = $manager.GetBaseField($assetsInst, $ai)
        $name = ""
        try { $name = $base["m_Name"].AsString } catch {}
        if (-not $nameRe.IsMatch($name)) { continue }

        # m_Script — це string, але всередині binary (UTF-8 не валідний у
        # деяких байтах). AssetsTools повертає його як AsString — для більшості
        # випадків це OK, бо UABEA Next саме так читає. Якщо побачимо проблеми
        # на рівні бінарних байт > 0x7F — переключимось на AsByteArray.
        $scriptBytes = $null
        try {
            $scriptField = $base["m_Script"]
            # Спочатку пробуємо AsByteArray (доступний у новіших AssetsTools).
            try {
                $arr = $scriptField.AsByteArray
                if ($arr -ne $null -and $arr.Length -gt 0) { $scriptBytes = $arr }
            } catch {}
            if ($null -eq $scriptBytes) {
                # Fallback: трактуємо як latin-1 (1:1 байт→char), бо string у
                # Unity TextAsset може містити байти > 0x7F які UTF-8 не парсить.
                $s = $scriptField.AsString
                $iso = [System.Text.Encoding]::GetEncoding("ISO-8859-1")
                $scriptBytes = $iso.GetBytes($s)
            }
        } catch {
            [void]$failed.Add([pscustomobject]@{ name = $name; pathId = $ai.PathId; reason = "read m_Script: $($_.Exception.Message)" })
            continue
        }
        if ($null -eq $scriptBytes -or $scriptBytes.Length -lt 4) {
            [void]$failed.Add([pscustomobject]@{ name = $name; pathId = $ai.PathId; reason = "m_Script empty" })
            continue
        }
        # Перевірка магіка "MSG."
        if (-not ($scriptBytes[0] -eq 0x4D -and $scriptBytes[1] -eq 0x53 -and $scriptBytes[2] -eq 0x47 -and $scriptBytes[3] -eq 0x2E)) {
            [void]$failed.Add([pscustomobject]@{ name = $name; pathId = $ai.PathId; reason = "missing MSG. magic (first 4 bytes: $($scriptBytes[0..3] -join ','))" })
            continue
        }

        $outFile = Join-Path $OutDir ("{0}-{1}.dat" -f $name, $ai.PathId)
        [System.IO.File]::WriteAllBytes($outFile, $scriptBytes)
        $totalExported++

        [void]$metaList.Add([pscustomobject]@{
            name      = $name
            file      = [System.IO.Path]::GetFileName($outFile)
            pathId    = $ai.PathId
            typeId    = 49
            scriptLen = $scriptBytes.Length
        })

        if ($totalExported % 5 -eq 0) {
            Write-Diag ("Exported {0} files so far" -f $totalExported)
        }
    } catch {
        [void]$failed.Add([pscustomobject]@{ name = "?"; pathId = $ai.PathId; reason = $_.Exception.Message })
    }
}

# Записуємо meta.
$meta = [pscustomobject]@{
    assets       = [System.IO.Path]::GetFileName($AssetsPath)
    unityVersion = $assetsInst.file.Metadata.UnityVersion
    exportedAt   = (Get-Date).ToString("o")
    items        = $metaList.ToArray()
    failed       = $failed.ToArray()
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($MetaPath, ($meta | ConvertTo-Json -Depth 5), $utf8NoBom)

try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}

Write-Step ("DONE: exported {0} TextAssets to {1}" -f $totalExported, $OutDir)
$summary = [pscustomobject]@{
    ok          = $true
    total       = $totalExported
    failed      = $failed.Count
    outDir      = $OutDir
    metaPath    = $MetaPath
}
Write-Host ("RESULT_JSON: {0}" -f ($summary | ConvertTo-Json -Compress))
exit 0
