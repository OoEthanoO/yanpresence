# Puts yanpresence in the Start menu, so Windows Search can find it.
#
# The macOS and Linux equivalents of this directory install a launchd agent and
# a systemd user service -- things that run yanpresence from login. Windows can
# do that too (-Startup below), but the more useful thing here is the one those
# platforms get for free from their own tooling: an entry you can type the name
# of and press Enter.
#
# Everything written is per-user and needs no administrator:
#
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\yanpresence.lnk
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\yanpresence.lnk   (-Startup)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1 [-Startup]

param(
  # Also start yanpresence when you log in.
  [switch]$Startup
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'windows\yanpresence-launch.ps1'
$icon = Join-Path $root 'assets\yanpresence.ico'

if (-not (Test-Path -LiteralPath $launcher)) { throw "Missing $launcher" }

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
# Not $startup: PowerShell variable names are case-insensitive, so that would
# be the -Startup switch parameter and assigning a path to it is an error.
$startupDir = Join-Path $programs 'Startup'

# Windows PowerShell is pinned by full path rather than by name: the shortcut
# must keep working whatever ends up first on PATH, and pwsh cannot run the
# WinRT parts of this project.
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function New-Shortcut($path, $description) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $powershell
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
  $lnk.WorkingDirectory = $root
  $lnk.Description = $description
  # Minimised as well as hidden: belt and braces against the launcher's own
  # host flashing up a window on a slow machine.
  $lnk.WindowStyle = 7
  if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
  Write-Output "  Wrote $path"
}

Write-Output ''
New-Shortcut (Join-Path $programs 'yanpresence.lnk') 'Apple Music rich presence for Discord'

if ($Startup) {
  New-Shortcut (Join-Path $startupDir 'yanpresence.lnk') 'Apple Music rich presence for Discord (starts at login)'
} else {
  Write-Output '  (pass -Startup to also run it at login)'
}

Write-Output ''
Write-Output '  Press Start and type "yanpresence" to run it.'
Write-Output '  It has no window - look for the note icon in the notification area,'
Write-Output '  where the menu has Quit. Windows 11 hides new tray icons by default:'
Write-Output '  click the ^ arrow, or drag the icon out onto the taskbar to keep it.'
Write-Output ''

# Searching the Start menu reads an index that a new file does not always land
# in immediately. Nudging Explorer is not guaranteed either, but it is free.
try {
  $shell = New-Object -ComObject Shell.Application
  $shell.Namespace($programs).Self.InvokeVerb('refresh')
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
} catch {
  # Purely cosmetic; the shortcut is on disk either way.
}
