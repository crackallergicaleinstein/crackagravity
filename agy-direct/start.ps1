# Start the agy-direct shim in this window. Works from any install location.
#
#   powershell -ExecutionPolicy Bypass -File agy-direct\start.ps1
#   powershell -ExecutionPolicy Bypass -File agy-direct\start.ps1 -Port 9000 -Thinking HIGH

[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$BindHost = '127.0.0.1',
    [string]$Thinking = '',
    [int]$Concurrency = 4
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH. Install Node 20+.' }

$env:AGY_PORT = "$Port"
$env:AGY_HOST = $BindHost
$env:AGY_CONCURRENCY = "$Concurrency"
if ($Thinking) {
    $env:AGY_THINKING_LEVEL = $Thinking
} else {
    Remove-Item Env:AGY_THINKING_LEVEL -ErrorAction SilentlyContinue
}

& $node (Join-Path $PSScriptRoot 'server.mjs')
