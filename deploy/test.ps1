# Offline regression checks for deployment state and Caddy file operations.
# Run with Windows PowerShell 5.1; no modules, network, Git, Caddy, elevation,
# scheduled tasks, or changes outside a unique .build sandbox are needed.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path $repoRoot ('.build\deploy-tests-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

. (Join-Path $PSScriptRoot 'deploy.ps1') -Root $sandbox
$script:RealSetSiteRelease = ${function:Set-SiteRelease}

$script:Assertions = 0
$script:Cases = 0
$script:OldCommit = 'a' * 40
$script:NewCommit = 'b' * 40
$script:OldTree = '1' * 40
$script:NewTree = '2' * 40

function Assert-Equal($Actual, $Expected, [string]$Message) {
    $script:Assertions++
    if ($Actual -ne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}

function Assert-True([bool]$Condition, [string]$Message) {
    $script:Assertions++
    if (-not $Condition) { throw $Message }
}

function New-Record([string]$Commit, [string]$Tree) {
    return [pscustomobject]@{
        name = '20261005090000-' + $Commit.Substring(0, 12)
        commit = $Commit
        tree = $Tree
    }
}

function New-Case([string]$Name, $Active = $null, $Configured = $null, [string]$FailedTree = $null) {
    $script:Root = Join-Path $sandbox $Name
    $script:Ref = 'origin/main'
    $script:Retry = $false
    foreach ($directory in @($script:Root, (Join-Path $script:Root 'releases'), (Join-Path $script:Root 'logs'))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $script:Mock = [pscustomobject]@{
        Commit = $script:NewCommit
        Tree = $script:NewTree
        DnsReason = $null
        DnsChecks = 0
        NewReleases = New-Object 'System.Collections.Generic.List[string]'
        Switches = New-Object 'System.Collections.Generic.List[string]'
        ServingChecks = New-Object 'System.Collections.Generic.List[object]'
        ServingResults = New-Object 'System.Collections.Generic.Queue[object]'
        CleanupCalls = 0
        Messages = New-Object 'System.Collections.Generic.List[string]'
    }
    $main = Join-Path $script:Root 'MainCaddyfile'
    [IO.File]::WriteAllText($main, "other.example.invalid {`r`n    respond untouched`r`n}`r`n", $Utf8)
    $config = [pscustomobject]@{
        root = $script:Root
        domain = 'presence.example.invalid'
        dnsTarget = 'host.example.invalid'
        mainCaddyfile = $main
        repo = (Join-Path $script:Root 'no-git-checkout')
        git = 'must-not-execute-git.exe'
        caddy = 'must-not-execute-caddy.exe'
    }
    Write-Json (Join-Path $script:Root 'server.json') $config
    if (-not $Configured) { $Configured = $Active }
    if ($Configured) {
        [IO.File]::AppendAllText($main, "$BeginMarker`r`n# fixture import`r`n$EndMarker`r`n", $Utf8)
        [IO.File]::WriteAllText((Join-Path $script:Root 'Caddyfile'), (Get-SiteText $config $Configured.name), $Utf8)
    }
    Save-State $script:Root ([pscustomobject]@{
        configured = $Configured
        active = $Active
        previous = $null
        failedTree = $FailedTree
        status = $null
    })
    return $config
}

function Add-ServingResult([bool]$Ok, [string]$Detail = 'mock trusted HTTPS response') {
    $script:Mock.ServingResults.Enqueue([pscustomobject]@{ Ok = $Ok; Detail = $Detail })
}

# Fail closed if a future deploy change bypasses one of the explicit mocks.
function Invoke-Native { throw 'Offline regression attempted to invoke a native executable.' }
function Invoke-Caddy { throw 'Offline regression attempted to invoke Caddy.' }
function Assert-Administrator { throw 'Dot-sourcing deploy.ps1 must not require elevation.' }

function Invoke-Git($Config, [string[]]$Arguments) {
    if ($Arguments[0] -eq 'fetch') { return '' }
    if ($Arguments[0] -eq 'rev-parse' -and $Arguments[2] -eq 'origin/main^{commit}') { return $script:Mock.Commit }
    if ($Arguments[0] -eq 'rev-parse' -and $Arguments[2] -eq ($script:Mock.Commit + ':docs')) { return $script:Mock.Tree }
    throw ('Unexpected mocked Git invocation: ' + ($Arguments -join ' '))
}

function Test-DnsReady($Config) {
    $script:Mock.DnsChecks++
    return $script:Mock.DnsReason
}

function New-Release($Config, [string]$Commit) {
    $script:Mock.NewReleases.Add($Commit)
    return '20261005100000-' + $Commit.Substring(0, 12)
}

function Set-SiteRelease($Config, [string]$Release, [string]$Domain) {
    Assert-Equal $Config.root $script:Root 'A switch escaped the test fixture'
    $script:Mock.Switches.Add($Release)
    [IO.File]::WriteAllText((Join-Path $Config.root 'Caddyfile'), (Get-SiteText $Config $Release $Domain), $Utf8)
    if (-not [IO.File]::ReadAllText($Config.mainCaddyfile).Contains($BeginMarker)) {
        [IO.File]::AppendAllText($Config.mainCaddyfile, "$BeginMarker`r`n# mocked import`r`n$EndMarker`r`n", $Utf8)
    }
    return $true
}

function Wait-Serving($Config, [string]$Expected, [int]$Seconds) {
    $script:Mock.ServingChecks.Add([pscustomobject]@{ Commit = $Expected; Seconds = $Seconds })
    if (-not $script:Mock.ServingResults.Count) { throw 'Unexpected trusted-serving check; no mocked result was queued.' }
    return $script:Mock.ServingResults.Dequeue()
}

function Remove-OldReleases($Config, $State) { $script:Mock.CleanupCalls++ }
function Say([string]$Message) { $script:Mock.Messages.Add($Message) }

function Run-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    Assert-Equal $script:Mock.ServingResults.Count 0 'A scenario left an expected serving check unconsumed'
    $script:Cases++
    Write-Host "PASS: $Name"
}

Run-Case 'unchanged docs reports the actual active commit' {
    $old = New-Record $script:OldCommit $script:OldTree
    New-Case 'unchanged-docs' -Active $old | Out-Null
    $script:Mock.Tree = $script:OldTree
    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.active.commit $script:OldCommit 'Unchanged docs must retain the active commit'
    Assert-Equal $state.configured.commit $script:OldCommit 'Unchanged docs must not change configured provenance'
    Assert-True ($state.status.Contains($script:OldCommit.Substring(0, 12))) 'Status omitted the actual serving commit'
    Assert-True (-not $state.status.Contains('docs/ at ' + $script:NewCommit.Substring(0, 12) + ' is live')) 'Status falsely labeled the fetched commit as serving'
    Assert-Equal $script:Mock.NewReleases.Count 0 'Unchanged docs created a release'
    Assert-Equal $script:Mock.Switches.Count 0 'Unchanged docs switched Caddy'
    Assert-Equal $script:Mock.ServingChecks.Count 0 'Unchanged docs entered a pending activation'
}

Run-Case 'first activation waits for DNS and then for trusted serving' {
    $config = New-Case 'first-activation'
    $mainBefore = [IO.File]::ReadAllText($config.mainCaddyfile)
    $script:Mock.DnsReason = 'domain still points at the old provider'
    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.configured $null 'A release was configured before DNS was ready'
    Assert-Equal $state.active $null 'A release was marked active before DNS was ready'
    Assert-True ($state.status -like 'waiting for DNS before the first activation:*') 'DNS gating did not explain the pending activation'
    Assert-Equal $script:Mock.NewReleases.Count 0 'DNS gating still created a release'
    Assert-Equal $script:Mock.Switches.Count 0 'DNS gating still changed Caddy'
    Assert-Equal $script:Mock.ServingChecks.Count 0 'DNS gating still attempted serving verification'
    Assert-Equal ([IO.File]::ReadAllText($config.mainCaddyfile)) $mainBefore 'DNS gating modified the shared Caddyfile'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:Root 'Caddyfile'))) 'DNS gating wrote a site block'

    $script:Mock.DnsReason = $null
    Add-ServingResult $false 'certificate is not ready'
    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.configured.commit $script:NewCommit 'DNS readiness did not configure the first release'
    Assert-Equal $state.active $null 'A failed trusted-serving check marked the first release active'
    Assert-Equal $script:Mock.Switches.Count 1 'First activation switched Caddy more than once'
    Assert-Equal $script:Mock.ServingChecks[0].Seconds 180 'First activation did not allow time for its certificate'

    Add-ServingResult $true
    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.active.commit $script:NewCommit 'Successful trusted serving did not promote the first release'
    Assert-Equal $script:Mock.Switches.Count 1 'Pending certificate recovery unnecessarily reconfigured Caddy'
    Assert-Equal $script:Mock.NewReleases.Count 1 'Pending certificate recovery unnecessarily rebuilt docs'
    Assert-Equal $script:Mock.DnsChecks 2 'Pending certificate recovery unnecessarily restarted DNS gating'
}

