# DP2 Localization - One-click .assets builder (with diagnostics)
# ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI/cp1251.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$JsonDir,
    [Parameter(Mandatory=$true)] [string]$OutputPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

# -- Validate paths --
if (-not (Test-Path $AssetsPath)) { throw ".assets file not found: $AssetsPath" }
if (-not (Test-Path $JsonDir))    { throw "JSON dir not found: $JsonDir" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

$dllPath = Join-Path $UabeaDir "AssetsTools.NET.dll"
$tpkPath = Join-Path $UabeaDir "classdata.tpk"
if (-not (Test-Path $dllPath)) { throw "AssetsTools.NET.dll not found at $dllPath" }
if (-not (Test-Path $tpkPath)) { throw "classdata.tpk not found at $tpkPath" }

Write-Step "Loading AssetsTools.NET..."
# Load deps in proper order: Mono.Cecil + LibCpp2IL first, then AssetsTools.NET,
# then both extension DLLs (MonoCecil for Mono games, Cpp2IL for IL2CPP games).
# DP2 is IL2CPP --we need Cpp2IlTempGenerator to read MonoBehaviour layouts.
$cecilPath   = Join-Path $UabeaDir "Mono.Cecil.dll"
$libCpp2IL   = Join-Path $UabeaDir "LibCpp2IL.dll"
$monoExtPath = Join-Path $UabeaDir "AssetsTools.NET.MonoCecil.dll"
$cppExtPath  = Join-Path $UabeaDir "AssetsTools.NET.Cpp2IL.dll"
if (Test-Path $cecilPath)   { $null = [System.Reflection.Assembly]::LoadFrom($cecilPath) }
if (Test-Path $libCpp2IL)   { $null = [System.Reflection.Assembly]::LoadFrom($libCpp2IL) }
Add-Type -Path $dllPath
if (Test-Path $monoExtPath) { $null = [System.Reflection.Assembly]::LoadFrom($monoExtPath) }
if (Test-Path $cppExtPath)  { $null = [System.Reflection.Assembly]::LoadFrom($cppExtPath) }

# Diagnose AssetsTools.NET version + key types
$attTypes = [System.AppDomain]::CurrentDomain.GetAssemblies() |
    Where-Object { $_.GetName().Name -eq "AssetsTools.NET" }
if ($attTypes) {
    $ver = $attTypes[0].GetName().Version
    Write-Diag "AssetsTools.NET version: $ver"
}

$valueFieldType = [AssetsTools.NET.AssetTypeValueField]
Write-Diag "AssetTypeValueField type loaded"

# Discover what string accessor exists on the field
$asStringProp = $valueFieldType.GetProperty("AsString")
$valueProp = $valueFieldType.GetProperty("Value")
Write-Diag "AsString property: $($null -ne $asStringProp), settable: $($null -ne $asStringProp -and $asStringProp.CanWrite)"
Write-Diag "Value property: $($null -ne $valueProp)"

Write-Step "Reading $AssetsPath ..."
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)

$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

Write-Diag "Unity version: $($assetsInst.file.Metadata.UnityVersion)"
Write-Diag "Total AssetInfos: $(@($assetsInst.file.AssetInfos).Count)"

# -- MonoBehaviour template generator: detect Mono vs IL2CPP and pick generator.
#    Without this, GetBaseField() returns only base MonoBehaviour fields
#    (m_GameObject, m_Enabled, m_Script, m_Name) --no script-specific data.
$dataDir = Split-Path -Parent $AssetsPath
$managedDir = Join-Path $dataDir "Managed"
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
$unityVersion = $assetsInst.file.Metadata.UnityVersion

$genReady = $false

if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    Write-Diag "Detected IL2CPP runtime"
    Write-Diag ("  metadata: {0}" -f $il2cppMeta)
    Write-Diag ("  assembly: {0}" -f $gameAssembly)
    try {
        # Constructor: (string globalMetadataPath, string assemblyPath)
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator initialized."
        $genReady = $true
    } catch {
        $inner = $_.Exception
        $depth = 0
        while ($null -ne $inner -and $depth -lt 5) {
            Write-Warning ("Cpp2IL ctor failed [{0}]: {1} ({2})" -f $depth, $inner.Message, $inner.GetType().FullName)
            $inner = $inner.InnerException
            $depth++
        }
    }
}

