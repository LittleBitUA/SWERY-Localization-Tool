$dll = 'C:/Users/bidlov/AppData/Local/Temp/uelib/extracted/lib/net8.0/Eliot.UELib.dll'
[System.Reflection.Assembly]::LoadFrom($dll) | Out-Null
$pkg = [UELib.UnrealLoader]::LoadPackage('C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk', [System.IO.FileAccess]::Read)
$pkg.InitializePackage()
$names = $pkg.Names | ForEach-Object { $_.Name }
Write-Host ("name 116 = " + $names[116])
Write-Host ("name 113 = " + $names[113])
Write-Host ("name 117 = " + $names[117])
Write-Host ("name 45 = " + $names[45])
Write-Host ("name 33 = " + $names[33])
for ($i = 0; $i -lt $names.Count; $i++) {
    if ($names[$i] -eq "None") { Write-Host ("None at idx=" + $i); break }
}
