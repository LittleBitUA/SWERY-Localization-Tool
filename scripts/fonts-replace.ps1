# DP2 Fonts Replace — підмінює `m_FontData` одного Font-ассета (за PathID)
# на байти нового .ttf/.otf, потім перепаковує sharedassets0.assets з .bak.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [Int64]$PathId,
    [Parameter(Mandatory=$true)] [string]$NewFontFile,
    [Parameter(Mandatory=$true)] [string]$OutputPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath))   { throw ".assets not found: $AssetsPath" }
if (-not (Test-Path $NewFontFile))  { throw "New font file not found: $NewFontFile" }
if (-not (Test-Path $UabeaDir))     { throw "UABEA dir not found: $UabeaDir" }

$dllPath = Join-Path $UabeaDir "AssetsTools.NET.dll"
$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$cecilPath   = Join-Path $UabeaDir "Mono.Cecil.dll"
$libCpp2IL   = Join-Path $UabeaDir "LibCpp2IL.dll"
$monoExtPath = Join-Path $UabeaDir "AssetsTools.NET.MonoCecil.dll"
$cppExtPath  = Join-Path $UabeaDir "AssetsTools.NET.Cpp2IL.dll"
if (Test-Path $cecilPath)   { $null = [System.Reflection.Assembly]::LoadFrom($cecilPath) }
if (Test-Path $libCpp2IL)   { $null = [System.Reflection.Assembly]::LoadFrom($libCpp2IL) }
Add-Type -Path $dllPath
if (Test-Path $monoExtPath) { $null = [System.Reflection.Assembly]::LoadFrom($monoExtPath) }
if (Test-Path $cppExtPath)  { $null = [System.Reflection.Assembly]::LoadFrom($cppExtPath) }

Write-Step "Loading $AssetsPath ..."
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

# Find the asset
$target = $null
foreach ($info in $assetsInst.file.AssetInfos) {
    if ([Int64]$info.PathId -eq $PathId) { $target = $info; break }
}
if ($null -eq $target) { throw "PathID $PathId not found in $AssetsPath" }
if ($target.TypeId -ne 128) { throw "PathID $PathId is not a Font asset (TypeId=$($target.TypeId))" }

$base = $manager.GetBaseField($assetsInst, $target)
$nameField = $base["m_Name"]
$fontName = $nameField.AsString
Write-Diag "Replacing: $fontName (PathID $PathId)"

$newBytes = [System.IO.File]::ReadAllBytes($NewFontFile)
Write-Diag ("New font size: {0:N0} bytes" -f $newBytes.Length)

$dataField = $base["m_FontData"]
if ($null -eq $dataField) { throw "m_FontData field missing on font $fontName" }

# m_FontData у Unity — це vector<UInt8>, тобто {Array: [byte, byte, ...]}.
# Правильно записувати на inner ["Array"], а НЕ на сам dataField. У старому
# порядку спочатку спрацював fallback AssetTypeValue(ByteArray) на зовнішнє
# поле — це могло записати raw bytes у неправильне місце.
$replaced = $false

# Спроба 1: inner Array.AsByteArray — це канонічний шлях для vector<UInt8>.
$arrayField = $null
try { $arrayField = $dataField["Array"] } catch {}
if ($null -ne $arrayField) {
    try {
        $arrayField.AsByteArray = $newBytes
        $replaced = $true
        Write-Diag "Set via inner Array.AsByteArray (canonical)"
    } catch {
        Write-Diag "Array.AsByteArray set failed: $($_.Exception.Message)"
    }
}

# Спроба 2: outer AsByteArray — деякі версії API підтримують і її.
if (-not $replaced) {
    try {
        $dataField.AsByteArray = $newBytes
        $replaced = $true
        Write-Diag "Set via outer AsByteArray"
    } catch {
        Write-Diag "Outer AsByteArray set failed: $($_.Exception.Message)"
    }
}

# Спроба 3: AssetTypeValue ByteArray на inner Array (НЕ на outer field).
if (-not $replaced -and $null -ne $arrayField) {
    try {
        $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::ByteArray, $newBytes)
        $arrayField.Value = $atv
        $replaced = $true
        Write-Diag "Set via inner Array.Value=AssetTypeValue(ByteArray)"
    } catch {
        Write-Diag "Array.Value=AssetTypeValue failed: $($_.Exception.Message)"
    }
}