Run-Case 'failed new release rolls back and remains suppressed' {
    $old = New-Record $script:OldCommit $script:OldTree
    New-Case 'failed-upgrade' -Active $old | Out-Null
    Add-ServingResult $false 'the expected version was not served'
    $failure = $null
    try { Invoke-Deploy } catch { $failure = $_.Exception.Message }
    Assert-True ([bool]$failure) 'A failed new-release check did not report failure'
    Assert-True ($failure -like '*Caddy is back on*') 'Failure did not report the rollback'
    $state = Read-State $script:Root
    Assert-Equal $state.active.commit $script:OldCommit 'Rollback lost the last serving release'
    Assert-Equal $state.configured.commit $script:OldCommit 'Rollback did not restore the configured release'
    Assert-Equal $state.failedTree $script:NewTree 'Rollback lost the failed docs tree marker'
    Assert-Equal $script:Mock.Switches.Count 2 'A failed upgrade did not switch once and then roll back once'
    Assert-Equal $script:Mock.Switches[1] $old.name 'Rollback pointed Caddy at the wrong release'
    Assert-Equal $script:Mock.CleanupCalls 0 'Failed deployment pruned releases'

    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.failedTree $script:NewTree 'A later pass erased the failure marker'
    Assert-Equal $state.active.commit $script:OldCommit 'A suppressed retry changed the active release'
    Assert-Equal $script:Mock.NewReleases.Count 1 'An unchanged failed docs tree was retried'
    Assert-Equal $script:Mock.Switches.Count 2 'An unchanged failed docs tree changed Caddy'
    Assert-Equal $script:Mock.ServingChecks.Count 1 'An unchanged failed docs tree was checked again'
    Assert-True ($state.status -like '*was rolled back before and is not retried*') 'Suppressed retry did not explain the failure marker'
}

