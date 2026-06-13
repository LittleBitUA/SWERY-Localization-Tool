# Pipeline для D4: для кожного LOC-пакета з CookedPCConsole/ — decompress
# через Gildor, потім парсинг тексту скриптом d4-text-export.ps1 у JSON.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$GameDir,    # ...\D4 .. \Ms01Game\CookedPCConsole
    [Parameter(Mandatory=$true)] [string]$OutDir,
    [Parameter(Mandatory=$true)] [string]$UelibDll
)

$ErrorActionPreference = "Stop"
$decompress = Join-Path $PSScriptRoot "decompress.exe"
$exportScript = Join-Path (Split-Path $PSScriptRoot) "d4-text-export.ps1"
$decDir = Join-Path $OutDir "decompressed"
$jsonDir = Join-Path $OutDir "json"
foreach ($d in @($decDir, $jsonDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

# 14 msg-пакетів + 2 LOC-пакети.
$names = @(
    "msg_en_cmn_SF.upk",
    "msg_en_s1e0_SF.upk", "msg_en_s1e1_SF.upk", "msg_en_s1e2_SF.upk",
    "msg_en_dlc_9100_000_SF.upk", "msg_en_dlc_9105_000_SF.upk",
    "msg_en_dlc_9110_000_SF.upk", "msg_en_dlc_9115_000_SF.upk",
    "msg_en_dlc_9120_000_SF.upk", "msg_en_dlc_9125_000_SF.upk",
    "msg_en_dlc_9130_000_SF.upk", "msg_en_dlc_9135_000_SF.upk",
    "msg_en_dlc_9190_000_SF.upk", "msg_en_dlc_9191_000_SF.upk"
)

$summary = New-Object System.Collections.ArrayList
foreach ($n in $names) {
    $src = Join-Path $GameDir $n
    if (-not (Test-Path $src)) {
        Write-Host "[SKIP] $n — not found"
        continue
    }
    $dec = Join-Path $decDir $n
    if (-not (Test-Path $dec)) {
        Write-Host "[DECOMPRESS] $n"
        # NB: PowerShell розриває «-out=value» якщо не закласти у лапки.
        & $decompress "-out=$decDir" $src 2>&1 | Out-Null
    }
    $jsonOut = Join-Path $jsonDir ($n -replace "\.upk$", ".json")
    Write-Host "[EXTRACT] $n -> $jsonOut"
    & "C:\PowerShell-7\pwsh.exe" -NoProfile -File $exportScript -SrcUpk $dec -OutJson $jsonOut -UelibDll $UelibDll 2>&1 |
        Where-Object { $_ -match "RESULT_JSON|\[STEP\] Extracted" } |
        ForEach-Object { "    $_" }
    if (Test-Path $jsonOut) {
        $bytes = (Get-Item $jsonOut).Length
        $entries = (Get-Content -Raw $jsonOut | ConvertFrom-Json).Count
        [void]$summary.Add([pscustomobject]@{ name = $n; entries = $entries; bytes = $bytes })
    }
}

Write-Host ""
Write-Host "===== SUMMARY ====="
$summary | Format-Table -AutoSize
$total = ($summary | Measure-Object -Property entries -Sum).Sum
Write-Host ("Total messages: {0}" -f $total)
