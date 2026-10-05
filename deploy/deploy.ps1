<#
    deploy.ps1 - publish the yanpresence website on finprint-host.

    The scheduled task yanpresence-site-deploy runs this every two minutes as
    SYSTEM, from C:\ProgramData\yanpresence\ops. Run it by hand, elevated, to
    deploy at once or to see why nothing changed:

        powershell -ExecutionPolicy Bypass -File C:\ProgramData\yanpresence\ops\deploy.ps1

    The site is docs/ from the public GitHub repository: one static page, no
    build. Each pass fetches main and, when docs/ has changed, unpacks it into
    a new release and points Caddy at that. finprint's Caddy owns 80/443 for
    every site on this machine; this site plugs in the way the others do,
    through a "# BEGIN yanpresence (managed)" import block.

        C:\ProgramData\yanpresence\
            server.json       tool paths and names, written by install.ps1
            state.json        configured, active and previous release
            Caddyfile         site block, rewritten on every switch
            repo\             clone of the repository, no working tree
            releases\<id>\    docs/ at one commit, plus version.txt
            ops\              these scripts, as installed
            logs\             deploy.log, caddy.log, access.log, backups

    A release counts as live only once https://<domain>/version.txt, fetched
    through Caddy with a publicly trusted certificate, returns its commit. A
    new release that is not served within 30 seconds is switched back, and
    that version of docs/ is not tried again until docs/ changes or -Retry.

    To change the domain, re-run install.ps1 -Domain <new name>. The site
    keeps answering on the old name until the new one resolves to this
    connection, then moves, the same way the first activation waits.
#>

[CmdletBinding()]
param(
    [string]$Root = 'C:\ProgramData\yanpresence',
    # Deploy a specific commit. Disable the task first, or its next pass
    # moves the site back to main.
    [string]$Ref = 'origin/main',
    # Try again a version of docs/ that was rolled back before.
    [switch]$Retry,
    # Append to logs\deploy.log. The scheduled task passes this.
    [switch]$Log
)

. (Join-Path $PSScriptRoot 'common.ps1')

$CertificateHint = 'Caddy may still be obtaining the certificate; see C:\Users\ethan\finprint\logs\caddy.log'

# Point Caddy back at the last release that served, and remember which
# version of docs/ failed so the next pass does not try it again.
function Undo-Switch($Config, $State, [string]$FailedTree) {
    Set-SiteRelease $Config $State.active.name | Out-Null
    $State.configured = $State.active
    $State.failedTree = $FailedTree
    Save-State $Root $State
}

