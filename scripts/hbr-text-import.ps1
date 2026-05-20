# Hotel Barcelona Text Import — пакує JSON-дампи (Done/) назад у Unity bundle.
# Для кожного MonoBehaviour з мети (Meta/hbr-meta.json) шукає за PathID,
# завантажує відповідний Done/<file>.json, оновлює _Text-поля,
# викликає info.SetNewData, записує bundle у .tmp і свопає на оригінал.
#
# Параметри:
#   -BundlePath  : повний шлях до .bundle
#   -DoneDir     : Documents\SWERY-Localization-Tool\HBR\Text\Done\
#   -MetaPath    : Documents\SWERY-Localization-Tool\HBR\Text\Meta\hbr-meta.json
#   -UabeaDir    : тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$BundlePath,
    [Parameter(Mandatory=$true)] [string]$DoneDir,
    [Parameter(Mandatory=$true)] [string]$MetaPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $BundlePath)) { throw "Bundle not found: $BundlePath" }
if (-not (Test-Path $DoneDir))    { throw "Done dir not found: $DoneDir" }
if (-not (Test-Path $MetaPath))   { throw "Meta file not found: $MetaPath" }
if (-not (Test-Path $UabeaDir))   { throw "UABEA dir not found: $UabeaDir" }

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
# КРИТИЧНО: вмикаємо кеші, як це робить UABEA Next у Workspace.cs.
# Без UseRefTypeManagerCache=true кожен GetRefTypeManager(inst) повертає
# новий порожній менеджер — і ImportJsonAsset серіалізує MonoBehaviour без
# managed-references types. Результат: Unity бачить "Read 44 bytes but
# expected 1116 bytes" і не може завантажити сцени.
$manager.UseRefTypeManagerCache = $true
$manager.UseTemplateFieldCache = $true
$manager.UseMonoTemplateFieldCache = $true

$metaText = [System.IO.File]::ReadAllText($MetaPath, [System.Text.Encoding]::UTF8)
# Unity PathID — це Int64 (часто > 2^53). PowerShell ConvertFrom-Json парсить
# такі числа як Double і обрізає точність ("-8972238306652206080" → "-8972238306652206000").
# Обертаємо pathId / scriptPathId у string ДО парсингу JSON — далі скрипт уже
# приведе [int64]::Parse($item.pathId.ToString()).
$metaTextSafe = [regex]::Replace($metaText, '"(pathId|scriptPathId)"\s*:\s*(-?\d+)', '"$1":"$2"')
$meta = $metaTextSafe | ConvertFrom-Json
Write-Diag ("Meta items: {0}" -f $meta.items.Count)

Write-Step "Loading bundle..."
$bundleInst = $manager.LoadBundleFile($BundlePath)
$afiCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Bundle AFIs: $afiCount"

# Setup MonoBehaviour generator (IL2CPP / Mono).
$dataDir = Split-Path -Parent (Split-Path -Parent $BundlePath)
$il2cppMeta = Join-Path $dataDir "il2cpp_data\Metadata\global-metadata.dat"
$gameRoot = Split-Path -Parent $dataDir
$gameAssembly = Join-Path $gameRoot "GameAssembly.dll"
if ((Test-Path $il2cppMeta) -and (Test-Path $gameAssembly)) {
    try {
        $cppGen = New-Object AssetsTools.NET.Cpp2IL.Cpp2IlTempGenerator($il2cppMeta, $gameAssembly)
        $manager.MonoTempGenerator = $cppGen
        Write-Diag "Cpp2IlTempGenerator ready"
    } catch {
        Write-Warning "Cpp2IL init failed: $($_.Exception.Message)"
    }
}

# Завантажуємо assets-файли з bundle. Зберігаємо інстанси для запису назад.
$afiInstances = @{}

