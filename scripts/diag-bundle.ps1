param([string]$Path)
[Reflection.Assembly]::LoadFrom('e:/Localization/DP2/UABEA/AssetsTools.NET.dll') | Out-Null
if (-not (Test-Path $Path)) { Write-Host "MISSING: $Path"; exit 1 }
$size = (Get-Item $Path).Length
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage('e:/Localization/DP2/UABEA/classdata.tpk')
$inst = $manager.LoadBundleFile($Path)
$hdr = $inst.file.Header
$blkDir = $inst.file.BlockAndDirInfo
$blocks = $blkDir.BlockInfos
$dirs = $blkDir.DirectoryInfos
Write-Host ("=== {0}" -f $Path)
Write-Host ("  Size: {0:N0} bytes" -f $size)
Write-Host ("  Magic: {0}" -f $hdr.Signature)
Write-Host ("  Version: {0}" -f $hdr.Version)
Write-Host ("  UnityRevision: {0}" -f $hdr.UnityRevision)
Write-Host ("  UnityVersion: {0}" -f $hdr.UnityVersion)
Write-Host ("  CompressedSize: {0:N0}" -f $hdr.CompressedSize)
Write-Host ("  DecompressedSize: {0:N0}" -f $hdr.DecompressedSize)
Write-Host ("  Flags: 0x{0:X}" -f $hdr.Flags)
Write-Host ("  CompressionType: {0}" -f $inst.file.GetCompressionType())
Write-Host ("  BlockCount: {0}" -f $blocks.Count)
for ($i = 0; $i -lt [Math]::Min(6, $blocks.Count); $i++) {
    $b = $blocks[$i]
    Write-Host ("    block[{0}] flags=0x{1:X} compSize={2:N0} decompSize={3:N0}" -f $i, $b.Flags, $b.CompressedSize, $b.DecompressedSize)
}
Write-Host ("  DirCount: {0}" -f $dirs.Count)
for ($i = 0; $i -lt $dirs.Count; $i++) {
    $d = $dirs[$i]
    Write-Host ("    dir[{0}] name='{1}' offset={2:N0} size={3:N0} flags=0x{4:X}" -f $i, $d.Name, $d.Offset, $d.DecompressedSize, $d.Flags)
}
try { $inst.file.Reader.Close() } catch {}
$manager.UnloadAll()
