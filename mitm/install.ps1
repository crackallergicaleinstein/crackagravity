param(
    [switch]$Uninstall
)

# Installs the loopback TLS interceptor that removes the Antigravity
# systemInstruction (and optionally tools) from every upstream request.
# Persists user-level env vars, trusts the local CA, and registers a
# hidden startup task for the proxy. Reversible with -Uninstall.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ca = Join-Path $here 'ca.crt'
$proxy = Join-Path $here 'proxy.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'agy-mitm.lnk'

function Set-UserEnv([string]$name, [string]$value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'User')
}

if ($Uninstall) {
    foreach ($n in 'HTTPS_PROXY', 'HTTP_PROXY', 'AGY_CA_CERTS', 'MITM_MODE') {
        Set-UserEnv $n $null
    }
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
    & certutil -delstore -user Root 'AGY MITM CA' | Out-Null
    Get-CimInstance Win32_Process -Filter "name='node.exe'" |
        Where-Object { $_.CommandLine -like '*proxy.mjs*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host 'removed: env vars, startup entry, CA, running proxy'
    exit 0
}

if (-not (Test-Path $ca)) { throw "missing CA: $ca" }
& certutil -addstore -user Root $ca | Out-Null
Set-UserEnv 'HTTPS_PROXY' 'http://127.0.0.1:8899'
Set-UserEnv 'HTTP_PROXY' 'http://127.0.0.1:8899'
Set-UserEnv 'NO_PROXY' 'localhost,127.0.0.1,::1'
Set-UserEnv 'AGY_CA_CERTS' $ca
Set-UserEnv 'MITM_MODE' 'strip'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $node
$sc.Arguments = "`"$proxy`" 8899"
$sc.WorkingDirectory = $here
$sc.WindowStyle = 7
$sc.Save()

if (-not (Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $node -ArgumentList "`"$proxy`"", '8899' -WorkingDirectory $here -WindowStyle Hidden
}

Write-Host 'installed: CA trusted, proxy on 127.0.0.1:8899, env persisted, startup entry created'
Write-Host 'restart Antigravity for the hub to inherit the proxy settings'
