# Швидкий probe: дамп всіх exports з UELib (ClassName, ObjectName,
# SerialSize, SerialOffset) у JSON. Потрібно щоб Python writer мав
# точну інформацію про export-таблицю.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$SrcUpk,
    [Parameter(Mandatory=$true)] [string]$OutJson,
    [Parameter(Mandatory=$true)] [string]$UelibDll
)

$ErrorActionPreference = "Stop"
$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()

$exports = $pkg.Exports | ForEach-Object {
    [pscustomobject]@{
        index        = $_.Index
        className    = $_.ClassName
        objectName   = $_.ObjectName.ToString()
        serialSize   = [int]$_.SerialSize
        serialOffset = [int]$_.SerialOffset
    }
}

$names = $pkg.Names | ForEach-Object { $_.Name }

$result = [pscustomobject]@{
    headerSize    = [int]$pkg.Summary.HeaderSize
    nameOffset    = [int]$pkg.Summary.NamesOffset
    nameCount     = [int]$pkg.Summary.NamesCount
    importOffset  = [int]$pkg.Summary.ImportsOffset
    importCount   = [int]$pkg.Summary.ImportsCount
    exportOffset  = [int]$pkg.Summary.ExportsOffset
    exportCount   = [int]$pkg.Summary.ExportsCount
    fileSize      = (Get-Item $SrcUpk).Length
    names         = $names
    exports       = $exports
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$json = ConvertTo-Json -InputObject $result -Depth 5
[System.IO.File]::WriteAllText($OutJson, $json, $utf8)
Write-Host "RESULT_JSON: $OutJson  exports=$($exports.Count) names=$($names.Count)"
