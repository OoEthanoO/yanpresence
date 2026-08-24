# Writes the cover art of whatever an app is currently playing to a file.
#
# The Windows counterpart of scripts/dump-artwork.applescript. Prints the image
# format on stdout (jpeg, png, ...) and exits non-zero if there is nothing to
# write.
#
# Usage: smtc-artwork.ps1 <app-id-prefix> <output-file>

param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$OutFile
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait(10000)) { throw 'WinRT call timed out' }
  $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.Buffer, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IBuffer, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType

$session = $manager.GetSessions() |
  Where-Object { "$($_.SourceAppUserModelId)".StartsWith($AppId, 'OrdinalIgnoreCase') } |
  Select-Object -First 1
if (-not $session) { throw "No media session for $AppId" }

$props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
if (-not $props -or -not $props.Thumbnail) { throw 'The session published no thumbnail' }

# The thumbnail is a reference, not the bytes: opening it is what makes the app
# produce them.
$stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
if (-not $stream -or $stream.Size -eq 0) { throw 'The thumbnail stream was empty' }

$contentType = "$($stream.ContentType)"
$size = [uint32]$stream.Size
$buffer = New-Object Windows.Storage.Streams.Buffer($size)
$read = Await ($stream.ReadAsync($buffer, $size, [Windows.Storage.Streams.InputStreamOptions]::None)) ([Windows.Storage.Streams.IBuffer])

# IBuffer is not a byte[]; DataReader is the sanctioned way across.
$reader = [Windows.Storage.Streams.DataReader]::FromBuffer($read)
$bytes = New-Object byte[] $read.Length
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($OutFile, $bytes)

$reader.Dispose()
$stream.Dispose()

# Content type comes back as a MIME type; the caller wants the bare extension,
# and defaults to a sniff of the magic bytes when the app declares nothing.
$format = ''
if ($contentType) { $format = $contentType.Split('/')[-1].Trim().ToLowerInvariant() }
if (-not $format -or $format -eq 'octet-stream') {
  if ($bytes.Length -gt 3 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { $format = 'jpeg' }
  elseif ($bytes.Length -gt 7 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $format = 'png' }
  else { $format = 'unknown' }
}
if ($format -eq 'jpg') { $format = 'jpeg' }

Write-Output $format
