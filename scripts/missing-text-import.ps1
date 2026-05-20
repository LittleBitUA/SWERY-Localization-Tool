# THE MISSING — Text Import.
# Бере Done/<m_Name>-<pathId>.dat (сирий m_Script payload з магіком "MSG.")
# і запихає назад у resources.assets, замінюючи m_Script відповідного
# TextAsset. Зберігає bak-копію.
#
# Параметри:
#   -AssetsPath  : повний шлях до resources.assets
#   -DoneDir     : тека з .dat-файлами після редагування
#   -MetaPath    : missing-meta.json (mapping pathId→file)
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$DoneDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw "resources.assets not found: $AssetsPath" }
if (-not (Test-Path $DoneDir))    { throw "Done dir not found: $DoneDir" }
if (-not (Test-Path $MetaPath))   { throw "Meta file not found: $MetaPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

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

# Read meta (pathId — Int64, але Unity TextAsset PathIDs зазвичай вкладаються
# у безпечну Int53-зону, проте про всяк випадок обертаємо у string як для HBR).
$metaText = [System.IO.File]::ReadAllText($MetaPath, [System.Text.Encoding]::UTF8)
$metaTextSafe = [regex]::Replace($metaText, '"pathId"\s*:\s*(-?\d+)', '"pathId":"$1"')
$meta = $metaTextSafe | ConvertFrom-Json
Write-Diag ("Meta items: {0}" -f $meta.items.Count)

Write-Step "Loading assets..."
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
if ($null -eq $assetsInst) { throw "Failed to load assets" }
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

$applied = 0
$failed = New-Object System.Collections.ArrayList
$iso = [System.Text.Encoding]::GetEncoding("ISO-8859-1")

foreach ($item in $meta.items) {
    $assetPid = [int64]::Parse([string]$item.pathId)
    $doneFile = Join-Path $DoneDir $item.file
    if (-not (Test-Path $doneFile)) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "Done file missing: $doneFile" })
        continue
    }
    $info = $null
    foreach ($ai in $assetsInst.file.AssetInfos) {
        if ([int64]$ai.PathId -eq $assetPid) { $info = $ai; break }
    }
    if ($null -eq $info) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "PathID $assetPid not found" })
        continue
    }
    try {
        $base = $manager.GetBaseField($assetsInst, $info)
        $newBytes = [System.IO.File]::ReadAllBytes($doneFile)
        # Перевірка магіка.
        if ($newBytes.Length -lt 4 -or $newBytes[0] -ne 0x4D -or $newBytes[1] -ne 0x53 -or $newBytes[2] -ne 0x47 -or $newBytes[3] -ne 0x2E) {
            [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "Done file missing MSG. magic" })
            continue
        }
        # Записуємо у m_Script. Спершу AsByteArray, fallback — string через ISO-8859-1.
        $scriptField = $base["m_Script"]
        $written = $false
        try {
            $scriptField.AsByteArray = $newBytes
            $written = $true
        } catch {}
        if (-not $written) {
            try {
                $scriptField.AsString = $iso.GetString($newBytes)
                $written = $true
            } catch {}
        }
        if (-not $written) {
            [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "Cannot write m_Script (AsByteArray + AsString both failed)" })
            continue
        }
        # Серіалізуємо назад у AssetInfo.
        $newAssetBytes = $base.WriteToByteArray()
        $info.SetNewData($newAssetBytes)
        $applied++
        Write-Host ("[PATCHED] {0} (PathID {1}, bytes={2})" -f $item.name, $assetPid, $newBytes.Length)
    } catch {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = $_.Exception.Message })
    }
}

# Write assets back. .bak — копія оригінального файлу (one-shot, не перезаписуємо).
Write-Step "Writing assets..."
$bak = $AssetsPath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $AssetsPath -Destination $bak -Force
    Write-Diag "Backup → $bak"
}

$writeTarget = $AssetsPath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    $assetsInst.file.Write($writer)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}
try { $assetsInst.file.Reader.Close() } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
$assetsInst = $null
$manager = $null
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

# Retry-loop: під Windows handle до файлу може ще тримати або AssetsTools.NET,
# або зовнішній процес (Steam / антивірус). Чекаємо до 5 секунд і повторюємо.
$swapped = $false
for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
        if (Test-Path $AssetsPath) { Remove-Item -LiteralPath $AssetsPath -Force -ErrorAction Stop }
        Move-Item -LiteralPath $writeTarget -Destination $AssetsPath -Force -ErrorAction Stop
        $swapped = $true
        break
    } catch {
        Write-Diag ("swap attempt {0} failed: {1}" -f $attempt, $_.Exception.Message)
        Start-Sleep -Milliseconds 500
    }
}
if (-not $swapped) {
    # Останній шанс — копіювання поверх (працює коли Remove не може).
    try {
        Copy-Item -LiteralPath $writeTarget -Destination $AssetsPath -Force
        Remove-Item -LiteralPath $writeTarget -Force -ErrorAction SilentlyContinue
        $swapped = $true
    } catch {
        throw "Не вдалося замінити resources.assets після 10 спроб: $($_.Exception.Message). Закрий Steam / гру / антивірус і спробуй ще раз. tmp-файл: $writeTarget"
    }
}
$outSize = (Get-Item $AssetsPath).Length
$bakSize = (Get-Item $bak).Length
Write-Step ("DONE → {0} ({1:N0} bytes; .bak {2:N0} bytes), applied {3}, failed {4}" -f $AssetsPath, $outSize, $bakSize, $applied, $failed.Count)

$summary = [pscustomobject]@{
    ok = $true; assets = $AssetsPath; size = $outSize; bakSize = $bakSize
    applied = $applied; failed = $failed.ToArray()
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
