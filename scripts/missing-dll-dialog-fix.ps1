# THE MISSING — IL patch для діалогових / chat пухирів.
#
# Ключова знахідка: chat-UI (Messenger) використовує клас TheMISSING.UI.Ballon
# (НЕ FixedBallon — той тільки для overhead-dialogue над персонажами).
#
# Ballon має enum SizeControlType:
#   0 = UseWidthAndHeightPixcels — ширина береться з field `Width` (default 128px).
#   1 = UseCharAndLineCounts     — ширина = m_CharacterCount × fontSize.
#   2 = UseTextInfo              — ширина = TextExGenerator.PreferredWidth + 2.
#
# Якщо у prefab серіалізовано SizeControlType=0 або 1, UA-текст обрізається на
# фіксованому maxX (бо Width/CharacterCount розраховувалися під короткі EN).
# UseTextInfo (2) — це режим де bubble автоматично адаптується під фактичний
# текст. Це те, що нам треба.
#
# Замість патчити серіалізовану дату у тисячах prefab'ів, патчимо IL-логіку
# Ballon.CheckProperties: V_0 = SizeControlType → ldc.i4.2 (примусово case 2).
# Метод викликається в Adjustment(), що тригериться в Update() при зміні тексту.
#
# Параметри:
#   -DllPath, -UabeaDir, -DryRun, -Revert

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$DllPath,
    [Parameter(Mandatory=$true)] [string]$UabeaDir,
    [switch]$DryRun,
    [switch]$Revert,
    [switch]$Status
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $DllPath)) { throw "DLL not found: $DllPath" }
$cecil = Join-Path $UabeaDir "Mono.Cecil.dll"
if (-not (Test-Path $cecil)) { throw "Mono.Cecil.dll not found in $UabeaDir" }
$null = [System.Reflection.Assembly]::LoadFrom($cecil)

# Status mode: ні revert, ні patch — лише check чи перші інструкції
# CheckProperties уже містять hardcoded `ldc.i4.2` (= patched), або ще
# мають оригінальні `ldarg.0; ldfld SizeControlType` (= clean).
if ($Status) {
    $resolver = New-Object Mono.Cecil.DefaultAssemblyResolver
    $resolver.AddSearchDirectory((Split-Path $DllPath -Parent))
    $rp = New-Object Mono.Cecil.ReaderParameters
    $rp.AssemblyResolver = $resolver
    $rp.ReadSymbols = $false
    $asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($DllPath, $rp)
    function Check-Patched {
        param($asm, [string]$typeName)
        foreach ($module in $asm.Modules) {
            foreach ($t in $module.Types) {
                if ($t.FullName -ne $typeName) { continue }
                foreach ($m in $t.Methods) {
                    if ($m.Name -ne 'CheckProperties') { continue }
                    $instrs = @($m.Body.Instructions)
                    if ($instrs.Count -lt 3) { return $false }
                    return ($instrs[0].OpCode -eq [Mono.Cecil.Cil.OpCodes]::Nop -and $instrs[1].OpCode -eq [Mono.Cecil.Cil.OpCodes]::Ldc_I4_2)
                }
            }
        }
        return $false
    }
    function Check-WordWrapGetter {
        param($asm)
        foreach ($module in $asm.Modules) {
            foreach ($t in $module.Types) {
                if ($t.FullName -ne 'TheMISSING.UI.TextExGenerator') { continue }
                foreach ($m in $t.Methods) {
                    if ($m.Name -ne 'get_WordWrapType') { continue }
                    $instrs = @($m.Body.Instructions)
                    return ($instrs.Count -eq 2 -and $instrs[0].OpCode -eq [Mono.Cecil.Cil.OpCodes]::Ldc_I4_1)
                }
            }
        }
        return $false
    }
    $a = Check-Patched $asm 'TheMISSING.UI.Ballon'
    $b = Check-Patched $asm 'TheMISSING.UI.BallonController'
    $w = Check-WordWrapGetter $asm
    $asm.Dispose()
    $bakExists = Test-Path ($DllPath + '.bak')
    $allPatched = $a -and $b -and $w
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; patched = $allPatched; ballon = $a; ballonController = $b; wordWrap = $w; bakExists = $bakExists } | ConvertTo-Json -Compress))
    exit 0
}

