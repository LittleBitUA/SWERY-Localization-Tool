# D4 Text Import — пакує JSON з перекладами назад у uncompressed `.upk`.
#
# Алгоритм:
#   1. Прочитати оригінальний uncompressed pkg через UELib (щоб знати позиції
#      export-bodies + name-table для перевірок).
#   2. Знайти у raw bytes файла FObjectExport entry-size (через bootstrap по
#      8-байтовому патерну SerialSize+SerialOffset першого export-а).
#   3. Для кожного Ms01DataMessage:
#        - читаємо original body bytes
#        - парсимо UPropertyTag stream
#        - замінюємо m_aString / m_aWord / m_aVoiceIdStr на нові з JSON
#        - переемітуємо body
#        - cumulatively обчислюємо new SerialOffset
#   4. Будуємо output bytes:
#        - копія header[0..first_export_orig_offset]
#        - patching ExportTable у скопійованому header: для кожного export
#          переписуємо SerialSize + SerialOffset
#        - конкатенуємо нові body bytes у порядку
#   5. Пишемо файл.
#
# ASCII-only strings → залишаємо positive-length FString. Якщо string містить
# non-ASCII (кирилицю, спецсимволи > 0x7E), записуємо як UTF-16LE
# (negative-length).

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$SrcUpk,
    [Parameter(Mandatory=$true)] [string]$JsonPath,
    [Parameter(Mandatory=$true)] [string]$OutUpk,
    [Parameter(Mandatory=$true)] [string]$UelibDll
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

foreach ($p in @($SrcUpk, $JsonPath, $UelibDll)) {
    if (-not (Test-Path $p)) { throw "Not found: $p" }
}

$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)

Write-Step "Loading $SrcUpk ..."
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()
if ($pkg.Summary.CompressionFlags -ne 0) {
    throw "Source is compressed — run decompress.exe first."
}
$names = $pkg.Names | ForEach-Object { $_.Name }

Write-Step "Loading JSON ..."
$jsonText = [System.IO.File]::ReadAllText($JsonPath, [System.Text.Encoding]::UTF8)
$trans = $jsonText | ConvertFrom-Json
if ($trans -isnot [System.Array]) { $trans = @($trans) }
$transByName = @{}
foreach ($t in $trans) { $transByName[$t.objectName] = $t }
Write-Diag ("JSON entries: {0}" -f $trans.Count)

$bytes = [System.IO.File]::ReadAllBytes($SrcUpk)
function ReadInt32([byte[]]$src, [int]$pos) {
    return [System.BitConverter]::ToInt32($src, $pos)
}

# ── Bootstrap: знайти sizeof(FObjectExport) у поточному файлі ───────────
# Беремо перші 2 exports з UELib (точні SerialSize/Offset) і шукаємо їх
# як 8-байтовий патерн у байтах [ExportOffset..ExportOffset + 4096).
$exportsOffset = $pkg.Summary.ExportOffset
$exp0 = $pkg.Exports[0]
$exp1 = $pkg.Exports[1]
$pat0 = New-Object byte[] 8
[System.BitConverter]::GetBytes([int32]$exp0.SerialSize).CopyTo($pat0, 0)
[System.BitConverter]::GetBytes([int32]$exp0.SerialOffset).CopyTo($pat0, 4)
$pat1 = New-Object byte[] 8
[System.BitConverter]::GetBytes([int32]$exp1.SerialSize).CopyTo($pat1, 0)
[System.BitConverter]::GetBytes([int32]$exp1.SerialOffset).CopyTo($pat1, 4)

