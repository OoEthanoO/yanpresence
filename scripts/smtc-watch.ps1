# Long-lived Windows media watcher. Emits one JSON object per line on stdout.
#
# The Windows counterpart of scripts/music-watch.js. Where macOS asks Music.app
# directly over Apple Events, Windows has no scripting interface into the Apple
# Music or Apple TV apps at all -- they are packaged Store apps with no
# automation surface. What they *do* publish is a System Media Transport
# Controls session: the thing that draws the media flyout over the volume
# overlay and lights up the play/pause keys on your keyboard. Every field the
# presence card needs is in there.
#
# Sessions are identified by the publishing app's AUMID, which is how a
# session is known to be Apple Music rather than Spotify or a browser tab.
#
# Run under Windows PowerShell 5.1 (powershell.exe), which can project WinRT
# types directly. PowerShell 7 cannot without the Windows SDK projections, so
# do not "modernise" this to pwsh.
#
# Environment:
#   YP_POLL_MS         poll interval while something is playing (default 1000)
#   YP_IDLE_POLL_MS    poll interval while nothing is (default 5000)
#   YP_SMTC_CHANNELS   comma-separated: music, tv (default "music")
#   YP_SMTC_MUSIC_ID   AUMID prefix for Apple Music (default AppleInc.AppleMusicWin)
#   YP_SMTC_TV_ID      AUMID prefix for Apple TV   (default AppleInc.AppleTVWin)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# The parent reads this pipe as UTF-8. Without this, PowerShell hands it the
# console codepage and every accented artist name arrives mangled.
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Line($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  # stdout is a pipe here, so it is block-buffered; without this the parent
  # sees nothing until 4KB have accumulated, which at one small line per
  # second is most of a minute.
  [Console]::Out.Flush()
}

function Fail($message) {
  Write-Line @{ state = 'error'; error = $message }
  [Console]::Error.WriteLine($message)
  exit 1
}

# --- WinRT plumbing ---------------------------------------------------------
#
# WinRT's IAsyncOperation<T> is not awaitable from PowerShell directly. The
# standard bridge is AsTask<T>, reached by reflection because PowerShell cannot
# call a generic extension method any other way.

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if (-not $asTaskGeneric) { throw 'no AsTask overload for IAsyncOperation<T>' }
} catch {
  Fail "Could not load the WinRT async bridge: $($_.Exception.Message)"
}

function Await($operation, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  # Everything here answers in microseconds; a wait that does not finish means
  # something is wrong, and hanging forever would wedge the watcher silently.
  if (-not $task.Wait(5000)) { throw 'WinRT call timed out' }
  $task.Result
}

