# Long-lived Apple TV watcher for Windows. Emits one JSON object per line.
#
# The Apple TV app is the one Apple desktop app that reports nothing anyone can
# subscribe to. It publishes no System Media Transport Controls session at all
# -- verified over 150s of continuous playback, while Apple Music sitting
# paused in the background published one the whole time -- so the watcher that
# reads Apple Music cannot see it, and there is no second session to wait for.
#
# What it does expose is a UI Automation tree, and that tree is better than
# SMTC would have been: the season, the episode number and the episode title
# arrive as their own labelled elements instead of as free text to be picked
# apart, and the scrubber reports the playhead and the runtime in seconds.
#
#   Text   'Trying'                   id=TitleTextBlock
#   Text   'S1, E1 · Nikki and Jason' id=SubtitleTextBlock
#   Slider 'Playback position'        id=VideoPlayer_CurrentPositionScrubber
#   Button 'Pause'                    id=VideoPlayer_PlayButton
#
# The catch, and the reason this reports "hidden" as its own state: those
# elements exist only while the transport overlay is on screen. Let the overlay
# fade and the subtree is gone entirely -- not stale, not hidden, absent. So
# this reports what it can see and leaves the parent to carry the last reading
# forward, because the overlay reappears on exactly the events worth noticing:
# starting something, pausing, seeking.
#
# Environment:
#   YP_POLL_MS       poll interval while the app is running (default 1000)
#   YP_IDLE_POLL_MS  poll interval while it is not (default 5000)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-Line($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Fail($message) {
  Write-Line @{ channel = 'tv'; state = 'error'; error = $message }
  [Console]::Error.WriteLine($message)
  exit 1
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Fail "Could not load UI Automation: $($_.Exception.Message)"
}

$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement

function Env-Int($name, $fallback, $floor) {
  $raw = [Environment]::GetEnvironmentVariable($name)
  $value = 0
  if ([int]::TryParse($raw, [ref]$value) -and $value -ge $floor) { return $value }
  return $fallback
}

$pollMs = Env-Int 'YP_POLL_MS' 1000 250
$idleMs = Env-Int 'YP_IDLE_POLL_MS' 5000 $pollMs
if ($idleMs -lt $pollMs) { $idleMs = $pollMs }

function Find-ById($scope, $id) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)
  return $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

function Read-Player {
  $proc = Get-Process -Name AppleTV -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proc) { return @{ state = 'closed' } }

  $byPid = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $proc.Id)
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $byPid)
  if ($windows.Count -eq 0) { return @{ state = 'hidden' } }

  # Every window is searched rather than just the one that looks like a player.
  # Full screen puts the video in its own top-level window; windowed playback
  # keeps it inside the main one, and the elements are what identify it either
  # way.
  $title = $null; $subtitle = $null; $scrubber = $null; $playButton = $null
  foreach ($w in $windows) {
    if (-not $title) { $title = Find-ById $w 'TitleTextBlock' }
    if (-not $subtitle) { $subtitle = Find-ById $w 'SubtitleTextBlock' }
    if (-not $scrubber) { $scrubber = Find-ById $w 'VideoPlayer_CurrentPositionScrubber' }
    if (-not $playButton) { $playButton = Find-ById $w 'VideoPlayer_PlayButton' }
  }

  # The app is up but the overlay is not drawn, so there is nothing to read.
  # Deliberately not "stopped": the parent knows whether it was watching
  # something a moment ago, and this says nothing either way.
  if (-not $scrubber -and -not $title) { return @{ state = 'hidden' } }

  $position = 0.0
  $duration = 0.0
  if ($scrubber) {
    try {
      $rv = $scrubber.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
      $position = [double]$rv.Current.Value
      $duration = [double]$rv.Current.Maximum
    } catch {
      # The overlay faded between finding the element and reading it.
      return @{ state = 'hidden' }
    }
  }

  # The button is labelled with the action it performs, so "Pause" is what a
  # playing video offers.
  $state = 'playing'
  if ($playButton) {
    try {
      if ("$($playButton.Current.Name)" -match '^play') { $state = 'paused' }
    } catch { }
  }

  $name = ''
  $sub = ''
  try { if ($title) { $name = "$($title.Current.Name)" } } catch { }
  try { if ($subtitle) { $sub = "$($subtitle.Current.Name)" } } catch { }

  if (-not $name) { return @{ state = 'hidden' } }

  return @{
    state = $state
    show = $name
    subtitle = $sub
    position = [math]::Round($position, 3)
    duration = [math]::Round($duration, 3)
  }
}

Write-Line @{ state = 'watcher-ready'; intervalMs = $pollMs; idleMs = $idleMs }

while ($true) {
  $payload = $null
  try {
    $payload = Read-Player
  } catch {
    # A window closing mid-walk throws ElementNotAvailableException; that is a
    # normal thing for a video player to do, not a fault to restart over.
    $payload = @{ state = 'hidden'; note = "$($_.Exception.Message)" }
  }
  $payload.channel = 'tv'
  Write-Line $payload
  Start-Sleep -Milliseconds $(if ($payload.state -eq 'closed') { $idleMs } else { $pollMs })
}