if (-not $genReady -and (Test-Path $managedDir)) {
    try {
        $monoGen = New-Object AssetsTools.NET.MonoCecil.MonoCecilTempGenerator($managedDir)
        $manager.MonoTempGenerator = $monoGen
        Write-Diag "MonoCecilTempGenerator initialized: $managedDir"
        $genReady = $true
    } catch {
        Write-Warning "Failed to init MonoCecilTempGenerator: $($_.Exception.Message)"
    }
}

if (-not $genReady) {
    Write-Warning "No MonoBehaviour template generator available --script-specific fields won't be readable."
}

# -- Build PathID -> JSON map --
Write-Step "Indexing JSON dumps in $JsonDir ..."
$jsonByPathId = @{}
$jsonFiles = Get-ChildItem -Path $JsonDir -Filter "*.json" -File -Recurse |
             Where-Object { $_.Name -notmatch '\.bak\.json$' }

foreach ($jf in $jsonFiles) {
    if ($jf.Name -match '-(\d+)\.json$') {
        [int64]$assetPid = $Matches[1]
        $jsonByPathId[$assetPid] = $jf.FullName
    }
}
Write-Host ("Found {0} JSON dumps with PathID." -f $jsonByPathId.Count)
if ($jsonByPathId.Count -eq 0) {
    throw "No JSON files matched pattern '*-<PathID>.json' in $JsonDir"
}

# -- Helpers --
# IMPORTANT: AssetTypeValueField in AssetsTools.NET v3 implements
# IEnumerable<AssetTypeValueField> (enumerates Children). PowerShell auto-
# enumerates IEnumerable returns from functions, which means `return $field`
# outputs the field's Children, not the field itself.
# To return a SINGLE field intact, use `Write-Output $field -NoEnumerate`
# (followed by an empty `return`).

function Get-Child {
    param($Field, [string]$Name)
    if ($null -eq $Field) { return }

    # 1. Indexer (canonical AssetsTools.NET v3 API)
    try {
        $r = $Field[$Name]
        if ($null -ne $r) {
            $isDummy = $false
            try { $isDummy = [bool]$r.IsDummy } catch {}
            if (-not $isDummy) {
                Write-Output $r -NoEnumerate
                return
            }
        }
    } catch {}

    # 2. Fallback iteration
    $children = $null
    try { $children = $Field.Children } catch {}
    if ($null -eq $children) { return }
    foreach ($c in $children) {
        $cname = $null
        try { $cname = [string]$c.FieldName } catch {}
        $tname = $null
        try { $tname = [string]$c.TemplateField.Name } catch {}
        if ($cname -eq $Name -or $tname -eq $Name) {
            Write-Output $c -NoEnumerate
            return
        }
    }
}

function Set-StringField {
    param($Field, $Value, [ref]$WriteCount, [ref]$LastError)
    if ($null -eq $Field) { return $false }
    if ($null -eq $Value) { return $false }
    $strValue = [string]$Value
    try {
        $Field.AsString = $strValue
        $WriteCount.Value++
        return $true
    } catch {
        $LastError.Value = "AsString set: " + $_.Exception.Message
    }
    # Fallback: assign Value directly via AssetTypeValue
    try {
        $atv = New-Object AssetsTools.NET.AssetTypeValue([AssetsTools.NET.AssetValueType]::String, $strValue)
        $Field.Value = $atv
        $WriteCount.Value++
        return $true
    } catch {
        $LastError.Value = "Value=AssetTypeValue: " + $_.Exception.Message
    }
    return $false
}