function IndexOf([byte[]]$haystack, [byte[]]$needle, [int]$start) {
    $hLen = $haystack.Length; $nLen = $needle.Length
    for ($i = $start; $i -le $hLen - $nLen; $i++) {
        $ok = $true
        for ($j = 0; $j -lt $nLen; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $ok = $false; break }
        }
        if ($ok) { return $i }
    }
    return -1
}
$pos0 = IndexOf $bytes $pat0 $exportsOffset
$pos1 = IndexOf $bytes $pat1 $exportsOffset
if ($pos0 -lt 0 -or $pos1 -lt 0) {
    throw "Cannot locate FObjectExport SerialSize/Offset markers in bytes."
}
$exportEntrySize = $pos1 - $pos0
# Корекція: pos0 вказує НА SerialSize всередині entry. Позиція початку entry
# для export[0] = pos0 - sizeOfFieldsBeforeSerialSize. Нам потрібен лише
# stride (entry-size) — він однаковий незалежно від того, чи pos дивиться на
# поле SerialSize.
Write-Diag ("FObjectExport stride = $exportEntrySize bytes, SerialSize@$pos0, SerialOffset@$($pos0+4)")
$serialSizeOffsetInEntry = ($pos0 - $exportsOffset) % $exportEntrySize
Write-Diag ("SerialSize @ entry+$serialSizeOffsetInEntry")

# ── Перекодування FString → bytes (UE3 серіалізатор) ───────────────────
function FStringBytes([string]$s) {
    # Encoding policy для D4:
    #  - Latin-1 (≤0xFF) → positive-length 1 byte/char, gra reads as latin-1.
    #    Це покриває як pure ASCII, так і accented latin (ç é ñ etc.) без
    #    збільшення розміру файла.
    #  - Above U+00FF (кирилиця U+04XX, CJK тощо) → UTF-16LE negative-length.
    #    Гра отримує справжні Unicode codepoints і шукає glyph через
    #    UFont.CharRemap.
    if ([string]::IsNullOrEmpty($s)) {
        return [System.BitConverter]::GetBytes([int32]0)
    }
    $needsUtf16 = $false
    foreach ($c in $s.ToCharArray()) {
        if ([int]$c -gt 0xFF) { $needsUtf16 = $true; break }
    }

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    if ($needsUtf16) {
        $bw.Write([int32](-($s.Length + 1)))   # negative = UTF-16, includes null
        $u = [System.Text.Encoding]::Unicode.GetBytes($s)
        $bw.Write($u, 0, $u.Length)
        $bw.Write([uint16]0)
    } else {
        # Latin-1 (ISO-8859-1) — 1 byte per char, дозволяє accent latin.
        $latin1 = [System.Text.Encoding]::GetEncoding(28591).GetBytes($s)
        $bw.Write([int32]($latin1.Length + 1))
        $bw.Write($latin1, 0, $latin1.Length)
        $bw.Write([byte]0)
    }
    $bw.Flush()
    return $ms.ToArray()
}

function NameOf([int]$i) {
    if ($i -lt 0 -or $i -ge $names.Count) { return "<bad:$i>" }
    return $names[$i]
}
function NameIndex([string]$name) {
    for ($i = 0; $i -lt $names.Count; $i++) {
        if ($names[$i] -eq $name) { return $i }
    }
    return -1
}
$noneIdx = NameIndex "None"
if ($noneIdx -lt 0) { throw "NameTable has no 'None' entry — unexpected." }

# ── Будуємо нові body bytes для кожного Ms01DataMessage ────────────────
# Залишаємо незмінним для NOT-перекладених exports і для NOT-string полів.
$newBodies = New-Object 'System.Collections.Generic.Dictionary[int,byte[]]'

function ReadFString([byte[]]$src, [ref]$pos) {
    $len = [System.BitConverter]::ToInt32($src, $pos.Value)
    $pos.Value += 4
    if ($len -eq 0) { return "" }
    if ($len -gt 0) {
        $s = [System.Text.Encoding]::GetEncoding(28591).GetString($src, $pos.Value, $len - 1)
        $pos.Value += $len
        return $s
    } else {
        $u = -$len
        $s = [System.Text.Encoding]::Unicode.GetString($src, $pos.Value, ($u - 1) * 2)
        $pos.Value += $u * 2
        return $s
    }
}

