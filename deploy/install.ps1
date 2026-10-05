<#
    install.ps1 - set up the yanpresence website on finprint-host.

    Run once, elevated, from a copy of this directory on the host:

        powershell -ExecutionPolicy Bypass -File .\install.ps1

    Re-running is safe, and is the only way the scripts the task runs change:
    deploys publish files from the repository, they never execute its code.

    This creates C:\ProgramData\yanpresence (SYSTEM and Administrators only,
    because SYSTEM's Caddy loads configuration from it), clones the
    repository there, and registers yanpresence-site-deploy, which runs
    deploy.ps1 as SYSTEM at startup and every two minutes. It then runs one
    pass. Until <Domain> resolves to this connection that pass only reports
    what DNS still says; finprint's Caddyfile is not touched before then.

    Re-running with a different -Domain renames a live site. Caddy keeps
    serving the old name until the new one resolves here, then moves.
#>

[CmdletBinding()]
param(
    [string]$Root = 'C:\ProgramData\yanpresence',
    [string]$Domain = 'presence.ethanyanxu.com',
    # The record that tracks this connection's address. Domain must be a
    # CNAME to it (or resolve exactly as it does) before the first activation.
    [string]$DnsTarget = 'finprint.ethanyanxu.com',
    [string]$Repository = 'https://github.com/OoEthanoO/yanpresence.git',
    [string]$MainCaddyfile = 'C:\Users\ethan\finprint\scripts\selfhost\Caddyfile',
    # Defaults to the caddy.exe that is running $MainCaddyfile.
    [string]$CaddyExe = '',
    [string]$TaskName = 'yanpresence-site-deploy'
)

. (Join-Path $PSScriptRoot 'common.ps1')

Assert-Administrator
if (-not (Test-Path -LiteralPath $MainCaddyfile)) { throw "Not found: $MainCaddyfile" }
if (-not $CaddyExe) {
    $running = Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($MainCaddyfile) } | Select-Object -First 1
    if (-not $running) { throw "No caddy.exe is running $MainCaddyfile. Pass -CaddyExe." }
    $CaddyExe = $running.ExecutablePath
}
if (-not (Test-Path -LiteralPath $CaddyExe)) { throw "Not found: $CaddyExe" }
$git = (Get-Command git.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$r = Invoke-Native (Join-Path $env:SystemRoot 'System32\icacls.exe') @($Root, '/inheritance:r', '/grant:r',
    '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
if ($r.Code -ne 0) { throw "Could not restrict ${Root}: $($r.Output)" }
foreach ($dir in 'releases', 'logs', 'ops', 'work') { New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null }

$repo = Join-Path $Root 'repo'
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    # No working tree: releases come from git archive, so there is nothing in
    # here to drift, and nothing for the task to check out.
    $r = Invoke-Native $git @('clone', '--quiet', '--no-checkout', '--branch', 'main', $Repository, $repo)
    if ($r.Code -ne 0) { throw "git clone failed ($($r.Code)): $($r.Output)" }
    Write-Host "cloned $Repository"
}

Write-Json (Join-Path $Root 'server.json') ([pscustomobject]@{
    root = $Root; domain = $Domain; dnsTarget = $DnsTarget; repository = $Repository; repo = $repo
    git = $git; caddy = $CaddyExe; mainCaddyfile = $MainCaddyfile
})

$ops = Join-Path $Root 'ops'
if ([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($ops).TrimEnd('\')) {
    foreach ($file in 'common.ps1', 'deploy.ps1', 'install.ps1') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $ops -Force
    }
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Root "{1}" -Log' -f (Join-Path $ops 'deploy.ps1'), $Root)
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2))
)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -User 'SYSTEM' -RunLevel Highest -Description "Publishes docs/ from $Repository at https://$Domain" -Force | Out-Null
Write-Host "registered scheduled task $TaskName (SYSTEM, at startup and every 2 minutes)"

Write-Host 'first deploy pass:'
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $ops 'deploy.ps1') -Root $Root -Log
exit $LASTEXITCODE
