# Scratch: redact the account email from docs and screenshots before publishing.

$ErrorActionPreference = 'Stop'
$root = 'C:\Users\usr\antigravity mogged'
$email = 'hamdamovarayxona4@gmail.com'

foreach ($file in @('README.md', 'report.md')) {
    $path = Join-Path $root $file
    if (-not (Test-Path $path)) { continue }
    $text = Get-Content $path -Raw
    $text = $text.Replace($email, 'user@example.com')
    $text = $text.Replace('C:\Users\usr\antigravity mogged', 'C:\path\to\agy')
    $text = $text.Replace('C:\\Users\\usr\\antigravity mogged', 'C:\\path\\to\\agy')
    $text = $text.Replace('\Users\usr\antigravity mogged', '\path\to\agy')
    Set-Content $path -Value $text -NoNewline
    Write-Host "sanitized $file"
}

Add-Type -AssemblyName System.Drawing

# The account block sits at the top-left of every screenshot's rail.
$rects = @(
    @{ X = 18;  Y = 122; W = 220; H = 26 },   # email line
    @{ X = 18;  Y = 146; W = 200; H = 18 }    # tier line
)

foreach ($png in Get-ChildItem (Join-Path $root 'app') -Filter 'shot*.png') {
    $bytes = [System.IO.File]::ReadAllBytes($png.FullName)
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    $img = [System.Drawing.Image]::FromStream($ms)
    $bmp = New-Object System.Drawing.Bitmap($img.Width, $img.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20, 20, 19))
    foreach ($r in $rects) {
        $g.FillRectangle($brush, $r.X, $r.Y, $r.W, $r.H)
    }
    $g.Dispose()
    $bmp.Save($png.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $img.Dispose(); $ms.Dispose()
    Write-Host "redacted $($png.Name)"
}
