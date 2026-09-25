# What the Start menu shortcut runs.
#
# Its whole job is to start node without a console window. A shortcut pointing
# straight at node.exe would work, but node is a console application: Windows
# gives it a console, and you get a black window sitting in the taskbar for as
# long as the presence is running, with no way to close it that does not also
# kill the app. So the shortcut points here, this is launched hidden, and it
# starts node hidden in turn.
#
# The tray icon is what you get instead of that window, and it is where Quit
# lives.

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root 'bin\yanpresence.js'

function Find-Node {
  # The installer ships its own runtime. Do not accidentally use an older
  # system Node, or require the user to install developer tools.
  $bundled = Join-Path $root 'runtime\node.exe'
  if (Test-Path -LiteralPath $bundled) { return $bundled }
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  # A shortcut launched from the Start menu inherits the user's PATH, but a
  # scheduled or elevated context may not, and node installed for the current
  # user only is not on the machine PATH at all.
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:APPDATA 'nvm\node.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

$node = Find-Node
if (-not $node) {
  # There is no console to print to, so the only way to say anything is a box.
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "yanpresence could not find its runtime.`n`nRun the yanpresence installer again to repair the installation.`n`nFor a source checkout, install Node.js 18 or newer from https://nodejs.org.",
    'yanpresence', 'OK', 'Error') | Out-Null
  exit 1
}

# -WindowStyle Hidden on a console application means the console it is given is
# created hidden, which is the difference between a background process and a
# black window on the taskbar.
$bundledTools = Join-Path $root 'runtime\ffmpeg\bin'
if (Test-Path -LiteralPath $bundledTools) { $env:PATH = "$bundledTools;$env:PATH" }

# Start-Process joins array arguments without adding quotes. Quote the entry
# explicitly so user names and install locations containing spaces work.
Start-Process -FilePath $node -ArgumentList ('"{0}" --tray' -f $entry) -WorkingDirectory $root -WindowStyle Hidden
