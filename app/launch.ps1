# Launch crackagravity: start the server if it is not already up, then open the app
# window in its own Edge profile so it never merges into the main browser.
#
#   powershell -ExecutionPolicy Bypass -File app\launch.ps1
#   powershell -ExecutionPolicy Bypass -File app\launch.ps1 -Port 8790 -Restart

[CmdletBinding()]
param(
    [int]$Port = 8790,
    [string]$BindHost = '127.0.0.1',
    [switch]$NoWindow,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA 'crackagravity'
$profileDir = Join-Path $stateDir 'window'
$logOut = Join-Path $stateDir 'server.out.log'
$logErr = Join-Path $stateDir 'server.err.log'
New-Item -ItemType Directory -Force -Path $stateDir, $profileDir | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node 20+.' }

function Test-Port([string]$h, [int]$p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($h, $p, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(400)
        if ($ok -and $c.Connected) { $c.Close(); return $true }
        $c.Close()
        return $false
    } catch { return $false }
}

function Stop-AppServer {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'server\.mjs' -and $_.CommandLine -notmatch 'legacy-shim' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
}

if ($Restart) {
    Write-Host 'stopping the running app server'
    Stop-AppServer
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline -and (Test-Port $BindHost $Port)) { Start-Sleep -Milliseconds 200 }
}

$url = "http://${BindHost}:${Port}/"

if (-not (Test-Port $BindHost $Port)) {
    Write-Host "starting crackagravity on $url"
    $env:AGY_APP_PORT = "$Port"
    $env:AGY_APP_HOST = $BindHost
    $env:AGY_APP_OPEN = '0'

    # Relative script name: the working directory is this folder, and a quoted
    # absolute path with a space breaks Start-Process argument joining.
    $proc = Start-Process -FilePath $node -ArgumentList 'server.mjs' `
        -WorkingDirectory $here -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $logOut -RedirectStandardError $logErr

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $BindHost $Port) { break }
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Port $BindHost $Port)) {
        Write-Host 'server did not come up. tail of the log:'
        Get-Content $logErr -ErrorAction SilentlyContinue | Select-Object -Last 20
        exit 1
    }
    Write-Host "server pid $($proc.Id), logs in $stateDir"
} else {
    Write-Host "crackagravity already running on $url"
}

if ($NoWindow) { exit 0 }

$edgeCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path $_) }

# A single match collapses to a scalar; take the first element explicitly.
$edge = @($edgeCandidates) | Select-Object -First 1

if ($edge) {
    # Dedicated profile: the window is its own app and cannot be swallowed by an
    # already-running browser instance. `cmd /c start` detaches it so this script
    # never waits on a browser process.
    $browserArgs = '--app=' + $url + ' --user-data-dir="' + $profileDir + '" --no-first-run --no-default-browser-check --window-size=1440,940'
    Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c start "" "' + $edge + '" ' + $browserArgs) -WindowStyle Hidden | Out-Null
} else {
    Start-Process $url | Out-Null
}

# Leave the console free: the app runs detached from this script.
exit 0
