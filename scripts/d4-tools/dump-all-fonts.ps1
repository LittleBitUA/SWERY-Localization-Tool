# Дампить ВСІ шрифти з Ms01Utility_LOC_INT.upk — UFont meta + перший атлас.
# Сирий вивід → JSON + alpha PNG для кожного шрифта (для візуального preview).
[CmdletBinding()]
param(
    [string]$SrcUpk = "C:/Users/bidlov/AppData/Local/Temp/d4_dec/Ms01Utility_LOC_INT.upk",
    [string]$OutDir = "C:/Users/bidlov/AppData/Local/Temp/d4_font_test/all_fonts",
    [string]$UelibDll = "C:/Users/bidlov/AppData/Local/Temp/uelib/extracted/lib/net8.0/Eliot.UELib.dll"
)

$ErrorActionPreference = "Stop"
$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$fonts = $pkg.Exports | Where-Object { $_.ClassName -eq "Font" }
Write-Host ("Found {0} fonts" -f $fonts.Count)

$dumpUfontScript = Join-Path $PSScriptRoot "dump-ufont.ps1"
$dumpTexScript = Join-Path $PSScriptRoot "dump-texture2d.ps1"

foreach ($f in $fonts) {
    $name = $f.ObjectName.ToString()
    $jsonPath = Join-Path $OutDir "$name.json"
    Write-Host "==== $name ===="
    & "C:/PowerShell-7/pwsh.exe" -NoProfile -File $dumpUfontScript -SrcUpk $SrcUpk -ObjectName $name -OutJson $jsonPath -UelibDll $UelibDll 2>&1 | Where-Object { $_ -match "RESULT_JSON" }
}

Write-Host "Done. JSON dumps in $OutDir"