# Диагностика: рекурсивно дампить дерево полей до глубины N
$script:dumpDepth = 0
function Write-FieldTree {
    param($Field, [int]$MaxDepth = 4, [int]$Depth = 0, [string]$Prefix = "")
    if ($null -eq $Field) { Write-Diag "${Prefix}<null>"; return }
    if ($Depth -ge $MaxDepth) { return }
    $children = $null
    try { $children = $Field.Children } catch {}
    if ($null -eq $children) { return }
    foreach ($c in $children) {
        $name = $null
        try { $name = $c.FieldName } catch {}
        if (-not $name) { try { $name = $c.TemplateField.Name } catch {} }
        $type = $null
        try { $type = $c.TemplateField.Type } catch {}
        $cnt = 0
        try { $cnt = @($c.Children).Count } catch {}
        Write-Diag ("{0}{1}{2} [{3}, children={4}]" -f $Prefix, ('  ' * $Depth), $name, $type, $cnt)
        if ($Depth + 1 -lt $MaxDepth) {
            Write-FieldTree -Field $c -MaxDepth $MaxDepth -Depth ($Depth + 1) -Prefix $Prefix
        }
    }
}

# Bulletproof counter -- PowerShell .Count/.Length sometimes returns
# arrays via member-access enumeration on PSCustomObjects from ConvertFrom-Json.
# Manual foreach iteration always returns int.
function Get-Count {
    param($Value)
    if ($null -eq $Value) { return 0 }
    $n = 0
    foreach ($x in $Value) { $n++ }
    return $n
}

# Для array/vector поля повертає елементи: спочатку шукає підполе "Array"
# (стандартна Unity vector-обгортка), якщо нема -- бере Children напряму.
# Comma operator (,) prevents PowerShell from unwrapping single-element
# arrays at return (otherwise foreach inside caller iterates fields' Children).
function Get-ArrayItems {
    param($Field)
    if ($null -eq $Field) { return ,@() }
    $src = $null
    $arrayChild = Get-Child $Field "Array"
    if ($null -ne $arrayChild) {
        $src = $arrayChild.Children
    } else {
        $src = $Field.Children
    }
    $arr = New-Object 'System.Collections.Generic.List[object]'
    foreach ($x in $src) { $null = $arr.Add($x) }
    return ,$arr.ToArray()
}

