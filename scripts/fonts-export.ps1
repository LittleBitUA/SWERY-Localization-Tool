# DP2 Fonts Export — витягує усі Font-ассети (TypeId 128) з sharedassets0.assets
# та зберігає `m_FontData` (TTF/OTF bytes) як <name>.ttf у $OutDir.
# Залежності — як у import-to-assets.ps1: AssetsTools.NET + Cpp2IL/Mono.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $AssetsPath)) { throw ".assets not found: $AssetsPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }
if (-not (Test-Path $OutDir))     { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

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

# Inline C#-хелпер — ітерація байтового вектора через AssetsTools.NET на
# native швидкості. PowerShell foreach над 3 млн полів = ~200с, C# = ~0.5с.
$csCode = @'
using System;
using System.Collections.Generic;
using AssetsTools.NET;
public static class FontBytesHelper {
    public static string LastPath = "?";
    public static byte[] GetBytes(AssetTypeValueField fontDataField) {
        LastPath = "init";
        if (fontDataField == null) { LastPath = "null-field"; return null; }
        // 1) AsByteArray на inner Array (HOT PATH)
        AssetTypeValueField arr;
        try { arr = fontDataField["Array"]; } catch { arr = null; }
        if (arr != null) {
            try {
                byte[] direct = arr.AsByteArray;
                if (direct != null && direct.Length > 0) { LastPath = "Array.AsByteArray"; return direct; }
            } catch (Exception ex) { LastPath = "Array.AsByteArray-ex:" + ex.Message; }
        }
        // 2) Outer AsByteArray
        try {
            byte[] direct2 = fontDataField.AsByteArray;
            if (direct2 != null && direct2.Length > 0) { LastPath = "Outer.AsByteArray"; return direct2; }
        } catch (Exception ex) { LastPath = "Outer.AsByteArray-ex:" + ex.Message; }
        // 3) Manual iteration. КРИТИЧНО: AsByte у v3 повертає 0 для байтів >= 128
        // (внутрішній сейф-cast int→byte для signed-byte), тому беремо AsInt і
        // самі маскуємо до 0..255.
        if (arr == null) { LastPath = "no-Array-child"; return null; }
        try {
            IList<AssetTypeValueField> children = arr.Children;
            int n = children.Count;
            byte[] result = new byte[n];
            for (int i = 0; i < n; i++) {
                int v = 0;
                try { v = children[i].AsInt; }
                catch {
                    try { v = (int)children[i].AsUInt; } catch {}
                }
                result[i] = (byte)(v & 0xFF);
            }
            LastPath = "iter-AsInt(" + n + ")";
            return result;
        } catch (Exception ex) {
            LastPath = "iter-ex:" + ex.Message;
            return null;
        }
    }
}
'@
$script:HelperReady = $false
# PowerShell 7 (.NET 8) Add-Type потребує явні netstandard / System.Runtime
# refs, бо коли вказуєш -ReferencedAssemblies, дефолтні mscorlib/System не
# додаються автоматично. Пробуємо кілька варіантів — досить щоб хоча б один
# спрацював на конкретній системі.
$refSets = @(
    @($dllPath, 'netstandard', 'System.Runtime', 'System.Collections'),
    @($dllPath, 'netstandard'),
    @($dllPath)
)
foreach ($refs in $refSets) {
    try {
        Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -ErrorAction Stop
        $script:HelperReady = $true
        Write-Diag ("FontBytesHelper compiled OK (refs: {0})" -f ($refs -join ", "))
        break
    } catch {
        Write-Diag ("  compile attempt failed: {0}" -f $_.Exception.Message)
    }
}
if (-not $script:HelperReady) {
    Write-Diag "FontBytesHelper NOT compiled — буде slow PS iter."
}

Write-Step "Loading $AssetsPath ..."
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)
$assetsInst = $manager.LoadAssetsFile($AssetsPath, $true)
$null = $manager.LoadClassDatabaseFromPackage($assetsInst.file.Metadata.UnityVersion)