Run-Case 'interrupted configured release is promoted after trusted serving' {
    $old = New-Record $script:OldCommit $script:OldTree
    $pending = New-Record $script:NewCommit $script:NewTree
    New-Case 'interrupted-success' -Active $old -Configured $pending -FailedTree ('3' * 40) | Out-Null
    Add-ServingResult $true
    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.active.name $pending.name 'A verified interrupted release was not promoted'
    Assert-Equal $state.configured.name $pending.name 'Recovery changed the already configured release'
    Assert-Equal $state.previous.name $old.name 'Recovery did not preserve the former active release'
    Assert-Equal $state.failedTree $null 'Recovery did not clear the stale failure marker'
    Assert-Equal $script:Mock.ServingChecks[0].Commit $script:NewCommit 'Recovery verified the wrong release commit'
    Assert-Equal $script:Mock.NewReleases.Count 0 'Recovery rebuilt an already configured release'
    Assert-Equal $script:Mock.Switches.Count 0 'Recovery unnecessarily switched Caddy'
    Assert-True ($state.status.Contains($script:NewCommit.Substring(0, 12))) 'Recovery status omitted the verified active commit'
}

Run-Case 'interrupted unserved release rolls back without immediate retry' {
    $old = New-Record $script:OldCommit $script:OldTree
    $pending = New-Record $script:NewCommit $script:NewTree
    New-Case 'interrupted-failure' -Active $old -Configured $pending | Out-Null
    Add-ServingResult $false 'configured release never became ready'
    Invoke-Deploy
    $state = Read-State $script:Root
    Assert-Equal $state.active.name $old.name 'Interrupted failure lost the last serving release'
    Assert-Equal $state.configured.name $old.name 'Interrupted failure did not restore Caddy state'
    Assert-Equal $state.failedTree $script:NewTree 'Interrupted failure lost its failure marker'
    Assert-Equal $script:Mock.Switches.Count 1 'Interrupted failure did not perform exactly one rollback'
    Assert-Equal $script:Mock.NewReleases.Count 0 'Interrupted failure immediately rebuilt the failed docs tree'
    Assert-True ($state.status -like '*was rolled back before and is not retried*') 'Interrupted failure did not suppress its retry'
}

# The following scenarios run the production Set-SiteRelease implementation.
# Only the external Caddy operation is replaced: opening the exclusive stream,
# its five-argument StreamReader, writes, backups, and rollback are all real.
function New-CaddyMock([string]$FailVerb = '') {
    $script:CaddyMock = [pscustomobject]@{
        FailVerb = $FailVerb
        FailureInjected = $false
        Calls = New-Object 'System.Collections.Generic.List[string]'
        Snapshots = New-Object 'System.Collections.Generic.List[object]'
    }
}