function Invoke-EditApply {
    param($BaseField, $JsonObj, [ref]$WriteCount, [ref]$LastError, [bool]$Verbose = $false)
    $touched = 0

    $sheetsField = Get-Child $BaseField "m_sheets"
    if ($null -eq $sheetsField) {
        if ($Verbose) { Write-Diag "  no m_sheets" }
        return 0
    }
    $sheetItems = Get-ArrayItems $sheetsField
    if ($Verbose) { Write-Diag ("  sheet items count: {0}" -f $sheetItems.Count) }

    $sheetsJson = $JsonObj.m_sheets.Array
    if ($null -eq $sheetsJson) {
        if ($Verbose) { Write-Diag "  JSON.m_sheets.Array is null" }
        return 0
    }
    $jsonSheetCnt = Get-Count $sheetsJson
    $sheetItemCnt = Get-Count $sheetItems
    if ($Verbose) { Write-Diag ("  json sheets count: {0}, field items count: {1}" -f $jsonSheetCnt, $sheetItemCnt) }

    $nSheets = [Math]::Min($sheetItemCnt, $jsonSheetCnt)
    for ($i = 0; $i -lt $nSheets; $i++) {
        $sheetField = $sheetItems[$i]
        $sheetJson  = $sheetsJson[$i]

        $listField = Get-Child $sheetField "m_list"
        $listItems = Get-ArrayItems $listField
        if ($Verbose -and $i -eq 0) {
            Write-Diag ("  sheet[0] list items count: {0}" -f $listItems.Count)
        }
        $listJson = $sheetJson.m_list.Array
        if ($null -eq $listJson) { continue }

        $jsonListCnt = Get-Count $listJson
        $listItemCnt = Get-Count $listItems
        $nList = [Math]::Min($listItemCnt, $jsonListCnt)
        for ($j = 0; $j -lt $nList; $j++) {
            $itemField = $listItems[$j]
            $itemJson  = $listJson[$j]

            # Sentence schema (SideQuest, Cutscene)
            $scenarioListField = Get-Child $itemField "m_scenarioList"
            if ($null -ne $scenarioListField) {
                $scenItems = Get-ArrayItems $scenarioListField
                $scensJson = $itemJson.m_scenarioList.Array
                if ($null -ne $scensJson) {
                    if ($Verbose -and $j -eq 0) {
                        Write-Diag ("  list[0] scen items: {0} / json: {1}" -f $scenItems.Count, @($scensJson).Count)
                    }
                    $jsonScenCnt = Get-Count $scensJson
                    $scenItemCnt = Get-Count $scenItems
                    $nScen = [Math]::Min($scenItemCnt, $jsonScenCnt)
                    for ($k = 0; $k -lt $nScen; $k++) {
                        $scenField = $scenItems[$k]
                        $scenJson  = $scensJson[$k]

                        $sentField = Get-Child $scenField "m_sentences"
                        $sentItems = Get-ArrayItems $sentField
                        $sentsJson = $scenJson.m_sentences.Array
                        if ($null -eq $sentsJson) { continue }
                        if ($Verbose -and $j -eq 0 -and $k -eq 0) {
                            $sCntDiag = Get-Count $sentItems
                            $sJsonCnt = Get-Count $sentsJson
                            Write-Diag ("  scen[0] sentences: {0} / json: {1}" -f $sCntDiag, $sJsonCnt)
                            if ($sCntDiag -gt 0) {
                                $first = $sentItems[0]
                                Write-Diag "    FIRST SENTENCE STRUCTURE:"
                                Write-FieldTree -Field $first -MaxDepth 4 -Prefix "      "
                            }
                        }

                        $jsonSentCnt = Get-Count $sentsJson
                        $sentItemCnt = Get-Count $sentItems
                        $nSents = [Math]::Min($sentItemCnt, $jsonSentCnt)
                        for ($s = 0; $s -lt $nSents; $s++) {
                            $sField = $sentItems[$s]
                            $sJson  = $sentsJson[$s]

                            if ($Verbose -and $j -eq 0 -and $k -eq 0 -and $s -le 1) {
                                $charaJ = $null
                                $serifJ = $null
                                if ($null -ne $sJson) {
                                    $charaJ = $sJson.m_charaName
                                    $serifJ = $sJson.m_serif
                                }
                                $charaF = Get-Child $sField "m_charaName"
                                $serifF = Get-Child $sField "m_serif"
                                $charaJStr = if ($null -eq $charaJ) { "<null>" } else { [string]$charaJ }
                                $serifLen = 0
                                if ($null -ne $serifJ) { $serifLen = ([string]$serifJ).Length }
                                Write-Diag ("      sent[{0}] charaJ='{1}' (null:{2}) serifJ len={3} (null:{4}) charaField:{5} serifField:{6}" -f `
                                    $s, $charaJStr, ($null -eq $charaJ), $serifLen, ($null -eq $serifJ), `
                                    ($null -ne $charaF), ($null -ne $serifF))
                            }

                            $null = Set-StringField (Get-Child $sField "m_charaName") $sJson.m_charaName $WriteCount $LastError
                            $null = Set-StringField (Get-Child $sField "m_serif")     $sJson.m_serif     $WriteCount $LastError
                            $touched++
                        }
                    }
                }
                continue
            }

            # Display schema (Item, UI strings)
            $textField = Get-Child $itemField "m_text"
            if ($null -ne $textField) {
                $textItems = Get-ArrayItems $textField
                $textJson = $itemJson.m_text.Array
                if ($null -ne $textJson) {
                    $jsonTextCnt = Get-Count $textJson
                    $textItemCnt = Get-Count $textItems
                    $nText = [Math]::Min($textItemCnt, $jsonTextCnt)
                    for ($s = 0; $s -lt $nText; $s++) {
                        $null = Set-StringField $textItems[$s] $textJson[$s] $WriteCount $LastError
                        $touched++
                    }
                }
            }
        }
    }

    return $touched
}

# -- Iterate MonoBehaviours and import matching JSON --
Write-Step "Importing translated dumps..."
$importedFiles = 0
$totalTouched = 0
$totalWrites = 0
$skipped = 0
$errors = 0
$lastErr = ""

$totalToProcess = 0
foreach ($info in $assetsInst.file.AssetInfos) {
    if ($jsonByPathId.ContainsKey([int64]$info.PathId)) { $totalToProcess++ }
}
Write-Diag "Files to process: $totalToProcess"

# Diagnostic: log first matched MonoBehaviour in detail
$firstLogged = $false

