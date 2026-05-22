# THE MISSING — Assembly-CSharp.dll string-літерали extract.
#
# Витягує всі ldstr-літерали з усіх методів та static field initializers
# у .NET-збірці. Для кожного — TypeFullName, MethodName, IL-offset, value.
# Виводить JSON формату:
#   {
#     "ok": true,
#     "dll": "...",
#     "items": [
#       { "id": 0, "type": "...", "method": "...", "offset": "0x001F", "original": "..." },
#       ...
#     ]
#   }
#
# `id` — стабільний номер позиції у DLL (індекс ldstr-інструкції у послідовному
# обході типів/методів). Використовується pair-key для apply: (id, original).
# Apply робить sanity check на original — якщо DLL змінилась, item пропускається.
#
# Параметри:
#   -DllPath      : повний шлях до DLL
#   -UabeaDir     : тека з Mono.Cecil.dll
#   -OutFile      : куди писати JSON
#   -MinLength    : мінімум довжини рядка для включення (default 1)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DllPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [Parameter(Mandatory=$true)] [string]$OutFile,
    [int]$MinLength = 1
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DllPath)) { throw "DLL not found: $DllPath" }
$cecil = Join-Path $UabeaDir "Mono.Cecil.dll"
if (-not (Test-Path $cecil)) { throw "Mono.Cecil.dll not found in $UabeaDir" }
$null = [System.Reflection.Assembly]::LoadFrom($cecil)

Write-Step "Loading $DllPath..."
$resolver = New-Object Mono.Cecil.DefaultAssemblyResolver
$resolver.AddSearchDirectory((Split-Path $DllPath -Parent))
$rp = New-Object Mono.Cecil.ReaderParameters
$rp.AssemblyResolver = $resolver
$rp.ReadSymbols = $false
$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($DllPath, $rp)

$items = New-Object System.Collections.ArrayList
$id = 0
$typesScanned = 0
$methodsScanned = 0

function Walk-Type {
    param($type)
    $script:typesScanned++
    $fullName = $type.FullName
    foreach ($m in $type.Methods) {
        $script:methodsScanned++
        if (-not $m.HasBody) { continue }
        foreach ($ins in $m.Body.Instructions) {
            if ($ins.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Ldstr) { continue }
            $val = [string]$ins.Operand
            if ($null -eq $val) { continue }
            if ($val.Length -lt $MinLength) { continue }
            [void]$script:items.Add([pscustomobject]@{
                id = $script:id
                type = $fullName
                method = $m.Name
                offset = ("0x{0:X4}" -f $ins.Offset)
                original = $val
            })
            $script:id++
        }
    }
    foreach ($nested in $type.NestedTypes) { Walk-Type $nested }
}

foreach ($module in $asm.Modules) {
    Write-Diag "Module: $($module.Name), types=$($module.Types.Count)"
    foreach ($t in $module.Types) { Walk-Type $t }
}

Write-Step ("Extracted {0} ldstr from {1} types ({2} methods)" -f $items.Count, $typesScanned, $methodsScanned)

$payload = [pscustomobject]@{
    ok = $true
    dll = $DllPath
    typesScanned = $typesScanned
    methodsScanned = $methodsScanned
    total = $items.Count
    items = $items.ToArray()
}
# WriteAllText зберігає UTF-8 без BOM — readable з нашого ts через ipcRenderer.
$json = $payload | ConvertTo-Json -Depth 6 -Compress
$dir = Split-Path $OutFile -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host ("[STEP] Wrote {0:N0} entries to {1}" -f $items.Count, $OutFile)
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; total = $items.Count; outFile = $OutFile } | ConvertTo-Json -Compress))
exit 0