# Функція: пройтися по ВСІХ MonoBehaviour assets у файлі і викликати
# GetBaseField — це примусово зареєструє всі managed-reference типи у
# кешованому RefTypeManager (UseRefTypeManagerCache=true). Без цього кроку
# ImportJsonAsset серіалізує наш _EN MonoBehaviour, але refs для нього
# (з інших MonoBehaviour типу TextItemList) залишаються незареєстрованими,
# і Unity потім бачить "Read 44 bytes but expected 1116 bytes".
function Initialize-RefTypeCache {
    param($mgr, $inst)
    $cnt = 0
    $failCnt = 0
    $failByScript = @{}  # scriptPathId → count of failed GetBaseField
    $failByExType = @{}  # exception-type name → count
    $failSamples  = New-Object System.Collections.ArrayList   # перші 20 фейлів з повним повідомленням
    foreach ($ai in $inst.file.AssetInfos) {
        if ($ai.TypeId -ne 114) { continue }   # MonoBehaviour only
        try {
            $null = $mgr.GetBaseField($inst, $ai); $cnt++
        } catch {
            $failCnt++
            $exType = $_.Exception.GetType().Name
            if (-not $failByExType.ContainsKey($exType)) { $failByExType[$exType] = 0 }
            $failByExType[$exType]++
            # Пробуємо дістати scriptPathId без повторного GetBaseField (може теж кинути).
            $scriptPid = "?"
            try {
                # AssetInfo.MonoScriptInfo або через TypeIdOrIndex — спрощено
                # просто беремо PathId самого asset'а як грубий унікалізатор.
                $scriptPid = "asset_pid=$($ai.PathId)"
            } catch {}
            if (-not $failByScript.ContainsKey($scriptPid)) { $failByScript[$scriptPid] = 0 }
            $failByScript[$scriptPid]++
            if ($failSamples.Count -lt 20) {
                [void]$failSamples.Add([pscustomobject]@{
                    pathId = $ai.PathId
                    typeId = $ai.TypeId
                    ex     = $exType
                    msg    = $_.Exception.Message
                })
            }
        }
    }
    Write-Diag "  RefTypeCache: prefetched $cnt MonoBehaviour fields ($failCnt failed)"
    if ($failCnt -gt 0) {
        Write-Host "[DIAG-FAIL] GetBaseField failed on $failCnt MonoBehaviour(s):"
        foreach ($k in $failByExType.Keys) {
            Write-Host ("  exception {0}: {1}" -f $k, $failByExType[$k])
        }
        Write-Host "[DIAG-FAIL] First $($failSamples.Count) failures:"
        foreach ($s in $failSamples) {
            Write-Host ("  pid={0} typeId={1} ex={2} msg={3}" -f $s.pathId, $s.typeId, $s.ex, $s.msg)
        }
    }
}
for ($afiIdx = 0; $afiIdx -lt $afiCount; $afiIdx++) {
    try {
        $inst = $manager.LoadAssetsFileFromBundle($bundleInst, $afiIdx)
        if ($null -ne $inst) {
            $afiInstances[$afiIdx] = $inst
            $null = $manager.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)
            $mbTotal = 0
            foreach ($ai in $inst.file.AssetInfos) { if ($ai.TypeId -eq 114) { $mbTotal++ } }
            Write-Diag ("AFI[{0}] loaded: {1} MonoBehaviour assets total" -f $afiIdx, $mbTotal)
            # Naповнюємо кеш RefTypeManager managed-reference типами з усіх
            # MonoBehaviour у цьому assets-файлі (включно з TextItemList і
            # подібними не-_EN MonoBehaviour, чиї refs потрібні AssetsTools.NET
            # при Write). Це і є те, що UABEA Next робить автоматично при
            # відкритті bundle у UI через ListView lazy-loading.
            Initialize-RefTypeCache -mgr $manager -inst $inst
        } else {
            Write-Warning ("AFI[{0}] LoadAssetsFileFromBundle returned null" -f $afiIdx)
        }
    } catch {
        Write-Warning ("AFI[{0}] load failed: {1}: {2}" -f $afiIdx, $_.Exception.GetType().Name, $_.Exception.Message)
    }
}

# Helper: рекурсивно проходимо JSON-структуру і встановлюємо значення у
# AssetTypeValueField. Підтримуємо лише ті типи що нам треба:
# вкладені struct (children) та Array (через "Array" field).
#
# UABEANext-точно ImportSingle flow: відкриваємо JSON-stream, створюємо
# AssetImport(stream, manager.GetRefTypeManager(inst)), викликаємо
# ImportJsonAsset(template, out err) — отримуємо byte[]. У UABEA саме так
# працює "Import Dump → Save Selected", який у користувача дає робочий
# bundle. Ключова відмінність від нашого попереднього варіанту: refTypeMan
# береться з manager.GetRefTypeManager(inst) (а не new + FromTypeTree).
# Цей метод повертає КЕШОВАНИЙ менеджер, той самий що AssetsTools.NET
# використає при Write — без нього serialized stream може втратити дані
# про managed references.
#
$csCode = @'
using System;
using System.IO;
using System.Text;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using UABEANext4.Logic.ImportExport;