$wantedArrays = @("m_aString", "m_aWord", "m_aVoiceIdStr")

for ($ei = 0; $ei -lt $pkg.Exports.Count; $ei++) {
    $e = $pkg.Exports[$ei]
    if ($e.ClassName -ne "Ms01DataMessage") { continue }
    $objName = $e.ObjectName.ToString()
    $t = $transByName[$objName]
    if ($null -eq $t) {
        Write-Diag "  [$objName] no translation entry — keeping original."
        continue
    }
    $origBody = New-Object byte[] $e.SerialSize
    [Array]::Copy($bytes, $e.SerialOffset, $origBody, 0, $e.SerialSize)

    # Парсимо tag-stream, переписуємо array<string> tags.
    $out = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($out)
    # NetIndex (4 байти) — beep копіюємо як було.
    $bw.Write($origBody, 0, 4)
    $p = 4
    while ($p -lt $origBody.Length) {
        if ($p + 8 -gt $origBody.Length) { break }
        $nameIdx = [System.BitConverter]::ToInt32($origBody, $p)
        $instIdx = [System.BitConverter]::ToInt32($origBody, $p + 4)
        $tagName = NameOf $nameIdx
        # Емітимо заголовок tag-name незмінно — і якщо це None, виходимо.
        $bw.Write($origBody, $p, 8); $p += 8
        if ($tagName -eq "None") { break }
        # Type+SerialSize+ArrayIndex — переписуємо для wanted arrays, інакше
        # копіюємо як було.
        $typeIdx = [System.BitConverter]::ToInt32($origBody, $p)
        $typeInst = [System.BitConverter]::ToInt32($origBody, $p + 4)
        $tagType = NameOf $typeIdx
        $size = [System.BitConverter]::ToInt32($origBody, $p + 8)
        $arrIdx = [System.BitConverter]::ToInt32($origBody, $p + 12)
        $headerEnd = $p + 16
        $bodyEnd = $headerEnd + $size

        if ($tagType -eq "ArrayProperty" -and ($wantedArrays -contains $tagName)) {
            # Build new array body з $t.<tagName>.
            $newList = $t.$tagName
            if ($null -eq $newList) { $newList = @() }
            # PowerShell може unwrap-нути single-element array — force [object[]].
            if ($newList -isnot [System.Array]) { $newList = @($newList) }
            $cnt = $newList.Count
            $abuf = New-Object System.IO.MemoryStream
            $abw = New-Object System.IO.BinaryWriter($abuf)
            $abw.Write([int32]$cnt)
            $debugSizes = New-Object System.Collections.ArrayList
            foreach ($s in $newList) {
                $fb = FStringBytes ([string]$s)
                [void]$debugSizes.Add($fb.Length)
                $abw.Write($fb, 0, $fb.Length)
            }
            $abw.Flush()
            $newArrBytes = $abuf.ToArray()
            if ($ei -le 2) {
                Write-Diag ("    [$objName.$tagName] cnt=$cnt newSize=$($newArrBytes.Length) origSize=$size  perStringSizes=[$($debugSizes -join ',')]")
            }
            # Write tag-header з новим SerialSize.
            $bw.Write([int32]$typeIdx)
            $bw.Write([int32]$typeInst)
            $bw.Write([int32]$newArrBytes.Length)
            $bw.Write([int32]$arrIdx)
            $bw.Write($newArrBytes)
        } else {
            # Копіюємо хвіст tag як було.
            $totalTagLen = 16 + $size
            $bw.Write($origBody, $p, $totalTagLen)
        }
        $p = $bodyEnd
    }
    # Хвіст після None (якщо є — UE3 інколи має trailing 4 bytes).
    if ($p -lt $origBody.Length) {
        $tail = $origBody.Length - $p
        $bw.Write($origBody, $p, $tail)
    }
    $bw.Flush()
    $newBody = $out.ToArray()
    $newBodies[$ei] = $newBody
    if ($ei -le 2 -or $ei -ge $pkg.Exports.Count - 1) {
        Write-Diag ("  [$objName] body: $($e.SerialSize) -> $($newBody.Length) bytes")
    }
}

