# Notification-area icon for yanpresence.
#
# Exists because of how the app is started on Windows. From a terminal you have
# Ctrl-C; launched from the Start menu you have a hidden process, no window,
# and -- without this -- no way to stop it short of Task Manager. So the tray
# icon is not decoration, it is the quit button.
#
# Speaks two ways to the Node process that spawned it:
#   out  a line on stdout -- "quit" when the menu item is clicked.
#   in   a status file it polls, whose first line becomes the tooltip and
#        whose second becomes the greyed-out line at the top of the menu.
#
# A file rather than stdin because the message loop below owns this thread:
# Console::In.ReadLine would block it, and pumping a second runspace to avoid
# that is a great deal of machinery for "what song is playing".
#
# Usage: tray.ps1 -ParentPid <pid> -StatusFile <path> [-IconFile <path>]

param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$StatusFile,
  [string]$IconFile = '',
  [string]$LogFile = ''
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-Line($text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

# --- the icon ---------------------------------------------------------------

$icon = $null
if ($IconFile -and (Test-Path -LiteralPath $IconFile)) {
  try { $icon = New-Object System.Drawing.Icon($IconFile) } catch { $icon = $null }
}
if (-not $icon) {
  # Better a generic icon than no tray presence at all -- without one there is
  # no way to quit, which is the entire point of this script.
  $icon = [System.Drawing.SystemIcons]::Application
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = 'yanpresence'
$notify.Visible = $true

# --- the menu ---------------------------------------------------------------

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$header = New-Object System.Windows.Forms.ToolStripMenuItem('yanpresence')
$header.Enabled = $false
[void]$menu.Items.Add($header)

$status = New-Object System.Windows.Forms.ToolStripMenuItem('Nothing playing')
$status.Enabled = $false
[void]$menu.Items.Add($status)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

if ($LogFile) {
  $openLog = New-Object System.Windows.Forms.ToolStripMenuItem('Open log')
  $openLog.Add_Click({
      # Launched hidden from the Start menu there is no console to have watched,
      # so the log file is the only account of what happened.
      if (Test-Path -LiteralPath $LogFile) { Start-Process notepad.exe -ArgumentList $LogFile }
    }.GetNewClosure())
  [void]$menu.Items.Add($openLog)
}

$quit = New-Object System.Windows.Forms.ToolStripMenuItem('Quit yanpresence')
$quit.Add_Click({
    # Ask rather than kill: the parent has a presence to clear with Discord
    # before it goes, and it exits on its own once that is done. Hiding the
    # icon here so the click feels immediate.
    Send-Line 'quit'
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  })
[void]$menu.Items.Add($quit)

$notify.ContextMenuStrip = $menu

# --- polling ----------------------------------------------------------------

$state = [pscustomobject]@{ Last = '' }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
    # The parent going away without saying so -- a crash, or a kill -- must not
    # leave an orphan icon behind that quits nothing.
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
      return
    }

    $text = ''
    try {
      if (Test-Path -LiteralPath $StatusFile) {
        # Named explicitly: the parent writes UTF-8, and half the artists worth
        # listening to have an accent in their name.
        $text = [System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8)
      }
    } catch {
      # Being written to right now; the next tick will read it whole.
      return
    }

    if ($text -eq $state.Last) { return }
    $state.Last = $text

    $lines = $text -split "`r?`n"
    $tip = if ($lines.Count -gt 0 -and $lines[0]) { $lines[0] } else { 'yanpresence' }
    $line = if ($lines.Count -gt 1 -and $lines[1]) { $lines[1] } else { 'Nothing playing' }

    # NotifyIcon.Text throws above 63 characters on the classic API, and a song
    # title plus an artist goes past that routinely.
    if ($tip.Length -gt 62) { $tip = $tip.Substring(0, 61) + [char]0x2026 }
    if ($line.Length -gt 60) { $line = $line.Substring(0, 59) + [char]0x2026 }

    $notify.Text = $tip
    $status.Text = $line
  }.GetNewClosure())
$timer.Start()

# Double-clicking a tray icon usually opens the app's window. There is no
# window, so the next most useful thing is to show what it is doing.
$notify.Add_DoubleClick({
    $notify.ShowBalloonTip(3000, 'yanpresence', $status.Text, [System.Windows.Forms.ToolTipIcon]::Info)
  }.GetNewClosure())

Send-Line 'ready'

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  # Deleted here rather than by the parent, because the case worth cleaning up
  # after is the parent being killed outright -- which is exactly the case
  # where the parent runs no cleanup of its own.
  try { Remove-Item -LiteralPath $StatusFile -Force -ErrorAction SilentlyContinue } catch {}
}
