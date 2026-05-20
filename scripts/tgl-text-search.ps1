[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$Root,    # folder з 657 bundle-файлами
    [Parameter(Mandatory=$true)] [string]$Needle,  # шуканий рядок
    [Parameter(Mandatory=$true)] [string]$UabeaDir
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

foreach ($name in @("AssetsTools.NET.dll","AssetsTools.NET.MonoCecil.dll","AssetsTools.NET.Cpp2IL.dll","Newtonsoft.Json.dll","UABEANext4.dll")) {
    $p = Join-Path $UabeaDir $name
    if (Test-Path $p) { try { $null = [System.Reflection.Assembly]::LoadFrom($p) } catch {} }
}
$tpkPath = Join-Path $UabeaDir "classdata.tpk"
$manager = New-Object AssetsTools.NET.Extra.AssetsManager
$null = $manager.LoadClassPackage($tpkPath)

$needleU8 = [System.Text.Encoding]::UTF8.GetBytes($Needle)
$needleU16 = [System.Text.Encoding]::Unicode.GetBytes($Needle)

function Contains-Bytes([byte[]]$hay, [byte[]]$needle) {
    if ($null -eq $hay -or $hay.Length -lt $needle.Length) { return $false }
    for ($i = 0; $i -le $hay.Length - $needle.Length; $i++) {
        $m = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($hay[$i + $j] -ne $needle[$j]) { $m = $false; break }
        }
        if ($m) { return $true }
    }
    return $false
}

$files = Get-ChildItem -LiteralPath $Root -File
Write-Host ("[DIAG] Scanning {0} files for: {1}" -f $files.Count, $Needle)
$found = New-Object System.Collections.ArrayList
$idx = 0
foreach ($f in $files) {
    $idx++
    if ($idx % 50 -eq 0) { Write-Host ("  ... {0}/{1}" -f $idx, $files.Count) }
    try {
        $inst = $manager.LoadBundleFile($f.FullName)
        $afiCount = $inst.file.BlockAndDirInfo.DirectoryInfos.Count
        for ($i = 0; $i -lt $afiCount; $i++) {
            $dir = $inst.file.BlockAndDirInfo.DirectoryInfos[$i]
            try {
                $reader = $inst.file.DataReader
                if ($null -eq $reader) { continue }
                $reader.Position = $dir.Offset
                $bytes = $reader.ReadBytes([int][Math]::Min($dir.DecompressedSize, 50MB))
                if (Contains-Bytes $bytes $needleU8) {
                    $msg = "{0} → {1} (utf8)" -f $f.Name, $dir.Name
                    [void]$found.Add($msg); Write-Host "  HIT: $msg"
                } elseif (Contains-Bytes $bytes $needleU16) {
                    $msg = "{0} → {1} (utf16)" -f $f.Name, $dir.Name
                    [void]$found.Add($msg); Write-Host "  HIT: $msg"
                }
            } catch {}
        }
        try { $inst.file.Reader.Close() } catch {}
        $manager.UnloadBundleFile($f.FullName)
    } catch {}
}
Write-Host ("[DONE] {0} hits" -f $found.Count)
$found | ForEach-Object { Write-Host "  $_" }
