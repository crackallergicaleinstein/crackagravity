param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

# Runs agy through the local strip proxy so the systemInstruction and tool
# declarations never reach the upstream model. Starts the proxy if needed.

$env:HTTPS_PROXY = 'http://127.0.0.1:8899'
$env:HTTP_PROXY = 'http://127.0.0.1:8899'
$env:AGY_CA_CERTS = 'C:\Users\usr\antigravity mogged\mitm\ca.crt'
$env:MITM_MODE = 'strip'

$listening = Get-NetTCPConnection -LocalPort 8899 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
        -ArgumentList '"C:\Users\usr\antigravity mogged\mitm\proxy.mjs"', '8899' `
        -WorkingDirectory 'C:\Users\usr\antigravity mogged\mitm' -WindowStyle Hidden
    Start-Sleep -Milliseconds 600
}

& "$env:USERPROFILE\.gemini\bin\agy.exe" @Args
exit $LASTEXITCODE
