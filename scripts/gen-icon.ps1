# App icon source PNG: 512x512, pink-purple gradient rounded square + white bold "BM" (bilibili music)
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads no-BOM files as ANSI,
# and UTF-8 Chinese comments silently corrupt parsing of later statements.
Add-Type -AssemblyName System.Drawing

$size = 512
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded square path (inset 10px, corner radius 118)
$r = 118
$rect = New-Object System.Drawing.Rectangle(10, 10, 492, 492)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = 2 * $r
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

# 45-degree gradient #fb7299 -> #b16cea (same colors as the app UI)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(0xfb, 0x72, 0x99),
  [System.Drawing.Color]::FromArgb(0xb1, 0x6c, 0xea),
  45.0)
$g.FillPath($grad, $path)

# Letter shapes via vector path (AddString), scaled to target width, then centered
$family = New-Object System.Drawing.FontFamily('Arial')
$style = [System.Drawing.FontStyle]::Bold
$fmt = New-Object System.Drawing.StringFormat
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$origin = New-Object System.Drawing.Point(0, 0)
$gp.AddString('BM', $family, [int]$style, 200, $origin, $fmt)
$b = $gp.GetBounds()
$scale = 330 / $b.Width
$mx = New-Object System.Drawing.Drawing2D.Matrix
$mx.Translate(-$b.X, -$b.Y)
$mx.Scale($scale, $scale)
$mx.Translate(($size - 330) / 2, ($size - $b.Height * $scale) / 2 + 6)  # optical center, slight lift
$gp.Transform($mx)
$g.FillPath([System.Drawing.Brushes]::White, $gp)

# Self-check: count near-white pixels to confirm the letters rendered
$white = 0
for ($y = 0; $y -lt $size; $y += 4) {
  for ($x = 0; $x -lt $size; $x += 4) {
    $p = $bmp.GetPixel($x, $y)
    if ($p.R -ge 250 -and $p.G -ge 250 -and $p.B -ge 250) { $white++ }
  }
}

$g.Dispose()
$bmp.Save("$PSScriptRoot\app-icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "written $PSScriptRoot\app-icon.png white-samples=$white"
if ($white -lt 50) { throw 'BM text not rendered' }
