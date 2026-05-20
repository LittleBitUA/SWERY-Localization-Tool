# Витягає raw байти IMHeightInfo MonoBehaviour з resources.assets у файл.
# Цей asset не парситься AssetsTools.NET (нема TypeTree скрипта), тож
# читаємо сирі байти безпосередньо з потоку файла.
#
# Параметри:
#   -AssetsPath: повний шлях до resources.assets
#   -OutFile:    куди записати raw байти
#   -UabeaDir:   тека з AssetsTools.NET DLL'ями

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$OutFile,
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$loadList = @("Mono.Cecil.dll","LibCpp2IL.dll","Newtonsoft.Json.dll","AssetsTools.NET.dll","AssetsTools.NET.MonoCecil.dll","AssetsTools.NET.Cpp2IL.dll","UABEANext4.dll")
foreach ($n in $loadList) { $p=Join-Path $UabeaDir $n; if (Test-Path $p) { try { $null=[System.Reflection.Assembly]::LoadFrom($p) } catch {} } }

$mgr = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $mgr.LoadClassPackage((Join-Path $UabeaDir "classdata.tpk"))
$inst = $mgr.LoadAssetsFile($AssetsPath, $true)
$null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)

# Шукаємо MonoBehaviour з m_Name='IMHeightInfo'.
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
if ($null -eq $target) { throw "IMHeightInfo MonoBehaviour not found" }
Write-Host ("[DIAG] Found IMHeightInfo PathId={0} ByteSize={1}" -f $target.PathId, $target.ByteSize)

# AbsoluteByteStart = file.Header.DataOffset + asset.ByteOffset
$dataOff = $inst.file.Header.DataOffset
$aiOff = $target.ByteOffset
$absStart = [int64]$dataOff + [int64]$aiOff
$stream = $inst.file.Reader.BaseStream
$stream.Seek($absStart, [System.IO.SeekOrigin]::Begin) | Out-Null
$br = New-Object System.IO.BinaryReader($stream)
$bytes = $br.ReadBytes([int]$target.ByteSize)

$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllBytes($OutFile, $bytes)
Write-Host ("[STEP] Wrote {0} bytes to {1}" -f $bytes.Length, $OutFile)
Write-Host ("RESULT_JSON: {{`"ok`":true,`"pathId`":{0},`"size`":{1},`"outFile`":`"{2}`"}}" -f $target.PathId, $bytes.Length, ($OutFile -replace '\\','\\'))
exit 0