# Спроба 4 (last resort): AssetTypeValue на outer dataField — може писати
# не в той слот, але краще ніж абсолютна відмова.
if (-not $replaced) {
    try {
        $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::ByteArray, $newBytes)
        $dataField.Value = $atv
        $replaced = $true
        Write-Diag "WARN: Set via outer Value=AssetTypeValue(ByteArray) — fallback, може спрацювати некоректно"
    } catch {
        Write-Diag "Outer Value=AssetTypeValue failed: $($_.Exception.Message)"
    }
}

if (-not $replaced) {
    throw "Failed to set m_FontData bytes (API mismatch). New font NOT applied."
}

$target.SetNewData($base)
Write-Step "Font data replaced in memory"

# Write the modified .assets (in-place pattern from import-to-assets.ps1)
$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$normSrc = [System.IO.Path]::GetFullPath($AssetsPath)
$normDst = [System.IO.Path]::GetFullPath($OutputPath)
$inPlace = ($normSrc -ieq $normDst)
$writeTarget = if ($inPlace) { $OutputPath + ".tmp" } else { $OutputPath }

Write-Step "Writing $writeTarget ..."
Write-Diag ("  in-place: {0}, source: {1}, target: {2}" -f $inPlace, $AssetsPath, $writeTarget)
$writer = $null
try {
    Write-Diag "  creating AssetsFileWriter..."
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    Write-Diag "  AssetsFileWriter ready, invoking file.Write(writer, 0)..."
    $assetsInst.file.Write($writer, 0)
    Write-Diag "  file.Write returned without exception"
} catch {
    Write-Diag ("  WRITE FAILED: {0}" -f $_.Exception.Message)
    throw
} finally {
    if ($null -ne $writer) {
        try { $writer.Close(); Write-Diag "  writer closed" }
        catch { Write-Diag ("  writer close threw: {0}" -f $_.Exception.Message) }
    }
}

if (Test-Path $writeTarget) {
    $tmpSize = (Get-Item $writeTarget).Length
    Write-Diag ("  tmp file written: {0:N0} bytes at {1}" -f $tmpSize, $writeTarget)
} else {
    Write-Warning "Tmp file is missing after write: $writeTarget"
}

if ($inPlace) {
    Write-Step "In-place mode: releasing handles and swapping files"
    try { $assetsInst.file.Reader.Close(); Write-Diag "  reader closed" } catch { Write-Diag ("  reader close failed: {0}" -f $_.Exception.Message) }
    try { $manager.UnloadAllAssetsFiles(); Write-Diag "  manager.UnloadAllAssetsFiles()" } catch { Write-Diag ("  UnloadAllAssetsFiles failed: {0}" -f $_.Exception.Message) }
    try { $manager.UnloadAll(); Write-Diag "  manager.UnloadAll()" } catch { Write-Diag ("  UnloadAll failed: {0}" -f $_.Exception.Message) }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    Write-Diag "  GC collected"

    $bakPath = $AssetsPath + ".bak"
    if (-not (Test-Path $bakPath)) {
        try {
            Copy-Item -LiteralPath $AssetsPath -Destination $bakPath -Force
            Write-Diag "  backup created: $bakPath"
        } catch {
            Write-Diag ("  backup failed: {0}" -f $_.Exception.Message)
            throw
        }
    } else {
        Write-Diag "  backup already exists, keeping: $bakPath"
    }

    try {
        Move-Item -LiteralPath $writeTarget -Destination $OutputPath -Force
        Write-Diag "  moved tmp → $OutputPath"
    } catch {
        Write-Diag ("  MOVE FAILED: {0}" -f $_.Exception.Message)
        Write-Diag "  файл .tmp залишається на диску — спробуй перейменувати вручну"
        throw
    }
}

if (-not (Test-Path $OutputPath)) {
    throw "Output file is missing: $OutputPath"
}
$outSize = (Get-Item $OutputPath).Length
Write-Step ("DONE -> {0} ({1:N0} bytes)" -f $OutputPath, $outSize)
exit 0