if ($Revert) {
    $bak = $DllPath + ".bak"
    if (-not (Test-Path $bak)) { throw "Backup not found: $bak" }
    Copy-Item -LiteralPath $bak -Destination $DllPath -Force
    Write-Step "Reverted DLL from $bak"
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; reverted = $true; from = $bak } | ConvertTo-Json -Compress))
    exit 0
}

$resolver = New-Object Mono.Cecil.DefaultAssemblyResolver
$resolver.AddSearchDirectory((Split-Path $DllPath -Parent))
$rp = New-Object Mono.Cecil.ReaderParameters
$rp.AssemblyResolver = $resolver
$rp.ReadSymbols = $false
$rp.ReadWrite = $true
$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($DllPath, $rp)

$patches = New-Object System.Collections.ArrayList

function Find-Method {
    param($asm, [string]$typeName, [string]$methodName)
    foreach ($module in $asm.Modules) {
        foreach ($t in $module.Types) {
            $r = Find-MethodInType $t $typeName $methodName
            if ($r) { return $r }
        }
    }
    return $null
}
function Find-MethodInType {
    param($type, [string]$typeName, [string]$methodName)
    if ($type.FullName -eq $typeName) {
        foreach ($m in $type.Methods) { if ($m.Name -eq $methodName) { return $m } }
    }
    foreach ($n in $type.NestedTypes) {
        $r = Find-MethodInType $n $typeName $methodName
        if ($r) { return $r }
    }
    return $null
}

# ── Ballon.CheckProperties: hardcode V_0 (local SizeControlType var) на 2 ──
#
# Patern першого пакету (з IL dump):
#   IL_0000: ldarg.0
#   IL_0001: ldfld   SizeControlType
#   IL_0006: stloc.0
#
# Заміна:
#   IL_0000: nop           (займаємо місце ldarg.0)
#   IL_0001: ldc.i4.2      (замість ldfld — кладемо 2 на стек)
#   ...                   (інші 4 байти ldfld залишаються невикористаними — це
#                           не страшно, бо ми Replace одну інструкцію цілком,
#                           Cecil сам перерахує offsets).
#   IL_0006: stloc.0       (V_0 = 2)
function Patch-Ballon {
    param($asm)
    $m = Find-Method $asm 'TheMISSING.UI.Ballon' 'CheckProperties'
    if ($null -eq $m) { throw "Ballon.CheckProperties not found" }
    $instrs = @($m.Body.Instructions)
    if ($instrs.Count -lt 3) { throw "Ballon.CheckProperties body too small" }
    $i0 = $instrs[0]; $i1 = $instrs[1]; $i2 = $instrs[2]
    if ($i0.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Ldarg_0) { Write-Warning "Patch-Ballon: IL_0000 не ldarg.0 — вже застосовано?"; return $false }
    if ($i1.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Ldfld) { Write-Warning "Patch-Ballon: IL_0001 не ldfld"; return $false }
    $fr = $i1.Operand -as [Mono.Cecil.FieldReference]
    if ($null -eq $fr -or $fr.FullName -notmatch 'Ballon::SizeControlType$') {
        Write-Warning "Patch-Ballon: ldfld не на SizeControlType ($($fr.FullName))"; return $false
    }
    if ($i2.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Stloc_0) { Write-Warning "Patch-Ballon: IL_0006 не stloc.0"; return $false }
    [void]$patches.Add([pscustomobject]@{ where = 'Ballon.CheckProperties'; offset = '0x0000-0x0006'; from = 'this.SizeControlType→V_0'; to = '2 (UseTextInfo)→V_0' })
    if (-not $DryRun) {
        $ilp = $m.Body.GetILProcessor()
        $newLdc = [Mono.Cecil.Cil.Instruction]::Create([Mono.Cecil.Cil.OpCodes]::Ldc_I4_2)
        $newNop = [Mono.Cecil.Cil.Instruction]::Create([Mono.Cecil.Cil.OpCodes]::Nop)
        $ilp.Replace($i1, $newLdc)
        $ilp.Replace($i0, $newNop)
    }
    return $true
}

