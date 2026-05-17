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

# ============================================================================
# КЛЮЧОВА ЛОГІКА З UABEANext FontPlugin (FontHelper.GetByteArrayFont):
#   1) Отримати TEMPLATE для Font asset.
#   2) Знайти child `m_FontData` у template.
#   3) Зробити `m_FontData.Children[0]` (Array) — `ValueType = ByteArray`.
#      Це перемикає серіалізатор з array<UInt8> (4× padding кожного byte)
#      на ПРИМІТИВНИЙ ByteArray (packed, 1-byte each).
#   4) Викликати `template.MakeValue(reader, AbsoluteByteStart)` — створює
#      baseField з модифікованого template.
#   5) `baseField["m_FontData.Array"].AsByteArray = newBytes` — тепер пише
#      packed bytes без padding, як саме робить Plugin > Import Font.
# Без цього кроку звичайний GetBaseField повертає поле з template-default
# серіалізатором array<UInt8>, і AsByteArray записує з padding (~4× ).
# ============================================================================
Write-Diag "Building template with ByteArray patch (FontPlugin-style)..."
$fontTemp = $manager.GetTemplateBaseField($assetsInst, $target)
if ($null -eq $fontTemp) { throw "Failed to get template for Font asset" }
$fontDataTpl = $null
foreach ($child in $fontTemp.Children) {
    $cname = $null
    try { $cname = [string]$child.Name } catch {}
    if ($cname -eq "m_FontData") { $fontDataTpl = $child; break }
}
if ($null -eq $fontDataTpl) { throw "m_FontData not found in Font template" }
if ($null -eq $fontDataTpl.Children -or $fontDataTpl.Children.Count -eq 0) {
    throw "m_FontData has no Array child template"
}
$arrayTpl = $fontDataTpl.Children[0]
$oldVT = $arrayTpl.ValueType
$arrayTpl.ValueType = [AssetsTools.NET.AssetValueType]::ByteArray
Write-Diag ("  m_FontData.Array template ValueType: {0} → ByteArray" -f $oldVT)

# MakeValue(reader, position, refTypeManager) — будуємо baseField з patched template.
# Абсолютний offset = Header.DataOffset + info.ByteOffset.
# AssetFileInfo не має AbsoluteByteStart у v3 API — обчислюємо вручну.
$reader = $assetsInst.file.Reader
$dataOffset = [int64]$assetsInst.file.Header.DataOffset
$assetOffset = [int64]$target.ByteOffset
$absStart = $dataOffset + $assetOffset
Write-Diag ("  Asset absolute offset = DataOffset({0}) + ByteOffset({1}) = {2}" -f $dataOffset, $assetOffset, $absStart)
$base = $fontTemp.MakeValue($reader, $absStart, $null)
if ($null -eq $base) { throw "MakeValue returned null" }
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

# Завдяки patched-template (ValueType=ByteArray на m_FontData.Array вище),
# AsByteArray тепер пише packed bytes без 4× padding. Це той самий код, що
# у FontPlugin.ImportFontOption.SingleImport — буквальне 1:1 повторення.
$replaced = $false
$arrayFieldX = $null
try { $arrayFieldX = $dataField["Array"] } catch {}
if ($null -ne $arrayFieldX) {
    try {
        $arrayFieldX.AsByteArray = $newBytes
        $replaced = $true
        Write-Diag ("Set via patched-template Array.AsByteArray ({0:N0} bytes)" -f $newBytes.Length)
    } catch {
        Write-Diag "Patched-template Array.AsByteArray set failed: $($_.Exception.Message)"
    }
}

# Старий ChildrenFill-блок лишаємо нижче як 100% fallback, але після
# patched-template він уже не потрібен. Скрипт не доходить сюди.
if (-not $replaced) { Write-Diag "Falling back to ChildrenFill (legacy path)..." }
# === LEGACY START (не виконується якщо patched-template спрацював) ===
$csChildrenCode = @'
using System;
using System.Reflection;
using AssetsTools.NET;
using AssetsTools.NET.Extra;

public static class FontDataChildrenFiller {
    public static string LastErr = "";
    public static string Diag = "";

