# Shared helpers for the yanpresence website on finprint-host.
#
# Windows PowerShell 5.1. Keep this file ASCII: it runs as SYSTEM from
# C:\ProgramData\yanpresence\ops, and a non-ASCII byte in a script read
# without a BOM is the kind of failure nobody sees until it is live.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Utf8 = New-Object Text.UTF8Encoding $false
$BeginMarker = '# BEGIN yanpresence (managed)'
$EndMarker = '# END yanpresence (managed)'
$ReleasePattern = '^\d{14}-[0-9a-f]{12}$'
$script:LogPath = $null

function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run elevated: this changes the SYSTEM Caddy configuration.'
    }
}

function Say([string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format s), $Message
    Write-Host $line
    if ($script:LogPath) { [IO.File]::AppendAllText($script:LogPath, $line + "`r`n", $Utf8) }
}

function Read-Json([string]$Path) {
    if (Test-Path -LiteralPath $Path) { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    return $null
}

# Write through a temporary file and swap it in, so a crash mid-write cannot
# leave half a state file behind.
function Write-Json([string]$Path, $Value) {
    $temporary = $Path + '.new'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 6), $Utf8)
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
}

# Native tools report through exit codes. Under 'Stop', Windows PowerShell 5.1
# turns anything they print on stderr into a terminating error, so run them
# under 'Continue' and judge the exit code instead.
function Invoke-Native([string]$File, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $File @Arguments 2>&1 | ForEach-Object { "$_" } | Out-String
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    return [pscustomobject]@{ Code = $code; Output = $output.Trim() }
}

# The checkout belongs to whoever created it, and the task runs as SYSTEM;
# naming it safe per call avoids a machine-wide git setting.
function Invoke-Git($Config, [string[]]$Arguments) {
    $prefix = @('-c', ('safe.directory=' + ($Config.repo -replace '\\', '/')), '-C', $Config.repo)
    $r = Invoke-Native $Config.git ($prefix + $Arguments)
    if ($r.Code -ne 0) { throw "git $($Arguments[0]) failed ($($r.Code)): $($r.Output)" }
    return $r.Output
}

function Invoke-Caddy($Config, [string]$Verb) {
    $r = Invoke-Native $Config.caddy @($Verb, '--config', $Config.mainCaddyfile, '--adapter', 'caddyfile')
    $log = Join-Path $Config.root 'logs\caddy.log'
    [IO.File]::AppendAllText($log, ("[{0}] caddy {1} -> {2}`r`n{3}`r`n" -f (Get-Date -Format s), $Verb, $r.Code, $r.Output), $Utf8)
    if ($r.Code -ne 0) { throw "caddy $Verb failed ($($r.Code)); see $log" }
}

# configured: the release Caddy is pointed at. active: the last release seen
# serving. previous: the one before. failedTree: a docs/ tree that was
# switched to and rolled back, not retried until docs/ changes.
function Read-State([string]$Root) {
    $state = [pscustomobject]@{ configured = $null; active = $null; previous = $null; failedTree = $null; status = $null }
    $saved = Read-Json (Join-Path $Root 'state.json')
    if ($saved) {
        foreach ($key in 'configured', 'active', 'previous', 'failedTree', 'status') {
            if ($saved.PSObject.Properties[$key]) { $state.$key = $saved.$key }
        }
    }
    return $state
}

function Save-State([string]$Root, $State) { Write-Json (Join-Path $Root 'state.json') $State }

# The task runs every two minutes. Log a condition when it changes, not on
# every pass, or a week of "waiting for DNS" buries the one line that matters.
function Set-Status([string]$Root, $State, [string]$Status) {
    if ($State.status -ne $Status) {
        Say $Status
        $State.status = $Status
        Save-State $Root $State
    } else {
        Write-Host ('{0} {1}' -f (Get-Date -Format s), $Status)
    }
}

function Get-Answer([string]$Name, [string]$Type, [string]$Server) {
    $records = @()
    try { $records = @(Resolve-DnsName -Name $Name -Type $Type -Server $Server -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop) }
    catch { }
    $addresses = @($records | Where-Object { $_.Type -eq $Type } | ForEach-Object { $_.IPAddress } | Sort-Object -Unique)
    $cnames = @($records | Where-Object { $_.Type -eq 'CNAME' } | ForEach-Object { $_.NameHost })
    $cname = $null
    if ($cnames.Count) { $cname = $cnames[0] }
    return [pscustomobject]@{ Addresses = $addresses; Cname = $cname }
}