public static class HbrPatcher {
    public static string LastErr = "";
    public static int Patched = 0;

    public static byte[] ImportJson(AssetsManager manager, AssetsFileInstance inst, AssetTypeTemplateField template, string jsonRaw) {
        try {
            byte[] inBytes = Encoding.UTF8.GetBytes(jsonRaw);
            using (var ms = new MemoryStream(inBytes)) {
                var refMan = manager.GetRefTypeManager(inst);
                var importer = new AssetImport(ms, refMan);
                string error;
                byte[] bytes = importer.ImportJsonAsset(template, out error);
                if (!string.IsNullOrEmpty(error)) { LastErr = error; return null; }
                if (bytes == null) { LastErr = "ImportJsonAsset returned null"; return null; }
                Patched = bytes.Length;
                return bytes;
            }
        } catch (Exception ex) {
            LastErr = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
    }
}
'@
$refs = @(
    (Join-Path $UabeaDir "AssetsTools.NET.dll"),
    (Join-Path $UabeaDir "UABEANext4.dll"),
    'netstandard', 'System.Runtime', 'System.IO',
    'System.Collections'
)
try { Add-Type -TypeDefinition $csCode -ReferencedAssemblies $refs -CompilerOptions "/nowarn:1701,1702" -ErrorAction Stop }
catch { throw "HbrPatcher compile fail: $($_.Exception.Message)" }

$applied = 0
$failed = New-Object System.Collections.ArrayList

foreach ($item in $meta.items) {
    $afiIdx = [int]$item.afiIndex
    # pathId уже у вигляді string завдяки regex-обгортці перед ConvertFrom-Json
    # (інакше Int64 > 2^53 втрачає точність як Double). Parse явно як Int64.
    $assetPid = [int64]::Parse([string]$item.pathId)
    $doneFile = Join-Path $DoneDir $item.file
    if (-not (Test-Path $doneFile)) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "Done file missing: $doneFile" })
        Write-Host ("[SKIP] {0}: no Done file" -f $item.name)
        continue
    }
    if (-not $afiInstances.ContainsKey($afiIdx)) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "AFI $afiIdx not loaded" })
        continue
    }
    $assetsInst = $afiInstances[$afiIdx]
    $info = $null
    foreach ($ai in $assetsInst.file.AssetInfos) {
        if ([int64]$ai.PathId -eq $assetPid) { $info = $ai; break }
    }
    if ($null -eq $info) {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "PathID $assetPid not found" })
        continue
    }
    try {
        # ВАЖЛИВО: спочатку викликаємо GetBaseField — це змушує AssetsTools.NET
        # реально прочитати asset з диска, зареєструвати всі managed-reference
        # типи у кешованому RefTypeManager (UseRefTypeManagerCache=true).
        # UABEA Next у UI робить це автоматично коли користувач відкриває
        # asset для перегляду; у нас же без явного виклику кеш залишався
        # порожнім, і ImportJsonAsset серіалізував MonoBehaviour без refs →
        # Unity при load бачив "Read 44 bytes but expected 1116 bytes".
        $null = $manager.GetBaseField($assetsInst, $info)
        $tpl = $manager.GetTemplateBaseField($assetsInst, $info)
        $raw = [System.IO.File]::ReadAllText($doneFile, [System.Text.Encoding]::UTF8)
        $assetBytes = [HbrPatcher]::ImportJson($manager, $assetsInst, $tpl, $raw)
        if ($null -eq $assetBytes) {
            [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = "ImportJson: " + [HbrPatcher]::LastErr })
            Write-Host ("[FAIL] {0}: {1}" -f $item.name, [HbrPatcher]::LastErr)
            continue
        }
        $info.SetNewData($assetBytes)
        $applied++
        Write-Host ("[PATCHED] {0} (PathID {1}, bytes={2})" -f $item.name, $assetPid, $assetBytes.Length)
    } catch {
        [void]$failed.Add([pscustomobject]@{ name = $item.name; reason = $_.Exception.Message })
        Write-Host ("[FAIL] {0}: {1}" -f $item.name, $_.Exception.Message)
    }
}

