# D4 Fonts Extract — portable wrapper що дампить metadata + кожен Texture2D-атлас
# усіх UFont з Ms01Utility_LOC_INT.upk.
#
# Виходи:
#   <OutDir>/Meta/<fontName>.json        — UFont metadata (chars, textures, etc)
#   <OutDir>/Meta/<fontName>.atlas.json   — список Texture2D refs + розмір
#   <OutDir>/Atlases/<fontName>__<texName>.mip0.bin   — raw mip0 BC3/G8 bytes
#   <OutDir>/Atlases/<fontName>__<texName>.props.json — Texture2D properties
#
# Емітить:
#   [STEP]/[DIAG] + RESULT_JSON у кінці.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$SrcUpk,
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UelibDll,
    [Parameter(Mandatory=$true)] [string]$DumpUfontScript,
    [Parameter(Mandatory=$true)] [string]$DumpTextureScript
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$m) Write-Host "[STEP] $m" }

$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()

$metaDir    = Join-Path $OutDir "Meta"
$atlasDir   = Join-Path $OutDir "Atlases"
foreach ($d in @($OutDir, $metaDir, $atlasDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

$fonts = $pkg.Exports | Where-Object { $_.ClassName -eq "Font" }
Write-Host "[INFO] Found $($fonts.Count) UFont"

# Lookup для Texture2D exports по ObjectName.
$texMap = @{}
foreach ($e in $pkg.Exports) {
    if ($e.ClassName -eq "Texture2D") { $texMap[$e.ObjectName.ToString()] = $e }
}

# Імпорти (Texture2D ref може бути import).
$impMap = @{}
foreach ($i in $pkg.Imports) {
    if ($i.ClassName -eq "Texture2D") { $impMap[$i.ObjectName.ToString()] = $i }
}

# Шукаємо pwsh для рекурсивного виклику dump-ufont/dump-texture2d.
$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = "powershell.exe" }

$summary = New-Object System.Collections.ArrayList

foreach ($f in $fonts) {
    $name = $f.ObjectName.ToString()
    Write-Step "$name"
    $jsonPath = Join-Path $metaDir "$name.json"
    # 1. UFont metadata
    & $pwsh -NoProfile -ExecutionPolicy Bypass -File $DumpUfontScript `
        -SrcUpk $SrcUpk -ObjectName $name -OutJson $jsonPath -UelibDll $UelibDll 2>&1 |
        Where-Object { $_ -match "RESULT_JSON|\[DIAG\]" } |
        ForEach-Object { Write-Host "  $_" }

    if (-not (Test-Path $jsonPath)) { continue }

    # 2. Texture2D атласи — ВСІ сторінки. Потрібні для additive-генерації
    # (зберігає orig spec-символи + домальовує кириличні літери).
    $meta = Get-Content -Raw $jsonPath | ConvertFrom-Json
    $textures = @($meta.textures)
    $atlases = New-Object System.Collections.ArrayList
    foreach ($tx in $textures) {
        $texName = $tx.name
        if (-not $texMap.ContainsKey($texName)) { continue }
        $atlasOut = Join-Path $atlasDir $name
        if (-not (Test-Path $atlasOut)) { New-Item -ItemType Directory -Force -Path $atlasOut | Out-Null }
        $binFile = Join-Path $atlasOut "$texName.mip0.bin"
        # Skip якщо вже дамплений (кеш — швидше при перерозпаковуванні).
        if (-not (Test-Path $binFile)) {
            & $pwsh -NoProfile -ExecutionPolicy Bypass -File $DumpTextureScript `
                -SrcUpk $SrcUpk -ObjectName $texName -OutDir $atlasOut -UelibDll $UelibDll 2>&1 |
                Where-Object { $_ -match "SizeX=|Format=|RESULT_JSON" } |
                ForEach-Object { Write-Host "  $_" }
        }
        $propFile = Join-Path $atlasOut "$texName.props.json"
        $sz = 0
        if (Test-Path $binFile) { $sz = (Get-Item $binFile).Length }
        [void]$atlases.Add([pscustomobject]@{
            texName = $texName
            bin = $binFile
            props = $propFile
            size = $sz
        })
    }

    [void]$summary.Add([pscustomobject]@{
        name = $name
        meta = $jsonPath
        textures = $atlases.Count
        charactersCount = $meta.charactersCount
        fontSize = $meta.fontSize
    })
}

$result = [pscustomobject]@{
    ok = $true
    count = $fonts.Count
    items = $summary.ToArray()
    metaDir = $metaDir
    atlasDir = $atlasDir
}
Write-Host ("RESULT_JSON: " + (ConvertTo-Json -InputObject $result -Compress -Depth 6))
exit 0