    /// <summary>
    /// FontPlugin (UABEA Next, FontPlugin.dll → ImportFontOption) виконує дві
    /// крокові операції:
    ///   1. base["m_FontData"]["Array"].Value.AsByteArray = bytes
    ///      — це встановлює internal byte-array Value, але НЕ перебудовує
    ///      Children. Серіалізатор v3 для AlignBytes-array бере байти саме
    ///      з Value (а не з Children) і пише primitive byte-array без 4×
    ///      padding. Children лишаються порожніми, серіалізатор їх ігнорує.
    ///   2. base["m_StreamData"]["size"].AsInt = 0
    ///      base["m_StreamData"]["path"].AsString = ""
    ///      — переключає Unity на inline-байти замість .resS.
    ///
    /// Наша попередня помилка: filling Children → 4× padding (3.27 MB → 13 MB)
    /// → corrupted TTF. Правильний шлях — тільки `arrayField.Value` через
    /// AssetTypeValue(ByteArray, bytes) і Children.Clear().
    /// </summary>
    public static int Fill(AssetTypeValueField arrayField, byte[] data) {
        try {
            if (arrayField == null || data == null) { LastErr = "null arg"; return 0; }
            var arrTpl = arrayField.TemplateField;
            if (arrTpl == null || arrTpl.Children == null || arrTpl.Children.Count == 0) {
                LastErr = "no inner template";
                return 0;
            }
            var byteTpl = arrTpl.Children[0];
            Diag = "byteTpl.Type=" + byteTpl.Type + " VT=" + byteTpl.ValueType +
                   " IsAligned=" + byteTpl.IsAligned + " arrTpl.IsAligned=" + arrTpl.IsAligned;

            // КЛЮЧОВЕ: byte-child з IsAligned=true змушує серіалізатор паддінгувати
            // кожен byte до 4-byte boundary (3.27 MB → 13 MB і TTF битий).
            // Виставляємо IsAligned=false на byte template — серіалізатор пише
            // packed bytes 1-в-1. На array template IsAligned лишаємо як було
            // (це окрема властивість для post-array alignment, не per-byte).
            try { byteTpl.IsAligned = false; } catch {}

            // Заповнюємо Children списком byte-fields.
            arrayField.Children.Clear();
            int n = data.Length;
            for (int i = 0; i < n; i++) {
                var f = ValueBuilder.DefaultValueFieldFromTemplate(byteTpl);
                f.AsByte = data[i];
                arrayField.Children.Add(f);
            }
            // Дублюємо через AsByteArray на випадок якщо v3 серіалізатор
            // має доп. fast-path для byte-arrays із Value.
            try { arrayField.AsByteArray = data; } catch {}
            return arrayField.Children.Count;
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return -1;
        }
    }
}
'@
$refsFill = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    'netstandard', 'System.Runtime', 'System.Collections'
)
try { Add-Type -TypeDefinition $csChildrenCode -ReferencedAssemblies $refsFill -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { Write-Diag ("FontDataChildrenFiller compile fail: {0}" -f $_.Exception.Message) }

$arrayField = $null
try { $arrayField = $dataField["Array"] } catch {}
if ($null -ne $arrayField) {
    Write-Diag ("  Filling Array.Children with {0:N0} byte-fields..." -f $newBytes.Length)
    $filled = [FontDataChildrenFiller]::Fill($arrayField, $newBytes)
    if ($filled -gt 0) {
        Write-Diag ("  Children filled: {0:N0}" -f $filled)
        $replaced = $true
    } else {
        Write-Diag ("  ChildrenFill failed: {0}" -f [FontDataChildrenFiller]::LastErr)
    }
}

# Спроба 2: outer dataField.AsByteArray — fallback.
if (-not $replaced) {
    try {
        $dataField.AsByteArray = $newBytes
        $replaced = $true
        Write-Diag "Set via outer m_FontData.AsByteArray (fallback)"
    } catch {
        Write-Diag "Outer AsByteArray set failed: $($_.Exception.Message)"
    }
}

# Спроба 3: inner Array.AsByteArray — останній fallback.
if (-not $replaced -and $null -ne $arrayField) {
    try {
        $arrayField.AsByteArray = $newBytes
        $replaced = $true
        Write-Diag "Set via inner Array.AsByteArray (fallback)"
    } catch {
        Write-Diag "Inner Array.AsByteArray set failed: $($_.Exception.Message)"
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

# КРИТИЧНО: DP2 зберігає m_FontData з reference у sharedassets0.assets.resS
# (stream-data файл). Якщо m_StreamData має offset/size > 0, Unity завжди читає
# з .resS і ІГНОРУЄ inline-байти, які ми тільки що записали. Тому очищаємо
# StreamData reference — це змушує Unity використати наші inline-байти.
# UABEA Plugin саме так робить при "Edit Font Data" — тому і працює.
try {
    $sd = $base["m_StreamData"]
    if ($null -ne $sd) {
        try { $sd["offset"].AsLong = 0 } catch { try { $sd["offset"].AsInt = 0 } catch {} }
        try { $sd["size"].AsLong   = 0 } catch { try { $sd["size"].AsInt   = 0 } catch {} }
        try { $sd["path"].AsString = "" } catch {}
        Write-Diag "m_StreamData cleared (forced inline mode)"
    }
} catch {
    Write-Diag "m_StreamData absent or not modifiable: $($_.Exception.Message)"
}

$assetBytes = $null
try {
    # Метод приймає bigEndian:bool. У Unity на Windows usually little-endian.
    $bigEndian = $false
    try { $bigEndian = [bool]$assetsInst.file.Metadata.IsBigEndian } catch {}
    $assetBytes = $base.WriteToByteArray($bigEndian)
    Write-Diag ("base.WriteToByteArray -> {0:N0} bytes" -f $assetBytes.Length)
} catch {
    Write-Diag ("WriteToByteArray failed: {0}" -f $_.Exception.Message)
}

if ($null -ne $assetBytes -and $assetBytes.Length -gt 0) {
    # SetNewData(byte[]) — це шлях що використовує UABEA Plugin. Гарантує що
    # серіалізатор збереже наші inline-байти, а не reconstruct'не з baseField
    # (де у v3 API є відомий quirk із втратою byte-array значень).
    $target.SetNewData($assetBytes)
    Write-Step "Font data replaced in memory (via SetNewData byte[])"
} else {
    $target.SetNewData($base)
    Write-Step "Font data replaced in memory (via SetNewData baseField fallback)"
}

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

# Post-write sanity check: відкриваємо щойно записаний .assets ще раз і
# перевіряємо чи m_FontData.Array справді має наші байти. Якщо ні —
# AssetsFileWriter тихо проковтнув зміни (баг бібліотеки) і ми мусимо
# знати про це, а не радіти DONE-ом.
try {
    $vmgr = New-Object AssetsTools.NET.Extra.AssetsManager
    $null = $vmgr.LoadClassPackage($tpkPath)
    $vinst = $vmgr.LoadAssetsFile($OutputPath, $true)
    $null = $vmgr.LoadClassDatabaseFromPackage($vinst.file.Metadata.UnityVersion)
    $vtarget = $null
    foreach ($info in $vinst.file.AssetInfos) {
        if ([Int64]$info.PathId -eq $PathId) { $vtarget = $info; break }
    }
    if ($null -eq $vtarget) {
        Write-Diag "VERIFY: PathID $PathId not found in written file"
    } else {
        $vbase = $vmgr.GetBaseField($vinst, $vtarget)
        $verifySize = 0
        try { $verifySize = [int]$vbase["m_FontData"]["Array"].Children.Count } catch {}
        if ($verifySize -eq 0) {
            try { $verifySize = ([byte[]]($vbase["m_FontData"].AsByteArray)).Length } catch {}
        }
        $sdSize = 0
        try { $sdSize = [int64]$vbase["m_StreamData"]["size"].AsLong } catch {}
        Write-Diag ("VERIFY: m_FontData inline bytes = {0:N0}, m_StreamData.size = {1:N0}, expected {2:N0}" -f $verifySize, $sdSize, $newBytes.Length)
        if ($verifySize -lt ($newBytes.Length * 0.9)) {
            Write-Warning ("VERIFY MISMATCH: written m_FontData ({0:N0}B) << expected ({1:N0}B). AssetsFileWriter did NOT persist the new TTF bytes." -f $verifySize, $newBytes.Length)
        }
    }
    try { $vmgr.UnloadAllAssetsFiles() } catch {}
    try { $vmgr.UnloadAll() } catch {}
} catch {
    Write-Diag ("VERIFY: post-write check failed: {0}" -f $_.Exception.Message)
}
exit 0
