# Redact the account email from docs and screenshots before publishing.
# Path-independent: operates on the repo this script lives in.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$email = 'hamdamovarayxona4@gmail.com'

foreach ($file in @('README.md', 'docs/handoff.md', 'docs/report.md')) {
    $path = Join-Path $root $file
    if (-not (Test-Path $path)) { continue }
    $text = Get-Content $path -Raw
    $text = $text.Replace($email, 'user@example.com')
    Set-Content $path -Value $text -NoNewline
    Write-Host "sanitized $file"
}

Add-Type -AssemblyName System.Drawing

$imageDir = Join-Path $root 'docs\images'
foreach ($png in Get-ChildItem $imageDir -Filter '*.png' -ErrorAction SilentlyContinue) {
    $bytes = [System.IO.File]::ReadAllBytes($png.FullName)
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    $img = [System.Drawing.Image]::FromStream($ms)
    $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 20, 19))
    $g.FillRectangle($brush, 18, 122, 220, 26)
    $g.FillRectangle($brush, 18, 146, 200, 18)
    $g.Dispose()
    $bmp.Save($png.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $img.Dispose(); $ms.Dispose()
    Write-Host "redacted $($png.Name)"
}
