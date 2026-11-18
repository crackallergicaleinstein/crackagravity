# agy-direct setup - resolves the install, checks the OAuth chain, mints a local
# API key, and prints the client config. Safe to re-run on any machine.
#
#   powershell -ExecutionPolicy Bypass -File agy-direct\setup.ps1
#   powershell -ExecutionPolicy Bypass -File agy-direct\setup.ps1 -Port 8787 -Start

[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$BindHost = '127.0.0.1',
    [switch]$Start,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$cli = Join-Path $here 'cli.mjs'
$server = Join-Path $here 'server.mjs'

function Say([string]$msg) { if (-not $Quiet) { Write-Host $msg } }

Say ''
Say 'agy-direct setup'
Say '================'

# node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw 'node is not on PATH. Install Node 20+ and re-run.'
}
$ver = (& $node --version).Trim()
Say "node           $ver  ($node)"
$major = [int](($ver -replace '^v', '') -split '\.')[0]
if ($major -lt 20) {
    Write-Warning "node $ver is old; fetch/streaming may misbehave. Node 20+ recommended."
}

# environment that surprises people
foreach ($v in @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')) {
    $current = [Environment]::GetEnvironmentVariable($v)
    if ($current) {
        Say "note           $v=$current (the shim goes direct; installers may not)"
    }
}

# chain check
Say ''
Say 'chain check:'
& $node $cli --doctor
$doctorOk = ($LASTEXITCODE -eq 0)

if (-not $doctorOk) {
    Say ''
    Say 'If the keyring check failed: sign in to Antigravity (IDE or CLI) once on this'
    Say 'machine so the OAuth pair lands in the Windows Credential Manager, then re-run.'
    Say 'If the binary check failed: the built-in client pair is still tried; pass'
    Say '  --login-token <refresh_token>   to seed a token from another machine.'
}

# api key
Say ''
$cfgPath = Join-Path $env:USERPROFILE '.gemini\antigravity-direct\config.json'
$key = ''
if (Test-Path $cfgPath) {
    try { $key = (Get-Content $cfgPath -Raw | ConvertFrom-Json).api_key } catch { $key = '' }
}
if ($key) {
    Say 'api key         already configured'
} else {
    $key = (& $node $cli --key-gen | Select-Object -First 1)
    Say "api key         $key"
    Say "                stored in $cfgPath"
}

# models
Say ''
Say 'models this account may use (first 12):'
& $node $cli --models | Select-Object -First 14 | ForEach-Object { Say $_ }

# client config
Say ''
Say 'point any OpenAI-compatible client at:'
Say "  base_url   http://${BindHost}:${Port}/v1"
Say "  api_key    $key"
Say '  model      gemini-3.8-flash-low     (or: node agy-direct\cli.mjs --pick)'
Say ''
Say 'sanity:'
Say "  curl http://${BindHost}:${Port}/v1/models -H `"Authorization: Bearer $key`""
Say '  node agy-direct\cli.mjs --selftest'

if ($Start) {
    Say ''
    Say "starting server on http://${BindHost}:${Port}/v1  (Ctrl+C to stop)"
    $env:AGY_PORT = "$Port"
    $env:AGY_HOST = $BindHost
    & $node $server
}