function Invoke-Caddy($Config, [string]$Verb) {
    Assert-Equal $Config.root $script:Root 'Caddy mock escaped the test fixture'
    $script:CaddyMock.Calls.Add($Verb)
    # Caddy must be able to open the main config after Set-SiteRelease has
    # written it. This also catches a StreamReader/stream handle left open.
    $probe = [IO.File]::Open($Config.mainCaddyfile, 'Open', 'ReadWrite', 'None')
    $probe.Dispose()
    $site = Join-Path $Config.root 'Caddyfile'
    $script:CaddyMock.Snapshots.Add([pscustomobject]@{
        Main = [IO.File]::ReadAllText($Config.mainCaddyfile)
        Site = $(if (Test-Path -LiteralPath $site) { [IO.File]::ReadAllText($site) } else { $null })
    })
    if ($script:CaddyMock.FailVerb -eq $Verb -and -not $script:CaddyMock.FailureInjected) {
        $script:CaddyMock.FailureInjected = $true
        throw "injected Caddy $Verb failure"
    }
}

Run-Case 'real Caddy edit quotes spaced imports and unchanged content avoids reload' {
    $config = New-Case 'caddy path with spaces'
    New-CaddyMock
    $release = (New-Record $script:NewCommit $script:NewTree).name
    $mainBefore = [IO.File]::ReadAllText($config.mainCaddyfile)
    $changed = & $script:RealSetSiteRelease $config $release
    Assert-Equal $changed $true 'A first site configuration did not report its change'
    Assert-Equal ($script:CaddyMock.Calls -join ',') 'validate,reload' 'A first site configuration did not validate then reload'
    $mainAfter = [IO.File]::ReadAllText($config.mainCaddyfile)
    $sitePath = (Join-Path $config.root 'Caddyfile') -replace '\\', '/'
    $expectedImport = 'import "' + $sitePath + '"'
    Assert-True $mainAfter.Contains($expectedImport) 'The Caddy import did not quote the path containing spaces'
    Assert-True $mainAfter.StartsWith($mainBefore.TrimEnd()) 'The Caddy edit changed another site'
    Assert-Equal ([regex]::Matches($mainAfter, [regex]::Escape($BeginMarker)).Count) 1 'The Caddy edit duplicated its managed block'
    $siteAfter = [IO.File]::ReadAllText((Join-Path $config.root 'Caddyfile'))
    Assert-True $siteAfter.Contains('root * "' + ((Join-Path $config.root ('releases\' + $release)) -replace '\\', '/') + '"') 'The release root path was not quoted'
    Assert-Equal $script:CaddyMock.Snapshots[0].Main $mainAfter 'Caddy validation could not read the completed main config'
    Assert-Equal $script:CaddyMock.Snapshots[0].Site $siteAfter 'Caddy validation could not read the completed site config'
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $config.root 'logs') -Filter 'Caddyfile-before-*')
    Assert-Equal $backups.Count 1 'The main Caddyfile edit did not keep one backup'
    Assert-Equal ([IO.File]::ReadAllText($backups[0].FullName)) $mainBefore 'The backup did not preserve the pre-edit main config'

    $changed = & $script:RealSetSiteRelease $config $release
    Assert-Equal $changed $false 'Unchanged site content reported a change'
    Assert-Equal ($script:CaddyMock.Calls -join ',') 'validate,reload' 'Unchanged site content still invoked Caddy'
    Assert-Equal ([IO.File]::ReadAllText($config.mainCaddyfile)) $mainAfter 'An unchanged pass modified the main Caddyfile'
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $config.root 'Caddyfile'))) $siteAfter 'An unchanged pass modified the site Caddyfile'
    $probe = [IO.File]::Open($config.mainCaddyfile, 'Open', 'ReadWrite', 'None')
    $probe.Dispose()
}

