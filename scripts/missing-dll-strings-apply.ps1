# THE MISSING — Assembly-CSharp.dll string-літерали apply (import).
#
# Бере JSON з парами {id, original, replacement} і патчить ldstr-операнди
# у DLL за тим самим порядком, що дав extract. Sanity check: якщо
# Mono.Cecil бачить інший original у тій позиції — item пропускається з
# причиною (DLL update / hash mismatch).
#
# Формат InputJson:
#   {
#     "edits": [
#       { "id": 5, "original": "Hello", "replacement": "Привіт" },
#       ...
#     ]
#   }
#
# Параметри:
#   -DllPath     : шлях до DLL
#   -UabeaDir    : тека з Mono.Cecil.dll
#   -InputJson   : шлях до JSON з edits
#   -DryRun      : (опц.) лише валідація, без запису

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DllPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$InputJson,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DllPath))    { throw "DLL not found: $DllPath" }
if (-not (Test-Path $InputJson))  { throw "InputJson not found: $InputJson" }
$cecil = Join-Path $UabeaDir "Mono.Cecil.dll"
if (-not (Test-Path $cecil)) { throw "Mono.Cecil.dll not found in $UabeaDir" }
$null = [System.Reflection.Assembly]::LoadFrom($cecil)

$raw = [System.IO.File]::ReadAllText($InputJson, [System.Text.Encoding]::UTF8)
$payload = $raw | ConvertFrom-Json
$edits = @($payload.edits)
if ($null -eq $edits -or $edits.Count -eq 0) { throw "InputJson: edits[] empty" }
Write-Diag "Edits to apply: $($edits.Count)"

# Edits → map by id для O(1) lookup. Обхід DLL послідовно, на кожен
# ldstr перевіряємо if id у map → apply.
$editsById = @{}
foreach ($e in $edits) {
    $editsById[[int]$e.id] = $e
}

# Завантажуємо DLL з ReadWrite, щоб AssemblyDefinition.Write зміг писати назад
# у той самий файл (інакше потрібно у tmp + rename).
$resolver = New-Object Mono.Cecil.DefaultAssemblyResolver
$resolver.AddSearchDirectory((Split-Path $DllPath -Parent))
$rp = New-Object Mono.Cecil.ReaderParameters
$rp.AssemblyResolver = $resolver
$rp.ReadSymbols = $false
$rp.ReadWrite = $true
$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($DllPath, $rp)

$applied = 0
$skipped = New-Object System.Collections.ArrayList
$id = 0

function Walk-Type {
    param($type)
    foreach ($m in $type.Methods) {
        if (-not $m.HasBody) { continue }
        foreach ($ins in $m.Body.Instructions) {
            if ($ins.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Ldstr) { continue }
            if ($script:editsById.ContainsKey($script:id)) {
                $edit = $script:editsById[$script:id]
                $current = [string]$ins.Operand
                if ($current -ne [string]$edit.original) {
                    [void]$script:skipped.Add([pscustomobject]@{
                        id = $script:id
                        type = $type.FullName
                        method = $m.Name
                        offset = ("0x{0:X4}" -f $ins.Offset)
                        reason = "original mismatch — DLL likely changed since extract"
                        expected = $edit.original
                        actual = $current
                    })
                } else {
                    $ins.Operand = [string]$edit.replacement
                    $script:applied++
                }
            }
            $script:id++
        }
    }
    foreach ($nested in $type.NestedTypes) { Walk-Type $nested }
}

foreach ($module in $asm.Modules) {
    foreach ($t in $module.Types) { Walk-Type $t }
}

Write-Step ("Applied {0} edits, skipped {1}" -f $applied, $skipped.Count)

if ($DryRun) {
    $asm.Dispose()
    $summary = [pscustomobject]@{
        ok = $true; dryRun = $true; applied = $applied; skipped = $skipped.ToArray()
    }
    Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
    exit 0
}

if ($applied -eq 0) {
    $asm.Dispose()
    $summary = [pscustomobject]@{
        ok = $false; reason = "no-applied"; applied = 0; skipped = $skipped.ToArray()
    }
    Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
    exit 1
}

# Backup один раз — `.dll.bak` поряд із DLL. Якщо вже існує — не перезаписуємо.
$bak = $DllPath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $DllPath -Destination $bak -Force
    Write-Diag "Backup -> $bak"
}

# AssemblyDefinition.Write() у ReadWrite mode пише прямо у відкритий файл.
$asm.Write()
$asm.Dispose()

$outSize = (Get-Item $DllPath).Length
Write-Step ("DONE -> {0} ({1:N0} bytes)" -f $DllPath, $outSize)
$summary = [pscustomobject]@{
    ok = $true; dryRun = $false; applied = $applied; skipped = $skipped.ToArray()
    bak = $bak; size = $outSize
}
Write-Host ("RESULT_JSON: " + ($summary | ConvertTo-Json -Depth 6 -Compress))
exit 0
