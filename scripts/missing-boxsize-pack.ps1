# Записує оновлений IMHeightInfo (box-sizes) у resources.assets.
# Працює in-place: робимо .bak, замінюємо raw bytes asset'а через
# AssetsTools.NET ReplacerFromMemory + AssetsFileWriter.
#
# Параметри:
#   -AssetsPath: повний шлях до resources.assets (буде модифіковано)
#   -InFile:    raw bytes нового IMHeightInfo
#   -UabeaDir:  тека з AssetsTools.NET DLL'ями
#   -NoBak:     не створювати .bak (за замовч. створюється)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$InFile,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [switch]$NoBak
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$loadList = @("Mono.Cecil.dll","LibCpp2IL.dll","Newtonsoft.Json.dll","AssetsTools.NET.dll","AssetsTools.NET.MonoCecil.dll","AssetsTools.NET.Cpp2IL.dll","UABEANext4.dll")
foreach ($n in $loadList) { $p=Join-Path $UabeaDir $n; if (Test-Path $p) { try { $null=[System.Reflection.Assembly]::LoadFrom($p) } catch {} } }

if (-not (Test-Path $InFile)) { throw "InFile not found: $InFile" }
if (-not (Test-Path $AssetsPath)) { throw "AssetsPath not found: $AssetsPath" }
$newBytes = [System.IO.File]::ReadAllBytes($InFile)
Write-Host ("[DIAG] New IMHeightInfo bytes: {0}" -f $newBytes.Length)

# .bak попередньої версії
if (-not $NoBak) {
    $bak = "$AssetsPath.bak"
    if (-not (Test-Path $bak)) {
        Copy-Item -LiteralPath $AssetsPath -Destination $bak -Force
        Write-Host "[STEP] Backup saved to $bak"
    } else {
        Write-Host "[DIAG] $bak already exists — keeping previous backup"
    }
}

$mgr = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $mgr.LoadClassPackage((Join-Path $UabeaDir "classdata.tpk"))
$inst = $mgr.LoadAssetsFile($AssetsPath, $true)
$null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)

$target = $null
foreach ($ai in $inst.file.AssetInfos) {
    if ($ai.TypeId -ne 114) { continue }
    try {
        $base = $mgr.GetBaseField($inst, $ai)
        $name = ""
        try { $name = $base["m_Name"].AsString } catch {}
        if ($name -eq "IMHeightInfo") { $target = $ai; break }
    } catch {}
}
if ($null -eq $target) { throw "IMHeightInfo not found in $AssetsPath" }
Write-Host ("[DIAG] Target PathId={0} OldSize={1}" -f $target.PathId, $target.ByteSize)

# Підмінюємо raw байти асету: SetNewData з ReplaceAsset через AssetsFileWriter.
$target.SetNewData($newBytes)

# Перезаписуємо файл атомарно: пишемо у .tmp, потім rename.
$tmpPath = "$AssetsPath.tmp"
$fs = [System.IO.File]::Open($tmpPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($fs)
    $inst.file.Write($writer)
    $writer.Flush()
} finally { $fs.Close() }

# Замінюємо оригінал. Move-Item -Force з retry — файл може бути lock'ed
# Electron'ом (AssetsTools.NET тримав ReadShare-lock) або грою/Steam'ом.
# Спершу ВИЗВОЛЯЄМО ManagerAsset через UnloadAll(), щоб .NET FileStream
# відпустив дескриптор. Потім ретраїмо move з експоненціальною затримкою.
try { $mgr.UnloadAll() } catch {}
try { [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers() } catch {}

$ok = $false
$lastErr = $null
for ($i = 0; $i -lt 30; $i++) {
    try {
        if (Test-Path $AssetsPath) { Remove-Item -LiteralPath $AssetsPath -Force -ErrorAction Stop }
        Move-Item -LiteralPath $tmpPath -Destination $AssetsPath -Force -ErrorAction Stop
        $ok = $true; break
    } catch {
        $lastErr = $_.Exception.Message
        Start-Sleep -Milliseconds (300 + $i * 100)
    }
}
if (-not $ok) {
    # Fallback: Copy-Item замість Move-Item.
    try {
        Copy-Item -LiteralPath $tmpPath -Destination $AssetsPath -Force -ErrorAction Stop
        Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
        $ok = $true
    } catch {
        $lastErr = $_.Exception.Message
    }
}
if (-not $ok) {
    throw "Не вдалося замінити $AssetsPath після 30 спроб + Copy-Item fallback. Можливо, гра або Steam утримують файл. Закрий гру/Steam і спробуй ще раз.`nОстання помилка: $lastErr"
}

$newSize = (Get-Item $AssetsPath).Length
Write-Host ("[STEP] Wrote {0}, new file size: {1}" -f $AssetsPath, $newSize)
Write-Host ("RESULT_JSON: {{`"ok`":true,`"pathId`":{0},`"newSize`":{1}}}" -f $target.PathId, $newSize)
exit 0