# The first activation adds the site to Caddy, and Caddy immediately asks Let's
# Encrypt for a certificate. If the name still points elsewhere, that attempt
# fails, counts against Let's Encrypt's limit of 5 failed validations per name
# per hour, and puts Caddy on a retry backoff that stretches to hours. So hold
# the first activation until public resolvers answer the name with exactly the
# addresses of the record that tracks this connection. Returns $null when
# ready, otherwise what is still wrong. The answer names the CNAME the domain
# follows rather than its addresses when it has one: a CDN behind a wrong
# CNAME rotates addresses, and the task logs a status only when it changes.
function Test-DnsReady($Config) {
    foreach ($server in '1.1.1.1', '8.8.8.8') {
        foreach ($type in 'A', 'AAAA') {
            $want = Get-Answer $Config.dnsTarget $type $server
            $have = Get-Answer $Config.domain $type $server
            if ($type -eq 'A' -and $want.Addresses.Count -eq 0) { return "$($Config.dnsTarget) did not resolve via $server" }
            if (($have.Addresses -join ',') -eq ($want.Addresses -join ',')) { continue }
            if ($have.Cname -and $have.Cname -ne $Config.dnsTarget) {
                return ('{0} is a CNAME to {1} via {2}, not to {3}' -f $Config.domain, $have.Cname, $server, $Config.dnsTarget)
            }
            return ('{0} {1} via {2} is [{3}], not [{4}] like {5}' -f $Config.domain, $type, $server,
                ($have.Addresses -join ','), ($want.Addresses -join ','), $Config.dnsTarget)
        }
    }
    return $null
}

# Fetch version.txt through Caddy on this machine, by name, with certificate
# verification on. Success proves the route, the files and a publicly trusted
# certificate together. --resolve keeps the check independent of router
# hairpinning and of what DNS says from in here.
function Wait-Serving($Config, [string]$Expected, [int]$Seconds) {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ($true) {
        $r = Invoke-Native $curl @('--silent', '--show-error', '--fail', '--max-time', '10', '--ssl-revoke-best-effort',
            '--resolve', ($Config.domain + ':443:127.0.0.1'), ('https://' + $Config.domain + '/version.txt'))
        if ($r.Code -eq 0 -and $r.Output -eq $Expected) { return [pscustomobject]@{ Ok = $true; Detail = 'serving' } }
        $detail = if ($r.Code -eq 0) { 'serving ' + $r.Output } else { $r.Output }
        if ((Get-Date) -ge $deadline) { return [pscustomobject]@{ Ok = $false; Detail = $detail } }
        Start-Sleep -Seconds 3
    }
}

