$dll = 'C:/Users/bidlov/AppData/Local/Temp/uelib/extracted/lib/net8.0/Eliot.UELib.dll'
[System.Reflection.Assembly]::LoadFrom($dll) | Out-Null
$pkg = [UELib.UnrealLoader]::LoadPackage('C:/Users/bidlov/AppData/Local/Temp/d4_translate/decompressed/msg_en_cmn_SF.upk', [System.IO.FileAccess]::Read)
$pkg.InitializePackage()
$s = $pkg.Summary
Write-Host ("ExportsOffset=$($s.ExportsOffset) ExportsCount=$($s.ExportsCount)")
for ($i = 0; $i -lt 4; $i++) {
    $e = $pkg.Exports[$i]
    Write-Host ("  [$i] $($e.ClassName) $($e.ObjectName) SerialSize=$($e.SerialSize) SerialOffset=$($e.SerialOffset)")
}
