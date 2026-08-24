# Removes what windows\install.ps1 wrote.
#
# Leaves the config and the caches alone -- reinstalling and losing your
# clientId would be a poor trade. Those live in %APPDATA%\yanpresence and
# %LOCALAPPDATA%\yanpresence; delete them by hand if you mean it.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File windows\uninstall.ps1

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$targets = @(
  (Join-Path $programs 'yanpresence.lnk'),
  (Join-Path $programs 'Startup\yanpresence.lnk')
)

Write-Output ''
$removed = 0
foreach ($t in $targets) {
  if (Test-Path -LiteralPath $t) {
    Remove-Item -LiteralPath $t -Force
    Write-Output "  Removed $t"
    $removed++
  }
}
if ($removed -eq 0) { Write-Output '  Nothing to remove.' }

# A running copy would otherwise carry on with no shortcut left to explain it.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'yanpresence' }
if ($running) {
  Write-Output ''
  Write-Output '  yanpresence is still running. Quit it from the notification-area icon,'
  Write-Output "  or: Stop-Process -Id $($running.ProcessId -join ', ')"
}

Write-Output ''
Write-Output '  Config and caches were left in place:'
Write-Output "    $(Join-Path $env:APPDATA 'yanpresence')"
Write-Output "    $(Join-Path $env:LOCALAPPDATA 'yanpresence')"
Write-Output ''