# Unpack docs/ at $Commit into a new release directory. Only files are
# published; nothing from the repository is executed.
function Get-ReleaseDirectory($Config, [string]$Name) {
    if ($Name -notmatch $ReleasePattern) { throw "Invalid release name: $Name" }
    $parent = [IO.Path]::GetFullPath((Join-Path $Config.root 'releases')).TrimEnd('\') + '\'
    $directory = [IO.Path]::GetFullPath((Join-Path $parent $Name))
    if (-not $directory.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release path escapes the deployment directory.'
    }
    if ((Test-Path -LiteralPath $directory) -and
        ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'A release directory must not be a link.'
    }
    return $directory
}

function New-Release($Config, [string]$Commit) {
    $name = '{0}-{1}' -f (Get-Date -Format yyyyMMddHHmmss), $Commit.Substring(0, 12)
    $dir = Get-ReleaseDirectory $Config $name
    $tarball = Join-Path $Config.root "work\$name.tar"
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    try {
        Invoke-Git $Config @('archive', '--format=tar', '-o', $tarball, $Commit, 'docs') | Out-Null
        New-Item -ItemType Directory -Path $dir | Out-Null
        $r = Invoke-Native $tar @('-xf', $tarball, '--strip-components', '1', '-C', $dir)
        if ($r.Code -ne 0) { throw "tar failed ($($r.Code)): $($r.Output)" }
        if (-not (Test-Path -LiteralPath (Join-Path $dir 'index.html') -PathType Leaf)) {
            throw "docs/index.html is missing at $Commit"
        }
        # Caddy runs as SYSTEM and follows links, so a link committed under
        # docs/ could publish any file on this machine. Plain files only.
        $links = @(Get-ChildItem -LiteralPath $dir -Recurse -Force |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
        if ($links.Count) { throw "docs/ at $Commit contains a link ($($links[0].Name)); refusing to publish it" }
        [IO.File]::WriteAllText((Join-Path $dir 'version.txt'), $Commit, (New-Object Text.ASCIIEncoding))
    } catch {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
        throw
    } finally {
        Remove-Item -LiteralPath $tarball -Force -ErrorAction SilentlyContinue
    }
    return $name
}

function Get-SiteText($Config, [string]$Release, [string]$Domain) {
    if (-not $Domain) { $Domain = $Config.domain }
    $rootPath = (Get-ReleaseDirectory $Config $Release) -replace '\\', '/'
    $logPath = (Join-Path $Config.root 'logs\access.log') -replace '\\', '/'
    return @"
# Written by yanpresence deploy/deploy.ps1 on every deploy - edit that, not this.
$Domain {
	root * "$rootPath"
	encode zstd gzip

	header {
		X-Yanpresence-Host "finprint-host"
		Strict-Transport-Security "max-age=63072000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		# One page and no build step, so no file name changes between
		# versions; browsers must check back for every one.
		Cache-Control "public, max-age=0, must-revalidate"
	}

	file_server

	log {
		output file "$logPath" {
			roll_size 10MB
			roll_keep 3
		}
	}
}
"@
}

# Point Caddy at release $Release, adding our import block to finprint's
# Caddyfile if it is missing (a re-run of finprint's setup.ps1 drops every
# co-hosted site's block). A failed validate or reload restores both files,
# and a failed reload leaves Caddy on its previous configuration, so the
# other sites on this server are never affected. $Domain defaults to the one
# in server.json. Returns $true if anything was reloaded.
function Set-SiteRelease($Config, [string]$Release, [string]$Domain) {
    $main = $Config.mainCaddyfile
    $site = Join-Path $Config.root 'Caddyfile'
    $oldMain = $null
    $oldSite = if (Test-Path -LiteralPath $site) { [IO.File]::ReadAllText($site) } else { $null }
    $newSite = Get-SiteText $Config $Release $Domain
    $newMain = $null
    try {
        # Read and update through one exclusive handle, so this deployment
        # cannot overwrite a co-host's edit made after reading a stale copy.
        $stream = [IO.File]::Open($main, 'Open', 'ReadWrite', 'None')
        try {
            $reader = New-Object IO.StreamReader($stream, $Utf8, $true, 1024, $true)
            try { $oldMain = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $newMain = $oldMain
            if (-not $oldMain.Contains($BeginMarker)) {
                $newMain = $oldMain.TrimEnd() + "`r`n`r`n$BeginMarker`r`nimport `"" + ($site -replace '\\', '/') + "`"`r`n$EndMarker`r`n"
            }
            if ($newMain -eq $oldMain -and $newSite -eq $oldSite) { return $false }
            if ($newMain -ne $oldMain) {
                [IO.File]::WriteAllText((Join-Path $Config.root ('logs\Caddyfile-before-' + (Get-Date -Format yyyyMMddHHmmss))), $oldMain, $Utf8)
                $bytes = $Utf8.GetBytes($newMain)
                $stream.Position = 0
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.SetLength($bytes.Length)
                $stream.Flush($true)
            }
            [IO.File]::WriteAllText($site, $newSite, $Utf8)
        } finally {
            $stream.Dispose()
        }
        Invoke-Caddy $Config 'validate'
        Invoke-Caddy $Config 'reload'
    } catch {
        # Only undo our own edit: another site's deploy may have written the
        # main Caddyfile since.
        if ($null -ne $oldMain -and $newMain -ne $oldMain -and [IO.File]::ReadAllText($main) -eq $newMain) {
            [IO.File]::WriteAllText($main, $oldMain, $Utf8)
        }
        if ($null -ne $oldSite) { [IO.File]::WriteAllText($site, $oldSite, $Utf8) }
        else { Remove-Item -LiteralPath $site -Force -ErrorAction SilentlyContinue }
        try { Invoke-Caddy $Config 'reload' } catch { }
        throw
    }
    return $true
}

# The name the site file serves, or $null without one. This is what Caddy
# was last given; it differs from server.json while a new domain waits for DNS.
function Get-SiteDomain($Config) {
    $site = Join-Path $Config.root 'Caddyfile'
    if (-not (Test-Path -LiteralPath $site)) { return $null }
    # The first line that is not blank or a comment is the site address.
    foreach ($line in [IO.File]::ReadAllLines($site)) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -match '^\s*((?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+)\s*\{\s*$') { return $Matches[1] }
        return $null
    }
    return $null
}

# Keep whatever the state refers to, plus the three newest releases.
function Remove-OldReleases($Config, $State) {
    $keep = @(@($State.configured, $State.active, $State.previous) | Where-Object { $_ } | ForEach-Object { $_.name })
    $all = @(Get-ChildItem -LiteralPath (Join-Path $Config.root 'releases') -Directory |
        Where-Object { $_.Name -match $ReleasePattern } | Sort-Object Name -Descending)
    $keep += @($all | Select-Object -First 3 | ForEach-Object { $_.Name })
    foreach ($d in $all) {
        if ($keep -contains $d.Name) { continue }
        # A file Caddy still has open fails the delete; the next deploy retries.
        try {
            $directory = Get-ReleaseDirectory $Config $d.Name
            Remove-Item -LiteralPath $directory -Recurse -Force
            Say "removed old release $($d.Name)"
        } catch { }
    }
}