foreach ($failureVerb in @('validate', 'reload')) {
    Run-Case "real Caddy $failureVerb failure restores both original files" {
        $config = New-Case ('caddy-failed-' + $failureVerb)
        New-CaddyMock $failureVerb
        $sitePath = Join-Path $config.root 'Caddyfile'
        $oldSite = Get-SiteText $config (New-Record $script:OldCommit $script:OldTree).name
        [IO.File]::WriteAllText($sitePath, $oldSite, $Utf8)
        # Main deliberately lacks the managed import, as when another site's
        # setup rewrites it. Both files change before the injected failure.
        $oldMain = [IO.File]::ReadAllText($config.mainCaddyfile)
        $oldMainBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($config.mainCaddyfile))
        $oldSiteBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($sitePath))
        $failure = $null
        try { & $script:RealSetSiteRelease $config (New-Record $script:NewCommit $script:NewTree).name | Out-Null }
        catch { $failure = $_.Exception.Message }
        Assert-Equal $failure "injected Caddy $failureVerb failure" 'The Caddy edit failed before reaching the injected external failure'
        Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes($config.mainCaddyfile))) $oldMainBytes 'Rollback did not restore the original main Caddyfile bytes'
        Assert-Equal ([Convert]::ToBase64String([IO.File]::ReadAllBytes($sitePath))) $oldSiteBytes 'Rollback did not restore the original site Caddyfile bytes'
        $expectedCalls = if ($failureVerb -eq 'validate') { 'validate,reload' } else { 'validate,reload,reload' }
        Assert-Equal ($script:CaddyMock.Calls -join ',') $expectedCalls 'The failed edit did not reload the restored configuration'
        $last = $script:CaddyMock.Snapshots[$script:CaddyMock.Snapshots.Count - 1]
        Assert-Equal $last.Main $oldMain 'Recovery reloaded before restoring the main Caddyfile'
        Assert-Equal $last.Site $oldSite 'Recovery reloaded before restoring the site Caddyfile'
        Assert-True ($script:CaddyMock.Snapshots[0].Main -ne $oldMain) 'Failure fixture never changed the main Caddyfile'
        Assert-True ($script:CaddyMock.Snapshots[0].Site -ne $oldSite) 'Failure fixture never changed the site Caddyfile'
    }
}

Run-Case 'failed first Caddy configuration removes the newly created site file' {
    $config = New-Case 'caddy-first-failure'
    New-CaddyMock 'validate'
    $mainBefore = [IO.File]::ReadAllText($config.mainCaddyfile)
    $failure = $null
    try { & $script:RealSetSiteRelease $config (New-Record $script:NewCommit $script:NewTree).name | Out-Null }
    catch { $failure = $_.Exception.Message }
    Assert-Equal $failure 'injected Caddy validate failure' 'The first edit did not reach Caddy validation'
    Assert-Equal ([IO.File]::ReadAllText($config.mainCaddyfile)) $mainBefore 'Failed first configuration left its import behind'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $config.root 'Caddyfile'))) 'Failed first configuration left its new site file behind'
    Assert-Equal $script:CaddyMock.Snapshots[1].Site $null 'Recovery reloaded while the failed new site file still existed'
}

Run-Case 'release directory validation rejects malformed names and path traversal' {
    $config = New-Case 'release-names'
    $validName = (New-Record $script:NewCommit $script:NewTree).name
    $expected = [IO.Path]::GetFullPath((Join-Path $config.root ('releases\' + $validName)))
    Assert-Equal (Get-ReleaseDirectory $config $validName) $expected 'A valid release name did not resolve inside releases'
    foreach ($name in @('', '..', '..\outside', '../outside', 'C:\outside', ($validName + '\child'), ($validName + '.old'), '20261005120000-not-a-sha')) {
        $failure = $null
        try { Get-ReleaseDirectory $config $name | Out-Null } catch { $failure = $_.Exception.Message }
        Assert-True ([bool]$failure) "Invalid release name was accepted: $name"
    }
}

Run-Case 'release directory validation rejects a sandbox junction' {
    $config = New-Case 'release-junction'
    $target = Join-Path $config.root 'junction-target'
    New-Item -ItemType Directory -Path $target | Out-Null
    $marker = Join-Path $target 'keep.txt'
    [IO.File]::WriteAllText($marker, 'The target must remain untouched.', $Utf8)
    $validName = (New-Record $script:NewCommit $script:NewTree).name
    $junction = Join-Path $config.root ('releases\' + $validName)
    # A local NTFS junction needs no elevation; both it and its target stay
    # inside this scenario's sandbox. No recursive link deletion is performed.
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    Assert-True ([bool]((Get-Item -LiteralPath $junction -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'The junction fixture was not a reparse point'
    $failure = $null
    try { Get-ReleaseDirectory $config $validName | Out-Null } catch { $failure = $_.Exception.Message }
    Assert-Equal $failure 'A release directory must not be a link.' 'A release junction was not rejected'
    Assert-Equal ([IO.File]::ReadAllText($marker)) 'The target must remain untouched.' 'Rejecting the junction changed its target'
}

Write-Host "PASS: $script:Cases scenarios, $script:Assertions assertions. Offline state fixtures: $sandbox"
