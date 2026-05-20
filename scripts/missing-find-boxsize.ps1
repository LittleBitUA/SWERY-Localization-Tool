# Дампить IMHeightInfo з resources.assets — кандидат на box-size таблицю TF2.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$AssetsPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [int]$PathId = 12881,
    [string]$DumpTo = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$loadList = @("Mono.Cecil.dll","LibCpp2IL.dll","Newtonsoft.Json.dll","AssetsTools.NET.dll","AssetsTools.NET.MonoCecil.dll","AssetsTools.NET.Cpp2IL.dll","UABEANext4.dll")
foreach ($n in $loadList) { $p=Join-Path $UabeaDir $n; if (Test-Path $p) { try { $null=[System.Reflection.Assembly]::LoadFrom($p) } catch {} } }

$mgr = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $mgr.LoadClassPackage((Join-Path $UabeaDir "classdata.tpk"))
$inst = $mgr.LoadAssetsFile($AssetsPath, $true)
$null = $mgr.LoadClassDatabaseFromPackage($inst.file.Metadata.UnityVersion)

$target = $null
foreach ($ai in $inst.file.AssetInfos) { if ($ai.PathId -eq $PathId) { $target = $ai; break } }
if ($null -eq $target) { throw "PathId=$PathId not found" }

Write-Host ("Target: PathId={0} TypeId={1} ByteSize={2}" -f $target.PathId,$target.TypeId,$target.ByteSize)

# Спершу — типізований BaseField (Unity-парсинг через TypeTree).
$base = $mgr.GetBaseField($inst, $target)
try { Write-Host ("m_Name='{0}'" -f $base["m_Name"].AsString) } catch {}

# Перерахуємо top-level fields у MonoBehaviour.
Write-Host ""
Write-Host "Top-level fields:"
$enum = $base.Children.GetEnumerator()
while ($enum.MoveNext()) {
    $ch = $enum.Current
    $tn = $ch.TypeName; $fn = $ch.FieldName
    $extra = ""
    try {
        if ($ch.IsArray) {
            $arr = $ch.Children
            $extra = "  arrayLen=$($arr.Count)"
        } else {
            try {
                $v = $ch.Value
                $extra = "  value=$v"
            } catch {}
        }
    } catch {}
    Write-Host ("  {0,-30}  {1,-20} {2}" -f $fn,$tn,$extra)
}

# Дампимо raw байти асету напряму з потоку файлу (не WriteToByteArray, бо
# UABEA без TypeTree скриптової частини повертає лише MB-обгортку).
if ($DumpTo) {
    $hdr = $inst.file.Metadata
    # У AssetsTools.NET 3.x DataOffset знаходиться у Header.DataOffset, а
    # ByteOffset у самому AssetFileInfo. Перевіримо обидва варіанти.
    $dataOff = $null
    try { $dataOff = $inst.file.Header.DataOffset } catch {}
    if ($null -eq $dataOff) { try { $dataOff = $hdr.DataOffset } catch {} }
    $aiOff = $null
    try { $aiOff = $target.ByteOffset } catch {}
    if ($null -eq $aiOff) { try { $aiOff = $target.OffsetInFile } catch {} }
    Write-Host ("dataOffset={0}  asset.ByteOffset={1}" -f $dataOff,$aiOff)
    if ($null -ne $dataOff -and $null -ne $aiOff) {
        $absStart = [int64]$dataOff + [int64]$aiOff
        $stream = $inst.file.Reader.BaseStream
        $stream.Seek($absStart, [System.IO.SeekOrigin]::Begin) | Out-Null
        $br = New-Object System.IO.BinaryReader($stream)
        $bytes = $br.ReadBytes([int]$target.ByteSize)
        [System.IO.File]::WriteAllBytes($DumpTo, $bytes)
        Write-Host ("Wrote {0} bytes to {1}" -f $bytes.Length, $DumpTo)
        $hexLen = [Math]::Min(256, $bytes.Length)
        $hex = ($bytes[0..($hexLen-1)] | ForEach-Object { $_.ToString("x2") }) -join " "
        Write-Host "First $hexLen bytes:"
        for ($i=0; $i -lt $hex.Length; $i += 48) {
            $line = $hex.Substring($i, [Math]::Min(48, $hex.Length - $i))
            Write-Host "  $line"
        }
    } else {
        Write-Host "Could not resolve absolute byte offset — skipping dump"
    }
}