# Той самий патерн для BallonController.CheckProperties — ім_овірно, інше
# місце де bubble використовується. Подивимось чи там теж є V_0 = SizeControlType
# на IL_0000.
function Patch-BallonController {
    param($asm)
    $m = Find-Method $asm 'TheMISSING.UI.BallonController' 'CheckProperties'
    if ($null -eq $m) { Write-Diag "BallonController.CheckProperties not found — skipping"; return $false }
    $instrs = @($m.Body.Instructions)
    if ($instrs.Count -lt 3) { return $false }
    $i0 = $instrs[0]; $i1 = $instrs[1]; $i2 = $instrs[2]
    if ($i0.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Ldarg_0) { return $false }
    if ($i1.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Ldfld) { return $false }
    $fr = $i1.Operand -as [Mono.Cecil.FieldReference]
    if ($null -eq $fr -or $fr.FullName -notmatch 'SizeControlType$') { return $false }
    if ($i2.OpCode -ne [Mono.Cecil.Cil.OpCodes]::Stloc_0) { return $false }
    [void]$patches.Add([pscustomobject]@{ where = 'BallonController.CheckProperties'; offset = '0x0000-0x0006'; from = 'this.SizeControlType→V_0'; to = '2 (UseTextInfo)→V_0' })
    if (-not $DryRun) {
        $ilp = $m.Body.GetILProcessor()
        $newLdc = [Mono.Cecil.Cil.Instruction]::Create([Mono.Cecil.Cil.OpCodes]::Ldc_I4_2)
        $newNop = [Mono.Cecil.Cil.Instruction]::Create([Mono.Cecil.Cil.OpCodes]::Nop)
        $ilp.Replace($i1, $newLdc)
        $ilp.Replace($i0, $newNop)
    }
    return $true
}

# ── TextExSettings.CheckWordWrap: повністю переписуємо на word-wrap для UA ──
#
# Оригінальна логіка — японська типографія: пробіл вважається пунктуацією,
# wrap дозволено МІЖ будь-якими двома CJK-chars, заборонено перед пунктуацією.
# Це дає character-wrap для UA: "пот / ребувала", "як / ий".
#
# Перепишемо тіло методу повністю:
#   bool CheckWordWrap(generator, current, prev) {
#       if (IsIgonreLetterSpace(current, prev)) return true;
#       return Char.IsWhiteSpace(prev.Char) || Char.IsWhiteSpace(current.Char);
#   }
# Wrap дозволено лише там, де хоча б один з символів — whitespace. Тоді
# GetAutoLineBreakIndex знаходить позицію за пробілом, ParseWordWrap (через
# `false` після whitespace) return там → wrap між словами.
function Patch-CheckWordWrap {
    param($asm)
    $m = Find-Method $asm 'TheMISSING.UI.TextExSettings' 'CheckWordWrap'
    if ($null -eq $m) { Write-Warning "TextExSettings.CheckWordWrap not found"; return $false }

    # Знаходимо потрібні references вже з модуля (вони присутні у DLL, бо
    # використовуються в оригінальному методі / в інших методах класу).
    $module = $m.Module
    $isIgnoreRef = $null
    foreach ($mm in $m.DeclaringType.Methods) {
        if ($mm.Name -eq 'IsIgonreLetterSpace') { $isIgnoreRef = $mm; break }
    }
    if ($null -eq $isIgnoreRef) { Write-Warning "IsIgonreLetterSpace not found"; return $false }

    # Resolve TextExCharacter.get_Char (з module references).
    $charField = $null
    foreach ($t2 in $module.Types) {
        if ($t2.FullName -eq 'TheMISSING.UI.TextExCharacter') {
            foreach ($mm in $t2.Methods) {
                if ($mm.Name -eq 'get_Char') { $charField = $mm; break }
            }
            if ($charField) { break }
        }
    }
    if ($null -eq $charField) { Write-Warning "TextExCharacter.get_Char not found"; return $false }

    # Resolve System.Char.IsWhiteSpace(char) — імпортуємо через mscorlib.
    $charType = [System.Type]::GetType('System.Char')
    $isWsInfo = $charType.GetMethod('IsWhiteSpace', [Type[]]@([char]))
    $isWsRef = $module.ImportReference($isWsInfo)

    # Sanity: чи метод уже патчений (тіло короткіше за оригінал — наш rewrite).
    $instrs = @($m.Body.Instructions)
    if ($instrs.Count -lt 10) { Write-Warning "CheckWordWrap уже спрощений (вже патчено?)"; return $false }

    [void]$patches.Add([pscustomobject]@{ where = 'TextExSettings.CheckWordWrap'; offset = 'rewrite'; from = 'japanese-style char-wrap'; to = 'whitespace-only word-wrap' })

    if (-not $DryRun) {
        # Видаляємо все тіло (включно з V_0, V_1 локалами).
        $m.Body.Instructions.Clear()
        $m.Body.Variables.Clear()
        $m.Body.ExceptionHandlers.Clear()
        $ilp = $m.Body.GetILProcessor()
        # if (IsIgonreLetterSpace(current, prev)) return true;
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldarg_0))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldarg_2))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldarg_3))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Call, $isIgnoreRef))
        # br false → skip return-true
        $brFalseTarget = $ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldarg_3)
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Brfalse, $brFalseTarget))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldc_I4_1))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ret))
        # prev.get_Char()
        $ilp.Append($brFalseTarget)
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Callvirt, $charField))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Call, $isWsRef))
        # if (prevIsWs) goto returnTrue
        $returnTrue = $ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldc_I4_1)
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Brtrue, $returnTrue))
        # else: return IsWhiteSpace(cur.Char)
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldarg_2))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Callvirt, $charField))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Call, $isWsRef))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ret))
        # returnTrue: return true
        $ilp.Append($returnTrue)
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ret))
        # Перерахувати offsets — Cecil робить це автоматично на Write().
    }
    return $true
}