function Invoke-Deploy {
    $config = Read-Json (Join-Path $Root 'server.json')
    if (-not $config) { throw "$Root\server.json is missing. Run install.ps1 first." }
    $domain = $config.domain
    $state = Read-State $Root
    $script:State = $state

    Invoke-Git $config @('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main') | Out-Null
    $commit = (Invoke-Git $config @('rev-parse', '--verify', ($Ref + '^{commit}'))).Trim()
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw "Could not resolve $Ref." }
    $tree = (Invoke-Git $config @('rev-parse', '--verify', ($commit + ':docs'))).Trim()

    # The name Caddy was last given. It differs from server.json while a new
    # domain from install.ps1 -Domain waits for DNS.
    $siteDomain = Get-SiteDomain $config
    if (-not $siteDomain) { $siteDomain = $domain }

    # A re-run of finprint's setup.ps1 regenerates its Caddyfile without our
    # import. A missing site file is worse: finprint's import of it would fail
    # validation for every site on this server. Put both back, under the name
    # Caddy already has, rather than wait for the next change to docs/.
    if ($state.configured -and (-not [IO.File]::ReadAllText($config.mainCaddyfile).Contains($BeginMarker) -or
            -not (Test-Path -LiteralPath (Join-Path $Root 'Caddyfile')))) {
        Set-SiteRelease $config $state.configured.name $siteDomain | Out-Null
        Say "restored the yanpresence site in Caddy ($($config.mainCaddyfile))"
    }

    # A new domain gets the same rule as the first activation, for the same
    # reason: Caddy keeps serving the old name until the new one resolves to
    # this connection, and only then gets the new name and its certificate.
    $pendingWait = 5
    if ($state.configured -and $siteDomain -ne $domain) {
        $notReady = Test-DnsReady $config
        if ($notReady) {
            Set-Status $Root $state "waiting for DNS before moving the site from $siteDomain to ${domain}: $notReady"
            return
        }
        Say "DNS for $domain points at this connection; moving the site from $siteDomain"
        Set-SiteRelease $config $state.configured.name | Out-Null
        # Not yet seen serving under the new name.
        $state.active = $null
        Save-State $Root $state
        $pendingWait = 180
    }

    # Caddy points at a release that has not been seen serving: a first
    # activation or a new domain still waiting for its certificate, or a pass
    # that stopped between a switch and its check. Promote it once it answers.
    if ($state.configured -and (-not $state.active -or $state.active.name -ne $state.configured.name)) {
        $check = Wait-Serving $config $state.configured.commit $pendingWait
        if ($check.Ok) {
            if ($state.active) { $state.previous = $state.active }
            $state.active = $state.configured
            $state.failedTree = $null
            Save-State $Root $state
            Say "https://$domain is serving release $($state.active.name)"
        } elseif ($state.active) {
            $stuck = $state.configured.name
            Undo-Switch $config $state $state.configured.tree
            Say "release $stuck was not being served ($($check.Detail)); Caddy is back on $($state.active.name)"
        } else {
            Set-Status $Root $state ("configured release $($state.configured.name), waiting for https://$domain " +
                "to answer: $($check.Detail). $CertificateHint")
            return
        }
    }

    if ($state.configured -and $state.configured.tree -eq $tree) {
        Set-Status $Root $state "up to date: docs/ at $($state.active.commit.Substring(0, 12)) is live"
        return
    }

    if ($state.failedTree -eq $tree -and -not $Retry) {
        Set-Status $Root $state ("docs/ at $($commit.Substring(0, 12)) was rolled back before and is not retried " +
            'until docs/ changes. Run deploy.ps1 -Retry to try it again.')
        return
    }

    if (-not $state.configured) {
        $notReady = Test-DnsReady $config
        if ($notReady) { Set-Status $Root $state "waiting for DNS before the first activation: $notReady"; return }
        Say "DNS for $domain points at this connection; activating"
    }

    $name = New-Release $config $commit
    Say "built release $name from $commit"
    $release = [pscustomobject]@{ name = $name; commit = $commit; tree = $tree }
    Set-SiteRelease $config $name | Out-Null
    $state.configured = $release
    Save-State $Root $state

    # With an earlier release the certificate exists and the switch is
    # near-instant. The first activation has to obtain one.
    $wait = if ($state.active) { 30 } else { 180 }
    $check = Wait-Serving $config $commit $wait
    if ($check.Ok) {
        if ($state.active) { $state.previous = $state.active }
        $state.active = $release
        $state.failedTree = $null
        Save-State $Root $state
        Say "https://$domain is serving release $name"
        Remove-OldReleases $config $state
        Set-Status $Root $state "up to date: docs/ at $($state.active.commit.Substring(0, 12)) is live"
        return
    }
    if ($state.active) {
        Undo-Switch $config $state $tree
        throw "release $name was not served within $wait s ($($check.Detail)); Caddy is back on $($state.active.name)"
    }
    # First activation: leave Caddy alone so it can finish obtaining the
    # certificate. Re-adding the site would only restart its attempts.
    Set-Status $Root $state "configured release $name, waiting for https://$domain to answer: $($check.Detail). $CertificateHint"
}

# Dot-sourcing loads the functions without running a pass, for tests.
if ($MyInvocation.InvocationName -eq '.') { return }

$lock = $null
$code = 0
try {
    Assert-Administrator
    if ($Log) {
        $script:LogPath = Join-Path $Root 'logs\deploy.log'
        if ((Test-Path -LiteralPath $script:LogPath) -and (Get-Item -LiteralPath $script:LogPath).Length -gt 5MB) {
            Move-Item -LiteralPath $script:LogPath -Destination ($script:LogPath + '.1') -Force
        }
    }
    try { $lock = [IO.File]::Open((Join-Path $Root 'deploy.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another deploy pass is running.' }
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    Invoke-Deploy
} catch {
    $code = 1
    $message = 'FAILED: ' + $_.Exception.Message
    if ($script:State) { try { Set-Status $Root $script:State $message } catch { Say $message } } else { Say $message }
} finally {
    if ($lock) { $lock.Dispose() }
}
exit $code
