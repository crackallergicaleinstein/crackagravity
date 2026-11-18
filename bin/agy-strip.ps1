param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

# Runs agy through the local strip proxy so the systemInstruction and tool
# declarations never reach the upstream model. Starts the proxy if needed.
# Path-independent: everything is resolved from this script's folder.

$here = Split-Path -Parent $PSScriptRoot          # repo root
$mitm = Join-Path $here 'mitm'

$env:HTTPS_PROXY = 'http://127.0.0.1:8899'
$env:HTTP_PROXY = 'http://127.0.0.1:8899'
$env:AGY_CA_CERTS = Join-Path $mitm 'ca.crt'
$env:MITM_MODE = 'strip'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH' }

$listening = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Start-Process -FilePath $node `
        -ArgumentList @((Join-Path $mitm 'proxy.mjs'), '8899') `
        -WorkingDirectory $mitm -WindowStyle Hidden
    Start-Sleep -Milliseconds 600
}

$agy = if (Test-Path (Join-Path $env:USERPROFILE '.gemini\bin\agy.exe')) {
    Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'
} else {
    'agy.exe'
}

& $agy @Args
exit $LASTEXITCODE
