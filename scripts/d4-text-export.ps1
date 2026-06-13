# D4 Text Export — витягає рядки з UE3-пакета `msg_<lang>_*_SF.upk`.
# Парсимо вручну UPropertyTag stream у тілі кожного `Ms01DataMessage`-export,
# бо UELib каже «Array type was not detected» для array<string>.
#
# Вхід — уже uncompressed `.upk` (попередньо прогнаний через
# Gildor's decompress.exe). Витягуємо три перекладні поля:
#   m_aString, m_aWord, m_aVoiceIdStr (всі — array<string>).
# Решту лишаємо як metadata.
#
# Параметри:
#   -SrcUpk    : повний шлях до uncompressed .upk
#   -OutJson   : куди писати JSON-дамп
#   -UelibDll  : шлях до Eliot.UELib.dll
#
# Емітить:
#   [STEP]/[DIAG] + RESULT_JSON у кінці.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$SrcUpk,
    [Parameter(Mandatory=$true)] [string]$OutJson,
    [Parameter(Mandatory=$true)] [string]$UelibDll
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" }
function Write-Diag { param([string]$Msg) Write-Host "[DIAG] $Msg" }

if (-not (Test-Path $SrcUpk))   { throw ".upk not found: $SrcUpk" }
if (-not (Test-Path $UelibDll)) { throw "UELib.dll not found: $UelibDll" }

$null = [System.Reflection.Assembly]::LoadFrom($UelibDll)

Write-Step "Loading $SrcUpk ..."
$pkg = [UELib.UnrealLoader]::LoadPackage($SrcUpk, [System.IO.FileAccess]::Read)
$pkg.InitializePackage()
$cf = $pkg.Summary.CompressionFlags
if ($cf -ne 0) {
    throw "Package is compressed (CompressionFlags=$cf). Run decompress.exe first."
}

# Name lookup: index → string. UELib не дає прямого API name(int) — беремо з
# колекції Names (UNameTableItem).
$names = $pkg.Names | ForEach-Object { $_.Name }
function NameOf([int]$i) {
    if ($i -lt 0 -or $i -ge $names.Count) { return "<bad:$i>" }
    return $names[$i]
}

# Завантажуємо raw bytes файла — простіше парсити, ніж смикати UELib stream.
$bytes = [System.IO.File]::ReadAllBytes($SrcUpk)
function ReadInt32([int]$pos) {
    return [System.BitConverter]::ToInt32($bytes, $pos)
}
function ReadFString([ref]$pos) {
    $len = ReadInt32 $pos.Value
    $pos.Value += 4
    if ($len -eq 0) { return "" }
    if ($len -gt 0) {
        # ASCII (Latin-1) null-terminated. Довжина включає '\0'.
        $s = [System.Text.Encoding]::GetEncoding(1251).GetString($bytes, $pos.Value, $len - 1)
        $pos.Value += $len
        return $s
    } else {
        # UTF-16LE null-terminated. Довжина у `WORD`-юнітах, з '\0\0'.
        $u = -$len
        $s = [System.Text.Encoding]::Unicode.GetString($bytes, $pos.Value, ($u - 1) * 2)
        $pos.Value += $u * 2
        return $s
    }
}

# Збираємо Ms01DataMessage exports.
$msgs = $pkg.Exports | Where-Object { $_.ClassName -eq "Ms01DataMessage" }
Write-Diag ("Found Ms01DataMessage exports: {0}" -f $msgs.Count)

# Поля які тягнемо як array<string>.
$wantedStringArrays = @("m_aString", "m_aWord", "m_aVoiceIdStr")

$items = New-Object System.Collections.ArrayList
$failed = 0

foreach ($e in $msgs) {
    $obj = [pscustomobject]@{
        objectName  = $e.ObjectName.ToString()
        fileName    = $null
        m_aString   = @()
        m_aWord     = @()
        m_aVoiceIdStr = @()
    }
    $body = $e.SerialOffset
    $end = $body + $e.SerialSize
    try {
        # NetIndex (UE3 cooked) — 4 bytes, скіпаємо.
        $p = $body + 4
        while ($p -lt $end) {
            if ($p + 8 -gt $end) { break }
            $nameIdx = ReadInt32 $p; $instIdx = ReadInt32 ($p + 4); $p += 8
            $tagName = NameOf $nameIdx
            if ($tagName -eq "None") { break }
            if ($p + 8 -gt $end) { break }
            $typeIdx = ReadInt32 $p; $typeInst = ReadInt32 ($p + 4); $p += 8
            $tagType = NameOf $typeIdx
            $size = ReadInt32 $p; $p += 4
            $arrIdx = ReadInt32 $p; $p += 4
            $bodyStart = $p
            $bodyEnd = $p + $size

            switch ($tagType) {
                "StrProperty" {
                    if ($tagName -eq "m_strFileName") {
                        $posRef = [ref]$p
                        $obj.fileName = ReadFString $posRef
                    }
                }
                "ArrayProperty" {
                    if ($wantedStringArrays -contains $tagName) {
                        # body: int32 count + count × FString
                        $cnt = ReadInt32 $p; $p += 4
                        $list = New-Object System.Collections.ArrayList
                        for ($i = 0; $i -lt $cnt -and $p -lt $bodyEnd; $i++) {
                            $posRef = [ref]$p
                            $s = ReadFString $posRef
                            $p = $posRef.Value
                            [void]$list.Add($s)
                        }
                        $obj.$tagName = $list.ToArray()
                    }
                }
            }
            # Гарантуємо, що ми перейшли на наступний tag (навіть якщо
            # пропустили розпарсити tag-body).
            $p = $bodyEnd
        }
        [void]$items.Add($obj)
    } catch {
        $failed++
        Write-Diag ("FAIL {0}: {1}" -f $e.ObjectName, $_.Exception.Message)
    }
}

Write-Step ("Extracted {0} entries (failed={1})" -f $items.Count, $failed)

# Зберігаємо JSON.
$outDir = Split-Path -Parent $OutJson
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
# ConvertTo-Json серіалізує 1-елементний масив як одиничний obj. Force-wrap
# до `[...]`, якщо результат не починається з `[`.
$json = $items.ToArray() | ConvertTo-Json -Depth 6
if ($null -eq $json) { $json = "[]" }
elseif ($json -notmatch '^\s*\[') { $json = "[" + $json + "]" }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutJson, $json, $utf8NoBom)
Write-Step ("Wrote {0} ({1:N0} bytes)" -f $OutJson, (Get-Item $OutJson).Length)

$summary = [pscustomobject]@{
    ok = $true
    src = $SrcUpk
    out = $OutJson
    entries = $items.Count
    failed = $failed
}
Write-Host ("RESULT_JSON: " + (ConvertTo-Json -InputObject $summary -Compress))
exit 0