try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
} catch {
  Fail "Windows.Media.Control is unavailable: $($_.Exception.Message)"
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

try {
  $manager = Await ($managerType::RequestAsync()) $managerType
} catch {
  Fail "Could not open the media session manager: $($_.Exception.Message)"
}

# --- configuration ----------------------------------------------------------

function Env-Int($name, $fallback, $floor) {
  $raw = [Environment]::GetEnvironmentVariable($name)
  $value = 0
  if ([int]::TryParse($raw, [ref]$value) -and $value -ge $floor) { return $value }
  return $fallback
}

$pollMs = Env-Int 'YP_POLL_MS' 1000 200
$idleMs = Env-Int 'YP_IDLE_POLL_MS' 5000 $pollMs
if ($idleMs -lt $pollMs) { $idleMs = $pollMs }

$musicId = [Environment]::GetEnvironmentVariable('YP_SMTC_MUSIC_ID')
if (-not $musicId) { $musicId = 'AppleInc.AppleMusicWin' }
$tvId = [Environment]::GetEnvironmentVariable('YP_SMTC_TV_ID')
if (-not $tvId) { $tvId = 'AppleInc.AppleTVWin' }

$wanted = [Environment]::GetEnvironmentVariable('YP_SMTC_CHANNELS')
if (-not $wanted) { $wanted = 'music' }
$channels = @()
foreach ($name in $wanted.Split(',')) {
  $name = $name.Trim().ToLowerInvariant()
  if ($name -eq 'music') { $channels += , @{ channel = 'music'; prefix = $musicId } }
  if ($name -eq 'tv') { $channels += , @{ channel = 'tv'; prefix = $tvId } }
}
if ($channels.Count -eq 0) { Fail 'No channels requested (set YP_SMTC_CHANNELS)' }

# --- reading a session ------------------------------------------------------

function Playback-State($status) {
  switch ("$status") {
    'Playing' { return 'playing' }
    'Paused' { return 'paused' }
    'Stopped' { return 'stopped' }
    # "Opened" is the app running with nothing loaded, "Changing" is the
    # moment between two items. Neither is playback, and both resolve on
    # their own within a tick or two.
    'Opened' { return 'stopped' }
    'Changing' { return 'stopped' }
    default { return 'unknown' }
  }
}

function Read-Session($session) {
  $info = $session.GetPlaybackInfo()
  $state = Playback-State $info.PlaybackStatus
  if ($state -ne 'playing' -and $state -ne 'paused') {
    return @{ state = $state }
  }

  $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
  if (-not $props -or -not $props.Title) { return @{ state = 'stopped' } }

  $timeline = $session.GetTimelineProperties()
  $start = $timeline.StartTime.TotalSeconds
  $end = $timeline.EndTime.TotalSeconds
  $duration = $end - $start
  if ($duration -lt 0) { $duration = 0 }

  $position = $timeline.Position.TotalSeconds - $start
  if ($position -lt 0) { $position = 0 }

  # SMTC positions are pushed, not sampled: the app updates the timeline when
  # it feels like it (Apple Music does so every few seconds) and the value sits
  # there going stale in between. Reported as-is, the progress bar would stutter
  # backwards and the seek detector upstream would read every stale tick as a
  # scrub. So advance it by however long ago the app last spoke.
  $updated = $timeline.LastUpdatedTime
  if ($state -eq 'playing' -and $updated.Year -gt 2000) {
    $elapsed = ([DateTimeOffset]::UtcNow - $updated).TotalSeconds
    if ($elapsed -gt 0 -and $elapsed -lt 3600) { $position += $elapsed }
  }
  if ($duration -gt 0 -and $position -gt $duration) { $position = $duration }

  return @{
    state = $state
    name = [string]$props.Title
    artist = [string]$props.Artist
    album = [string]$props.AlbumTitle
    albumArtist = [string]$props.AlbumArtist
    subtitle = [string]$props.Subtitle
    duration = [math]::Round($duration, 3)
    position = [math]::Round($position, 3)
    trackNumber = [int]$props.TrackNumber
    trackCount = [int]$props.AlbumTrackCount
    genres = @($props.Genres)
    playbackType = "$($props.PlaybackType)"
    hasArtwork = ($props.Thumbnail -ne $null)
    appId = [string]$session.SourceAppUserModelId
  }
}

# --- the loop ---------------------------------------------------------------

Write-Line @{
  state = 'watcher-ready'
  intervalMs = $pollMs
  idleMs = $idleMs
  channels = @($channels | ForEach-Object { $_.channel })
}

while ($true) {
  $busy = $false

  try {
    $sessions = @($manager.GetSessions())
  } catch {
    # The manager itself has gone bad (a rare COM fault after a session switch);
    # exiting lets the supervisor spawn a clean one.
    Fail "Could not list media sessions: $($_.Exception.Message)"
  }

  foreach ($channel in $channels) {
    $payload = $null
    try {
      $match = $sessions | Where-Object { "$($_.SourceAppUserModelId)".StartsWith($channel.prefix, 'OrdinalIgnoreCase') } | Select-Object -First 1
      # No session at all is the app not running -- it registers one the moment
      # it opens, before anything is loaded.
      $payload = if ($match) { Read-Session $match } else { @{ state = 'closed' } }
    } catch {
      $payload = @{ state = 'error'; error = "$($_.Exception.Message)" }
    }
    $payload.channel = $channel.channel
    if ($payload.state -eq 'playing' -or $payload.state -eq 'paused') { $busy = $true }
    Write-Line $payload
  }

  Start-Sleep -Milliseconds $(if ($busy) { $pollMs } else { $idleMs })
}