Write-Diag "Unity version: $($assetsInst.file.Metadata.UnityVersion)"

# Helper: get child field by name (AssetsTools.NET v3 indexer-friendly).
function Get-Child {
    param($Field, [string]$Name)
    if ($null -eq $Field) { return }
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

# Дістати байти з m_FontData (vector<UInt8>). У AssetsTools.NET v3 правильний
# швидкий шлях — `outer["Array"].AsByteArray`. Якщо API не підтримує — beriemo
# inline C# хелпер (native-швидкість, навіть якщо потрібна per-byte ітерація).
function Get-FontBytes {
    param($FontDataField)
    if ($null -eq $FontDataField) { return $null }

    # Шлях 1: C# хелпер — пробує всі швидкі API і має native iter як fallback.
    if ($script:HelperReady) {
        try {
            $b = [FontBytesHelper]::GetBytes($FontDataField)
            if ($null -ne $b -and $b.Length -gt 0) {
                $path = [FontBytesHelper]::LastPath
                Write-Diag ("  via FontBytesHelper [{0}] ({1:N0} bytes)" -f $path, $b.Length)
                return ,$b
            } else {
                Write-Diag ("  FontBytesHelper returned null/empty (path: {0})" -f [FontBytesHelper]::LastPath)
            }
        } catch {
            Write-Diag "  FontBytesHelper threw: $($_.Exception.Message)"
        }
    }

    # Шлях 2: PowerShell-fallback (повільно, але працює навіть без C# хелпера)
    $arr = Get-Child $FontDataField "Array"
    if ($null -ne $arr) {
        try {
            $b = $arr.AsByteArray
            if ($null -ne $b -and $b.Length -gt 0) { return ,$b }
        } catch {}
    }
    try {
        $b = $FontDataField.AsByteArray
        if ($null -ne $b -and $b.Length -gt 0) { return ,$b }
    } catch {}
    # Шлях 3: повільна PS-ітерація з pre-allocated byte[]. Останній шанс.
    if ($null -ne $arr) {
        try {
            $children = @($arr.Children)
            $count = $children.Count
            if ($count -gt 0) {
                Write-Diag "  PS fallback iter ($count bytes) — без C# хелпера, довго..."
                $bytes = New-Object byte[] $count
                for ($i = 0; $i -lt $count; $i++) {
                    try { $bytes[$i] = [byte]$children[$i].AsByte } catch { $bytes[$i] = 0 }
                    if (($i -gt 0) -and (($i % 500000) -eq 0)) {
                        Write-Host ("    ... {0:N0} / {1:N0}" -f $i, $count)
                    }
                }
                return ,$bytes
            }
        } catch {}
    }
    return $null
}

Write-Step "Scanning Font assets (TypeId=128)..."
$exported = @()
foreach ($info in $assetsInst.file.AssetInfos) {
    if ($info.TypeId -ne 128) { continue }

    try {
        $base = $manager.GetBaseField($assetsInst, $info)
        if ($null -eq $base) { continue }

        $nameField = Get-Child $base "m_Name"
        $fontName = $null
        if ($null -ne $nameField) {
            try { $fontName = $nameField.AsString } catch {}
        }
        # Пропускаємо безіменні Font-assets — у sharedassets0 трапляються
        # технічні шрифти без m_Name, які нам не потрібні і лише засмічують
        # toolsDir/DP2/Fonts. Експортуємо лише іменовані (FOT-*, Noto*, …).
        if (-not $fontName) {
            Write-Diag ("  skip PathID {0}: m_Name empty" -f $info.PathId)
            continue
        }

        $dataField = Get-Child $base "m_FontData"
        $bytes = Get-FontBytes $dataField

        if ($null -eq $bytes -or $bytes.Length -eq 0) {
            Write-Warning "PathID $($info.PathId) ($fontName): m_FontData empty"
            continue
        }

        # Діагностика: перші 16 байт + ASCII — щоб бачити signature.
        $sig = ""
        $sigAscii = ""
        for ($i = 0; $i -lt [Math]::Min(16, $bytes.Length); $i++) {
            $sig += "{0:X2} " -f $bytes[$i]
            $b = $bytes[$i]
            $sigAscii += if ($b -ge 32 -and $b -lt 127) { [char]$b } else { "." }
        }
        Write-Diag "  first 16 bytes: $sig"
        Write-Diag "  as ASCII      : $sigAscii"

        # Auto-detect розширення за сигнатурою (як робить UABEA Plugin):
        #   00 01 00 00 → .ttf (TrueType)
        #   4F 54 54 4F = "OTTO" → .otf (OpenType/CFF)
        #   74 74 63 66 = "ttcf" → .ttc (TrueType Collection)
        $ext = ".dat"
        if ($bytes.Length -ge 4) {
            if ($bytes[0] -eq 0x00 -and $bytes[1] -eq 0x01 -and $bytes[2] -eq 0x00 -and $bytes[3] -eq 0x00) { $ext = ".ttf" }
            elseif ($bytes[0] -eq 0x4F -and $bytes[1] -eq 0x54 -and $bytes[2] -eq 0x54 -and $bytes[3] -eq 0x4F) { $ext = ".otf" }
            elseif ($bytes[0] -eq 0x74 -and $bytes[1] -eq 0x74 -and $bytes[2] -eq 0x63 -and $bytes[3] -eq 0x66) { $ext = ".ttc" }
            else {
                # Спроба знайти сигнатуру з offset > 0 (Unity-header стрипаємо)
                for ($o = 1; $o -le [Math]::Min(32, $bytes.Length - 4); $o++) {
                    $foundExt = $null
                    if ($bytes[$o] -eq 0x00 -and $bytes[$o+1] -eq 0x01 -and $bytes[$o+2] -eq 0x00 -and $bytes[$o+3] -eq 0x00) { $foundExt = ".ttf" }
                    elseif ($bytes[$o] -eq 0x4F -and $bytes[$o+1] -eq 0x54 -and $bytes[$o+2] -eq 0x54 -and $bytes[$o+3] -eq 0x4F) { $foundExt = ".otf" }
                    if ($null -ne $foundExt) {
                        Write-Diag "  signature at offset $o, trimming first $o bytes"
                        $trimmed = New-Object byte[] ($bytes.Length - $o)
                        [Array]::Copy($bytes, $o, $trimmed, 0, $trimmed.Length)
                        $bytes = $trimmed
                        $ext = $foundExt
                        break
                    }
                }
            }
        }
        if ($ext -eq ".dat") {
            Write-Diag "  WARN: no TTF/OTF signature found — file may be corrupt"
        }

        # Naming convention як в UABEA Next Plugin: <name>-<asset>-<pathId>.<ext>
        $safe = $fontName -replace '[\\/:\*\?"<>\|]', '_'
        $assetBaseName = [System.IO.Path]::GetFileNameWithoutExtension($AssetsPath) + [System.IO.Path]::GetExtension($AssetsPath)
        $outFile = Join-Path $OutDir ("{0}-{1}-{2}{3}" -f $safe, $assetBaseName, $info.PathId, $ext)
        [System.IO.File]::WriteAllBytes($outFile, $bytes)
        Write-Host ("Exported {0} (PathID {1}) -> {2} ({3:N0} bytes)" -f $fontName, $info.PathId, $outFile, $bytes.Length)
        $exported += [pscustomobject]@{
            name = $fontName
            pathId = $info.PathId
            file = $outFile
            size = $bytes.Length
            assetsFile = $assetBaseName
        }
    } catch {
        Write-Warning ("PathID {0}: {1}" -f $info.PathId, $_.Exception.Message)
    }
}

Write-Step ("DONE: exported {0} fonts to {1}" -f $exported.Count, $OutDir)
# JSON-output у stdout — main.cjs парсить його для UI.
$json = $exported | ConvertTo-Json -Depth 5 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
