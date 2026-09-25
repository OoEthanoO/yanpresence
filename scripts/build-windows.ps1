# Build a complete offline Windows installer. Run from any directory with
# Windows PowerShell 5.1+; no globally installed Node or FFmpeg is required.
[CmdletBinding()]
param(
  [switch]$BootstrapCompiler,
  [switch]$StageOnly,
  [string]$IsccPath = '',
  [string]$Version = '',
  [switch]$SmokeTestIdentity
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = Split-Path -Parent $PSScriptRoot
$build = Join-Path $repo '.build'
$downloads = Join-Path $build 'downloads'
$stage = Join-Path $build 'windows-x64'
$dist = Join-Path $repo 'dist'
$manifest = Get-Content -LiteralPath (Join-Path $repo 'installer\windows-dependencies.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $package.version }
if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Installer versions must have three or four numeric components.' }
New-Item -ItemType Directory -Force -Path $downloads, $dist | Out-Null

function Get-VerifiedDownload($dependency) {
  $fileName = [System.IO.Path]::GetFileName(([Uri]$dependency.url).AbsolutePath)
  $destination = Join-Path $downloads $fileName
  if (-not (Test-Path -LiteralPath $destination)) {
    Write-Host "Downloading $fileName"
    Invoke-WebRequest -Uri $dependency.url -OutFile $destination -UseBasicParsing
  }
  $actual = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
  if ($actual -ne $dependency.sha256) {
    throw "SHA-256 mismatch for $destination. Remove that download and retry. Expected $($dependency.sha256), received $actual."
  }
  return $destination
}

function Reset-BuildDirectory([string]$directory) {
  # These are the only recursively deleted paths. Resolve and validate them
  # before deletion; caller input must never turn a clean build into data loss.
  $full = [System.IO.Path]::GetFullPath($directory).TrimEnd('\')
  $allowedPrefix = [System.IO.Path]::GetFullPath($build).TrimEnd('\') + '\'
  if (-not $full.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a directory outside $build : $full"
  }
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $full | Out-Null
}

function Expand-SelectedFiles([string]$archivePath, [string]$archiveRoot, [hashtable]$files) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    foreach ($relative in $files.Keys) {
      $entry = $archive.GetEntry("$archiveRoot/$relative")
      if (-not $entry) { throw "Missing $relative in $archivePath" }
      $destination = $files[$relative]
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
  } finally { $archive.Dispose() }
}

$nodeArchive = Get-VerifiedDownload $manifest.node
$ffmpegArchive = Get-VerifiedDownload $manifest.ffmpeg
Reset-BuildDirectory $stage

# An allowlist keeps config.json, .env files, credentials, worker deployments,
# tests, and build caches out of the installer even in a developer checkout.
foreach ($folder in @('bin', 'src', 'assets', 'browser')) {
  Copy-Item -LiteralPath (Join-Path $repo $folder) -Destination $stage -Recurse
}
foreach ($file in @('package.json', 'config.example.json', 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $stage
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'scripts'), (Join-Path $stage 'windows') | Out-Null
foreach ($helper in @('smtc-watch.ps1', 'smtc-artwork.ps1', 'tv-uia-watch.ps1', 'tray.ps1', 'music-watch.js', 'tv-watch.js', 'dump-artwork.applescript')) {
  Copy-Item -LiteralPath (Join-Path $repo "scripts\$helper") -Destination (Join-Path $stage 'scripts')
}
foreach ($helper in @('yanpresence-launch.ps1', 'stop-installed.ps1')) {
  Copy-Item -LiteralPath (Join-Path $repo "windows\$helper") -Destination (Join-Path $stage 'windows')
}
Expand-SelectedFiles $nodeArchive $manifest.node.root @{
  'node.exe' = (Join-Path $stage 'runtime\node.exe')
  'LICENSE' = (Join-Path $stage 'runtime\NODE-LICENSE.txt')
}
Expand-SelectedFiles $ffmpegArchive $manifest.ffmpeg.root @{
  'bin/ffmpeg.exe' = (Join-Path $stage 'runtime\ffmpeg\bin\ffmpeg.exe')
  'bin/ffprobe.exe' = (Join-Path $stage 'runtime\ffmpeg\bin\ffprobe.exe')
  'LICENSE' = (Join-Path $stage 'runtime\ffmpeg\LICENSE.txt')
  'README.txt' = (Join-Path $stage 'runtime\ffmpeg\README.txt')
}
Copy-Item -LiteralPath (Join-Path $repo 'installer\windows-dependencies.json') -Destination (Join-Path $stage 'runtime\dependencies.json')
Copy-Item -LiteralPath (Join-Path $repo 'installer\THIRD-PARTY-NOTICES.txt') -Destination $stage

# Fail during packaging if an upstream archive lacks our default CPU AV1
# encoder, rather than shipping an installer whose artwork silently fails.
$runtime = Join-Path $stage 'runtime\node.exe'
& $runtime --version
if ($LASTEXITCODE -ne 0) { throw 'The bundled Node runtime did not start.' }
$ffmpeg = Join-Path $stage 'runtime\ffmpeg\bin\ffmpeg.exe'
$encoders = (& $ffmpeg -hide_banner -encoders 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $encoders -notmatch '\blibsvtav1\b') { throw 'Bundled FFmpeg must include libsvtav1.' }
& (Join-Path $stage 'runtime\ffmpeg\bin\ffprobe.exe') -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw 'The bundled ffprobe runtime did not start.' }
& $runtime (Join-Path $stage 'bin\yanpresence.js') --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The packaged application did not start.' }

if ($StageOnly) { Write-Host "Staged application: $stage"; return }
if (-not $IsccPath) {
  $localCompiler = Join-Path $build 'inno-setup\ISCC.exe'
  if (Test-Path -LiteralPath $localCompiler) { $IsccPath = $localCompiler }
}
if (-not $IsccPath -and $BootstrapCompiler) {
  $compilerInstaller = Get-VerifiedDownload $manifest.innoSetup
  $compilerDir = Join-Path $build 'inno-setup'
  $arguments = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /NOICONS /DIR="{0}"' -f $compilerDir
  $process = Start-Process -FilePath $compilerInstaller -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Inno Setup bootstrap failed: $($process.ExitCode)" }
  $IsccPath = Join-Path $compilerDir 'ISCC.exe'
}
if (-not $IsccPath) {
  throw 'Pass -BootstrapCompiler to install the pinned compiler locally, or -IsccPath with an existing ISCC.exe.'
}
if (-not (Test-Path -LiteralPath $IsccPath)) { throw "Inno Setup compiler not found: $IsccPath" }
# The .iss file checks Inno's VER preprocessor constant. ISCC.exe intentionally
# has a 0.0.0.0 Windows file version, so FileVersionInfo cannot validate it.
$compilerArgs = @("/DAppVersion=$Version", "/DPayloadDir=$stage", "/DOutputDir=$dist")
$appName = 'yanpresence'
if ($SmokeTestIdentity) {
  $appName = 'yanpresence Installer Smoke Test'
  $compilerArgs += @("/DApplicationName=$appName", '/DApplicationId={{51B07BFE-E4D2-492F-9F97-CDBD40D43B0B}')
}
& $IsccPath @compilerArgs (Join-Path $repo 'installer\yanpresence.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $LASTEXITCODE" }
$output = Join-Path $dist "$appName-$Version-windows-x64-setup.exe"
if (-not (Test-Path -LiteralPath $output)) { throw "Expected installer was not produced: $output" }
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $([System.IO.Path]::GetFileName($output))" | Set-Content -LiteralPath "$output.sha256" -Encoding ASCII
Write-Host "Installer: $output"
Write-Host "SHA-256: $hash"
