# Called by Setup before an upgrade and by the uninstaller. Only the Node
# executable inside this exact installation is eligible to be stopped.
param([Parameter(Mandatory = $true)][string]$InstallRoot)

$ErrorActionPreference = 'Stop'
$installPath = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$runtime = Join-Path $installPath 'runtime\node.exe'
$processes = @(Get-CimInstance Win32_Process)
$parents = @($processes | Where-Object {
  $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $runtime, [StringComparison]::OrdinalIgnoreCase)
})
$ownedExecutables = @(
  $runtime,
  (Join-Path $installPath 'runtime\ffmpeg\bin\ffmpeg.exe'),
  (Join-Path $installPath 'runtime\ffmpeg\bin\ffprobe.exe')
)
$helperScripts = @('tray.ps1', 'smtc-watch.ps1', 'smtc-artwork.ps1', 'tv-uia-watch.ps1') | ForEach-Object {
  [regex]::Escape((Join-Path $installPath "scripts\$_"))
}

function Test-OwnedProcess($candidate) {
  if ($candidate.ExecutablePath -and $ownedExecutables -contains $candidate.ExecutablePath) { return $true }
  if ($candidate.Name -eq 'powershell.exe' -and $candidate.CommandLine) {
    foreach ($scriptPattern in $helperScripts) {
      if ($candidate.CommandLine -match ('(?i)-File\s+(?:"' + $scriptPattern + '"|' + $scriptPattern + '(?=\s|$))')) { return $true }
    }
  }
  return $false
}

function Stop-InstalledTree([uint32]$processId) {
  foreach ($child in @($processes | Where-Object { $_.ParentProcessId -eq $processId })) {
    # The tray can open a user's editor to show a log. That editor is a
    # descendant too, but belongs to the user and may contain unsaved work.
    if (Test-OwnedProcess $child) { Stop-InstalledTree $child.ProcessId }
  }
  $running = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($running) {
    $running | Stop-Process -Force -ErrorAction Stop
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
  }
}

foreach ($parent in $parents) { Stop-InstalledTree $parent.ProcessId }
