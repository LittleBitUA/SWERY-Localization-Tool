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

# Спроба 1: AsByteArray (швидко, типове API v3 для vector<UInt8>)
$replaced = $false
try {
    $dataField.AsByteArray = $newBytes
    $replaced = $true
    Write-Diag "Set via AsByteArray"
} catch {
    Write-Diag "AsByteArray set failed: $($_.Exception.Message)"
}

# Спроба 2: replace inner Array via AssetTypeValue (TypelessData-style)
if (-not $replaced) {
    try {
        $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::ByteArray, $newBytes)
        $dataField.Value = $atv
        $replaced = $true
        Write-Diag "Set via AssetTypeValue(ByteArray)"
    } catch {
        Write-Diag "Value=AssetTypeValue(ByteArray) failed: $($_.Exception.Message)"
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
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    $assetsInst.file.Write($writer, 0)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}

if ($inPlace) {
    try { $assetsInst.file.Reader.Close() } catch {}
    try { $manager.UnloadAllAssetsFiles() } catch {}
    try { $manager.UnloadAll() } catch {}
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()

    $bakPath = $AssetsPath + ".bak"
    if (-not (Test-Path $bakPath)) {
        Copy-Item -LiteralPath $AssetsPath -Destination $bakPath -Force
        Write-Diag "Backup created: $bakPath"
    } else {
        Write-Diag "Backup already exists, keeping: $bakPath"
    }

    Move-Item -LiteralPath $writeTarget -Destination $OutputPath -Force
}

$outSize = (Get-Item $OutputPath).Length
Write-Step ("DONE -> {0} ({1:N0} bytes)" -f $OutputPath, $outSize)
exit 0