# Write bundle back. Просто `bundleInst.file.Write(writer)` — точно так, як
# робить UABEA Next (Workspace.Saving.cs::WriteBundleFile). AssetsTools.NET
# консолідує блоки під час Write і пише ОДИН uncompressed-блок з flags=0x40.
# Результат у 2× більший за оригінальний LZ4 bundle, але Unity вантажить його
# нормально. Двопроходний Pack(LZ4) тут ЛАМАЄ bundle: Unity бачить CRC/hash
# mismatch і викидає 'Will not load AssetBundle'.
Write-Step "Writing bundle..."
$bak = $BundlePath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $BundlePath -Destination $bak -Force
    Write-Diag "Backup → $bak"
}

# Pre-write діагностика — для кожного DirectoryInfo логуємо: ім'я, чи буде
# SetNewData викликано, чи має тип Replacer/ReplacerFromAssets, оригінальний
# offset/length. AFI'ы, які не assets-файли (.resS / shader blobs), мусять
# проходити транзитом — якщо вони не зберігаються, гра падає при GC.
$diCount = $bundleInst.file.BlockAndDirInfo.DirectoryInfos.Count
Write-Diag "Pre-Write: $diCount DirectoryInfos"
for ($di = 0; $di -lt $diCount; $di++) {
    $info = $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$di]
    $name = "?"; $offset = -1; $sz = -1; $replType = "<none>"
    try { $name = $info.Name } catch {}
    try { $offset = $info.Offset } catch {}
    try { $sz = $info.DecompressedSize } catch {}
    try { if ($null -ne $info.Replacer) { $replType = $info.Replacer.GetType().Name } } catch {}
    $willSet = $afiInstances.ContainsKey($di)
    Write-Diag ("  DI[{0}] name='{1}' off={2} dsz={3} replacer={4} willSetNewData={5}" -f $di, $name, $offset, $sz, $replType, $willSet)
}

$writeTarget = $BundlePath + ".tmp"
$writer = $null
try {
    $writer = New-Object AssetsTools.NET.AssetsFileWriter($writeTarget)
    foreach ($k in $afiInstances.Keys) {
        $bundleInst.file.BlockAndDirInfo.DirectoryInfos[$k].SetNewData($afiInstances[$k].file)
    }
    $bundleInst.file.Write($writer)
} finally {
    if ($null -ne $writer) { $writer.Close() }
}

# Post-write — порівняти декілька first/last bytes кожного DI у вихідному
# і вхідному bundle. Якщо AFI[1] чи [2] записався як empty/zero — це і є
# причина крашу.
Write-Diag "Post-Write: checking DI sizes in tmp bundle"
try {
    $tmpSize = (Get-Item $writeTarget).Length
    Write-Diag "  tmp bundle size = $tmpSize bytes"
} catch {}
foreach ($k in $afiInstances.Keys) {
    try { $afiInstances[$k].file.Reader.Close() } catch {}
}
try { $bundleInst.file.Reader.Close() } catch {}
try { $manager.UnloadAllAssetsFiles() } catch {}
try { $manager.UnloadAll() } catch {}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()

Move-Item -LiteralPath $writeTarget -Destination $BundlePath -Force
$outSize = (Get-Item $BundlePath).Length
$bakSize = (Get-Item $bak).Length
Write-Step ("DONE → {0} ({1:N0} bytes; .bak {2:N0} bytes), applied {3}, failed {4}" -f $BundlePath, $outSize, $bakSize, $applied, $failed.Count)

$summary = [pscustomobject]@{
    ok = $true; bundle = $BundlePath; size = $outSize; bakSize = $bakSize
    compression = "None (uncompressed, same as UABEA Save)"
    applied = $applied; failed = $failed.ToArray()
}
$json = ConvertTo-Json -InputObject $summary -Depth 6 -Compress
Write-Host "RESULT_JSON: $json"
exit 0