$processed = 0
foreach ($info in $assetsInst.file.AssetInfos) {
    $assetPid = [int64]$info.PathId
    if (-not $jsonByPathId.ContainsKey($assetPid)) { continue }

    $processed++
    $jsonFile = $jsonByPathId[$assetPid]
    try {
        $jsonText = [System.IO.File]::ReadAllText($jsonFile, [System.Text.Encoding]::UTF8)
        # ConvertFrom-Json in PS 5.1 doesn't support -Depth; the default
        # depth is high enough for DP2 nested structures. PS 7+ supports
        # -Depth, but we conditionally pass it only when available.
        $cmd = Get-Command ConvertFrom-Json
        if ($cmd.Parameters.ContainsKey("Depth")) {
            $jsonObj = $jsonText | ConvertFrom-Json -Depth 200
        } else {
            $jsonObj = $jsonText | ConvertFrom-Json
        }
        $baseField = $manager.GetBaseField($assetsInst, $info)
        if ($null -eq $baseField) { $skipped++; continue }

        if (-not $firstLogged) {
            Write-Diag "First MonoBehaviour PathID=$assetPid (file: $($jsonFile | Split-Path -Leaf))"
            $rootChildren = @()
            try { $rootChildren = @($baseField.Children) } catch {}
            $names = ($rootChildren | ForEach-Object {
                $n = $null
                try { $n = $_.FieldName } catch {}
                if (-not $n) { try { $n = $_.TemplateField.Name } catch {} }
                $n
            })
            Write-Diag "  Root children: $($names -join ', ')"
            # Try to read m_Name to confirm we can read strings
            $mNameField = Get-Child $baseField "m_Name"
            if ($null -ne $mNameField) {
                $mNameVal = $null
                try { $mNameVal = $mNameField.AsString } catch {}
                Write-Diag "  m_Name (read): $mNameVal"
            }
            $firstLogged = $true
        }

        $writeCntRef = [ref]0
        $errRef = [ref]""
        $verbose = ($processed -eq 1)
        if ($verbose) {
            Write-Diag "FULL TREE OF FIRST MB:"
            Write-FieldTree -Field $baseField -MaxDepth 5 -Prefix "  "
        }
        $touched = Invoke-EditApply $baseField $jsonObj $writeCntRef $errRef $verbose
        $thisWrites = $writeCntRef.Value
        if ($errRef.Value) { $lastErr = $errRef.Value }

        if ($thisWrites -gt 0) {
            $info.SetNewData($baseField)
            $importedFiles++
            $totalTouched += $touched
            $totalWrites += $thisWrites
        } else {
            $skipped++
            if ($skipped -le 3) {
                Write-Diag ("PathID={0}: 0 writes (touched fields={1}). Last err: {2}" -f $assetPid, $touched, $errRef.Value)
            }
        }
    } catch {
        $errors++
        Write-Warning ("PathID={0} {1} : {2}" -f $assetPid, ($jsonFile | Split-Path -Leaf), $_.Exception.Message)
    }

    if (($processed % 25) -eq 0) {
        Write-Host ("  ... {0} / {1}" -f $processed, $totalToProcess)
    }
}

Write-Host ("Imported: {0} files, touched {1} fields, wrote {2} string values. Errors: {3}. Skipped: {4}." -f $importedFiles, $totalTouched, $totalWrites, $errors, $skipped)
if ($lastErr) { Write-Diag "Last setter error: $lastErr" }

if ($totalWrites -eq 0) {
    throw "ZERO writes detected. AsString setter API mismatch or field navigation broken. Check [DIAG] lines above."
}

# -- Write the modified .assets --
$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# In-place overwrite detection: if OutputPath is the same file as AssetsPath,
# we cannot write directly because AssetsManager still holds the source FileStream
# open. Write to <Output>.tmp first, then unload, backup, and atomic-rename.
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
    # Release the original file from AssetsManager so we can replace it.
    try { $assetsInst.file.Reader.Close() } catch {}
    try { $manager.UnloadAllAssetsFiles() } catch {}
    try { $manager.UnloadAll() } catch {}
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()

    # Backup original once -- never overwrite an existing .bak (it may be the
    # only clean copy left if the user repacks multiple times).
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
