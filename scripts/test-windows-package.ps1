# Installs a separate test identity; it never replaces the user's yanpresence
# shortcuts, installation registration, config, or running development copy.
[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$name = 'yanpresence Installer Smoke Test'
$installer = Join-Path $repo "dist\$name-$($package.version)-windows-x64-setup.exe"
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot 'build-windows.ps1') -BootstrapCompiler -SmokeTestIdentity }
if (-not (Test-Path -LiteralPath $installer)) { throw "Missing test installer: $installer" }
$testRoot = Join-Path $repo ('.build\Installer Smoke ' + [Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'App With Spaces'
$shell = New-Object -ComObject WScript.Shell
$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk"
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) "$name.lnk"
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{51B07BFE-E4D2-492F-9F97-CDBD40D43B0B}_is1'
$sentinelName = 'installer-smoke-' + [Guid]::NewGuid().ToString('N') + '.txt'
$sentinels = @(
  (Join-Path $env:APPDATA "yanpresence\$sentinelName"),
  (Join-Path $env:LOCALAPPDATA "yanpresence\cache\$sentinelName")
)
$originalPath = $env:PATH
$installed = $false
$unrelatedChildren = New-Object 'System.Collections.Generic.List[int]'
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

function Run-Setup([string]$logName, [switch]$DisableStartup) {
  $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="{0}" /LOG="{1}"' -f $installDir, (Join-Path $testRoot $logName)
  if ($DisableStartup) { $arguments += ' /MERGETASKS="!startup"' }
  $setup = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  Assert ($setup.ExitCode -eq 0) "Installer failed ($($setup.ExitCode)); see $testRoot"
}

function Start-LauncherProbe {
  $resultFile = Join-Path $installDir 'smoke-result.json'
  if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
  # Replace only the isolated installation's entrypoint. This verifies the
  # real launcher/runtime/FFmpeg wiring without connecting to Discord or
  # competing with a user's existing presence. A reinstall restores the file.
  @'
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
// An independent Windows process represents an editor opened from the tray.
// Loopback ping stays idle between packets and is cleaned up by the harness.
const unrelated = spawn(process.env.SystemRoot + '\\System32\\ping.exe',
  ['-t', '127.0.0.1'], { stdio: 'ignore', windowsHide: true, detached: true });
fs.writeFileSync('smoke-result.json', JSON.stringify({
  pid: process.pid, helperPid: helper.pid, unrelatedPid: unrelated.pid,
  execPath: process.execPath, argv: process.argv,
  ffmpeg: spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status,
  ffprobe: spawnSync('ffprobe', ['-version'], { windowsHide: true }).status,
}));
setInterval(() => {}, 1000);
'@ | Set-Content -LiteralPath (Join-Path $installDir 'bin\yanpresence.js') -Encoding UTF8
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $installDir 'windows\yanpresence-launch.ps1')
  # Start-Process -Wait also waits for descendants, including the background
  # app we intentionally leave running. Wait for the short-lived launcher only.
  $launcher = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Assert ($launcher.WaitForExit(15000)) 'The launcher did not return.'
  Assert ($launcher.ExitCode -eq 0) 'The installed launcher failed.'
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (-not (Test-Path -LiteralPath $resultFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  Assert (Test-Path -LiteralPath $resultFile) 'The launcher did not start bundled Node in the path containing spaces.'
  $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
  $unrelatedChildren.Add($result.unrelatedPid)
  Assert ([bool](Get-Process -Id $result.unrelatedPid -ErrorAction SilentlyContinue)) 'The independent user-owned process did not start.'
  Assert ($result.execPath -eq (Join-Path $installDir 'runtime\node.exe')) 'The launcher used an external Node runtime.'
  Assert ($result.argv[1] -eq (Join-Path $installDir 'bin\yanpresence.js')) 'The launcher split the entrypoint path.'
  Assert ($result.argv[2] -eq '--tray') 'The launcher omitted tray mode.'
  Assert ($result.ffmpeg -eq 0 -and $result.ffprobe -eq 0) 'Bundled artwork tools did not work without an external PATH.'
  $env:PATH = $originalPath
  Remove-Item -LiteralPath $resultFile -Force
  return $result
}

try {
  Assert (-not (Test-Path -LiteralPath $startLink)) 'A smoke-test shortcut already exists. Remove the previous smoke-test installation first.'
  Assert (-not (Test-Path -LiteralPath $uninstallKey)) 'A smoke-test installation already exists. Uninstall it before retesting.'
  foreach ($sentinel in $sentinels) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sentinel) | Out-Null
    'User data must survive install and uninstall.' | Set-Content -LiteralPath $sentinel -Encoding ASCII
  }
  Run-Setup 'install.log'
  $installed = $true
  Assert (Test-Path -LiteralPath $uninstallKey) 'Per-user uninstall registration is missing.'
  foreach ($file in @('runtime\node.exe', 'runtime\ffmpeg\bin\ffmpeg.exe', 'runtime\ffmpeg\bin\ffprobe.exe', 'scripts\tray.ps1', 'scripts\smtc-watch.ps1', 'assets\yanpresence.ico')) {
    Assert (Test-Path -LiteralPath (Join-Path $installDir $file)) "Missing installed file: $file"
  }
  Assert (Test-Path -LiteralPath $startLink) 'Start Menu shortcut is missing.'
  Assert (Test-Path -LiteralPath $startupLink) 'Startup was not enabled by default.'
  $shortcut = $shell.CreateShortcut($startLink)
  Assert ($shortcut.Arguments.Contains('"' + (Join-Path $installDir 'windows\yanpresence-launch.ps1') + '"')) 'Shortcut path is not quoted.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $installDir 'config.json'))) 'The installer included a private config.json.'
  & (Join-Path $installDir 'runtime\node.exe') (Join-Path $installDir 'bin\yanpresence.js') --help | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'The installed application did not run.'
  $probe = Start-LauncherProbe
  Run-Setup 'upgrade.log' -DisableStartup
  Assert (-not (Get-Process -Id $probe.pid -ErrorAction SilentlyContinue)) 'Upgrade did not stop the previous installed process.'
  Assert (-not (Get-Process -Id $probe.helperPid -ErrorAction SilentlyContinue)) 'Upgrade left an app-owned helper running.'
  Assert ([bool](Get-Process -Id $probe.unrelatedPid -ErrorAction SilentlyContinue)) 'Upgrade stopped a user-owned descendant process.'
  Assert (-not (Test-Path -LiteralPath $startupLink)) 'Disabling startup during upgrade left the startup shortcut active.'
  & (Join-Path $installDir 'runtime\node.exe') (Join-Path $installDir 'bin\yanpresence.js') --help | Out-Null
  Assert ($LASTEXITCODE -eq 0) 'Upgrade did not restore the app entrypoint.'
  $probe = Start-LauncherProbe
  $uninstaller = Join-Path $installDir 'unins000.exe'
  $uninstallArgs = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="{0}"' -f (Join-Path $testRoot 'uninstall.log')
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList $uninstallArgs -WindowStyle Hidden -Wait -PassThru
  Assert ($uninstall.ExitCode -eq 0) "Uninstall failed: $($uninstall.ExitCode)"
  $installed = $false
  Assert (-not (Get-Process -Id $probe.pid -ErrorAction SilentlyContinue)) 'Uninstall left the installed runtime running.'
  Assert (-not (Get-Process -Id $probe.helperPid -ErrorAction SilentlyContinue)) 'Uninstall left an app-owned helper running.'
  Assert ([bool](Get-Process -Id $probe.unrelatedPid -ErrorAction SilentlyContinue)) 'Uninstall stopped a user-owned descendant process.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $installDir 'runtime\node.exe'))) 'Uninstall left installed binaries behind.'
  Assert (-not (Test-Path -LiteralPath $startLink)) 'Uninstall left the Start Menu shortcut behind.'
  Assert (-not (Test-Path -LiteralPath $startupLink)) 'Uninstall left the startup shortcut behind.'
  Assert (-not (Test-Path -LiteralPath $uninstallKey)) 'Uninstall left its registration behind.'
  foreach ($sentinel in $sentinels) { Assert (Test-Path -LiteralPath $sentinel) 'Uninstall deleted user data.' }
  Write-Host 'PASS: per-user install, default startup, bundled runtime/tools, paths with spaces, upgrade, process shutdown, uninstall, and retained user data.'
  Write-Host "Installer test logs: $testRoot"
} finally {
  $env:PATH = $originalPath
  if ($installed -and (Test-Path -LiteralPath (Join-Path $installDir 'unins000.exe'))) {
    Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WindowStyle Hidden -Wait | Out-Null
  }
  foreach ($sentinel in $sentinels) {
    if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel -Force }
  }
  foreach ($childPid in $unrelatedChildren) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}