[void](Patch-Ballon $asm)
[void](Patch-BallonController $asm)

# ── Word-wrap fix: get_WordWrapType завжди → 1 (Default) ─────────────────────
#
# Оригінал — getter повертає field `wordWrap`, який у prefab'і пухира
# серіалізовано як 0 (None). Тоді CheckWordWrap (через bit0=0) завжди
# false → GetAutoLineBreakIndex робить single-char wrap (= char-wrap для UA).
#
# Якщо завжди повертати 1 (Default), CheckWordWrap гілка `IsSeparator
# (prev) || IsSeparator(cur)` → goto prohibits → return false (bo bit1=0).
# Тобто FALSE на whitespace, TRUE на не-separator. ParseWordWrap йде
# назад поки TRUE, на whitespace зупиняється → wrap між словами.
#
# Простий rewrite body цього геттера (2 інструкції): ldc.i4.1; ret.
function Patch-WordWrapTypeGetter {
    param($asm)
    $m = Find-Method $asm 'TheMISSING.UI.TextExGenerator' 'get_WordWrapType'
    if ($null -eq $m) { Write-Warning "TextExGenerator.get_WordWrapType not found"; return $false }
    $instrs = @($m.Body.Instructions)
    # Перевір що оригінал ще на місці (ldarg.0; ldfld; ret = 3 інструкції).
    if ($instrs.Count -eq 2 -and $instrs[0].OpCode -eq [Mono.Cecil.Cil.OpCodes]::Ldc_I4_1) {
        Write-Diag "WordWrapType getter уже патчений"
        return $false
    }
    [void]$patches.Add([pscustomobject]@{ where = 'TextExGenerator.get_WordWrapType'; offset = 'rewrite'; from = 'return this.wordWrap'; to = 'return 1 (Default)' })
    if (-not $DryRun) {
        $m.Body.Instructions.Clear()
        $m.Body.Variables.Clear()
        $m.Body.ExceptionHandlers.Clear()
        $ilp = $m.Body.GetILProcessor()
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ldc_I4_1))
        $ilp.Append($ilp.Create([Mono.Cecil.Cil.OpCodes]::Ret))
    }
    return $true
}

[void](Patch-WordWrapTypeGetter $asm)

Write-Step ("Patches planned: {0}" -f $patches.Count)

if ($DryRun) {
    $asm.Dispose()
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; dryRun = $true; patches = $patches.ToArray() } | ConvertTo-Json -Depth 6 -Compress))
    exit 0
}

if ($patches.Count -eq 0) {
    $asm.Dispose()
    Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = 0; reason = "nothing-to-patch" } | ConvertTo-Json -Compress))
    exit 0
}

$bak = $DllPath + ".bak"
if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $DllPath -Destination $bak -Force
    Write-Diag "Backup -> $bak"
}
$asm.Write()
$asm.Dispose()

$outSize = (Get-Item $DllPath).Length
Write-Step ("DONE -> {0} ({1:N0} bytes)" -f $DllPath, $outSize)
Write-Host ("RESULT_JSON: " + ([pscustomobject]@{ ok = $true; applied = $patches.Count; bak = $bak; size = $outSize; patches = $patches.ToArray() } | ConvertTo-Json -Depth 6 -Compress))
exit 0