# ── Build output: header + patched ExportTable + new bodies ────────────
$firstExpOffset = ($pkg.Exports | Measure-Object -Property SerialOffset -Minimum).Minimum
Write-Diag ("First export body offset = $firstExpOffset")
$out = New-Object byte[] 0
$header = New-Object byte[] $firstExpOffset
[Array]::Copy($bytes, 0, $header, 0, $firstExpOffset)

# Compute new SerialOffsets cumulatively (порядок по original SerialOffset).
$sorted = 0..($pkg.Exports.Count - 1) | Sort-Object { $pkg.Exports[$_].SerialOffset }
$newSerialOff = New-Object int[] $pkg.Exports.Count
$newSerialSize = New-Object int[] $pkg.Exports.Count
$cursor = $firstExpOffset
$bodyMap = New-Object 'System.Collections.Generic.Dictionary[int,byte[]]'
foreach ($ei in $sorted) {
    $orig = $pkg.Exports[$ei]
    $newBytes = $null
    if ($newBodies.ContainsKey($ei)) {
        $newBytes = $newBodies[$ei]
    } else {
        $newBytes = New-Object byte[] $orig.SerialSize
        [Array]::Copy($bytes, $orig.SerialOffset, $newBytes, 0, $orig.SerialSize)
    }
    $newSerialOff[$ei] = $cursor
    $newSerialSize[$ei] = $newBytes.Length
    $bodyMap[$ei] = $newBytes
    $cursor += $newBytes.Length
}

# Patch ExportTable у header: для кожного export шукаємо ТОЧНУ позицію
# orig SerialSize+SerialOffset patern і пишемо там new values.
# Це коректно навіть для exports з NetObjects array (variable stride).
$scanStart = $exportsOffset
for ($ei = 0; $ei -lt $pkg.Exports.Count; $ei++) {
    $orig = $pkg.Exports[$ei]
    $pat = New-Object byte[] 8
    [System.BitConverter]::GetBytes([int32]$orig.SerialSize).CopyTo($pat, 0)
    [System.BitConverter]::GetBytes([int32]$orig.SerialOffset).CopyTo($pat, 4)
    $entryPos = IndexOf $header $pat $scanStart
    if ($entryPos -lt 0) {
        throw "Cannot locate ExportTable entry for export[$ei] '$($orig.ObjectName)'"
    }
    [System.BitConverter]::GetBytes([int32]$newSerialSize[$ei]).CopyTo($header, $entryPos)
    [System.BitConverter]::GetBytes([int32]$newSerialOff[$ei]).CopyTo($header, $entryPos + 4)
    $scanStart = $entryPos + 8   # шукаємо наступний entry після цього
}

# Конкатенуємо.
$ms = New-Object System.IO.MemoryStream
$ms.Write($header, 0, $header.Length)
foreach ($ei in $sorted) {
    $body = $bodyMap[$ei]
    $ms.Write($body, 0, $body.Length)
}
[System.IO.File]::WriteAllBytes($OutUpk, $ms.ToArray())
Write-Step ("Wrote {0} ({1:N0} bytes)" -f $OutUpk, (Get-Item $OutUpk).Length)

# Sanity: re-open written file with UELib, перевіримо що exports читаються.
Write-Step "Sanity re-open ..."
$pkg2 = [UELib.UnrealLoader]::LoadPackage($OutUpk, [System.IO.FileAccess]::Read)
$pkg2.InitializePackage()
Write-Diag ("Re-opened: Names={0} Exports={1}" -f $pkg2.Names.Count, $pkg2.Exports.Count)

$summary = [pscustomobject]@{
    ok = $true
    src = $SrcUpk
    out = $OutUpk
    patched = $newBodies.Count
}
Write-Host ("RESULT_JSON: " + (ConvertTo-Json -InputObject $summary -Compress))
exit 0
