$dll = 'C:\Users\bidlov\AppData\Local\Temp\uelib\extracted\lib\net8.0\Eliot.UELib.dll'
$null = [System.Reflection.Assembly]::LoadFrom($dll)
$pkg = [UELib.UnrealLoader]::LoadPackage('C:\Users\bidlov\AppData\Local\Temp\d4_dec\msg_en_s1e0_SF.upk', [System.IO.FileAccess]::Read)
$pkg.InitializePackage()
$exp = $pkg.Exports | Where-Object { $_.ClassName -eq 'Ms01DataMessage' } | Select-Object -First 1
$obj = $pkg.GetIndexObject($exp.Index + 1)
$obj.BeginDeserializing()

Write-Host ("Export SerialSize={0} SerialOffset={1}" -f $exp.SerialSize, $exp.SerialOffset)
Write-Host ("Object BufferSize={0} BufferPosition={1}" -f $obj.GetBufferSize(), $obj.GetBufferPosition())

# Гряний доступ до raw bytes export body — через Buffer (IUnrealStream).
$buf = $obj.GetBuffer()
Write-Host ("Buffer type: {0}" -f $buf.GetType().FullName)

# UnrealPackage.Stream — внутрішній stream що читає raw file. Через нього
# можна позиціонуватись та читати DefaultProperties.
$stream = $pkg.Stream
Write-Host ("Stream: {0}" -f $stream.GetType().FullName)
Write-Host ("Position is settable? {0}" -f ($stream.GetType().GetProperty('Position').CanWrite))

# Перейдемо у SerialOffset і прочитаємо перші 64 байти export body — щоб
# побачити чи це NetIndex + DefaultProperties block.
$stream.Seek($exp.SerialOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
$br = New-Object System.IO.BinaryReader($stream)
Write-Host ''
Write-Host '--- First 64 bytes of export body ---'
$bytes = $br.ReadBytes(64)
($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join ' '
