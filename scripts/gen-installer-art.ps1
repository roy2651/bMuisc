# Generates bMuisc installer branding assets (ASCII-only script; CJK via char codes).
# Output: nsis-sidebar.bmp 164x314, nsis-header.bmp 150x57, dmg-background.png 660x400
Add-Type -AssemblyName System.Drawing
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\src-tauri\icons')).Path
$icon = [System.Drawing.Image]::FromFile("$root\icon.png")

$F36AA1 = [System.Drawing.Color]::FromArgb(255, 0xF3, 0x6A, 0xA1)
$AD65DC = [System.Drawing.Color]::FromArgb(255, 0xAD, 0x65, 0xDC)

function New-Canvas([int]$w, [int]$h, [System.Drawing.Imaging.PixelFormat]$fmt) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, $fmt)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  return @($bmp, $g)
}

function Add-Text($g, [string]$text, [string]$fontName, [int]$style, [single]$size, [System.Drawing.Brush]$brush, [System.Drawing.RectangleF]$rect) {
  $family = New-Object System.Drawing.FontFamily($fontName)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $path.AddString($text, $family, $style, $size, $rect, $sf)
  $g.FillPath($brush, $path)
  $path.Dispose(); $sf.Dispose(); $family.Dispose()
}

# ---- NSIS welcome/finish sidebar 164x314 (24bpp) ----
$pair = New-Canvas 164 314 ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$sb = $pair[0]; $g = $pair[1]
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(0, 0, 164, 314)),
  [System.Drawing.Color]::FromArgb(255, 0x25, 0x1A, 0x33),
  [System.Drawing.Color]::FromArgb(255, 0x12, 0x0F, 0x18),
  90.0)
$g.FillRectangle($bg, 0, 0, 164, 314)
$g.DrawImage($icon, 38, 58, 88, 88)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
Add-Text $g 'bMuisc' 'Segoe UI' ([int][System.Drawing.FontStyle]::Bold) 20 $white (New-Object System.Drawing.RectangleF(0, 160, 164, 40))
$gray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0xB9, 0xAF, 0xC6))
$cjk = -join @('B ', [char]0x7AD9, [char]0x97F3, [char]0x4E50, [char]0x53F0)
Add-Text $g $cjk 'Microsoft YaHei UI' 0 9.5 $gray (New-Object System.Drawing.RectangleF(0, 202, 164, 24))
$accent = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(50, 244, 64, 3)), $F36AA1, $AD65DC, 0.0)
$g.FillRectangle($accent, 50, 244, 64, 3)
$sb.Save("$root\nsis-sidebar.bmp", [System.Drawing.Imaging.ImageFormat]::Bmp)
$sb.Save("$env:TEMP\preview-sidebar.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $sb.Dispose()

# ---- NSIS header 150x57 (24bpp, light to blend with the white strip right of it) ----
$pair = New-Canvas 150 57 ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$hb = $pair[0]; $g = $pair[1]
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($icon, 7, 9, 38, 38)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x2A, 0x21, 0x35))
Add-Text $g 'bMuisc' 'Segoe UI' ([int][System.Drawing.FontStyle]::Bold) 13 $dark (New-Object System.Drawing.RectangleF(48, 0, 98, 57))
$hb.Save("$root\nsis-header.bmp", [System.Drawing.Imaging.ImageFormat]::Bmp)
$hb.Save("$env:TEMP\preview-header.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $hb.Dispose()

# ---- DMG background 660x400 (32bpp ARGB PNG; consumed by the macOS build) ----
$pair = New-Canvas 660 400 ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$db = $pair[0]; $g = $pair[1]
$bg2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(0, 0, 660, 400)),
  [System.Drawing.Color]::FromArgb(255, 0x24, 0x1A, 0x31),
  [System.Drawing.Color]::FromArgb(255, 0x12, 0x0F, 0x18),
  90.0)
$g.FillRectangle($bg2, 0, 0, 660, 400)
$g.DrawImage($icon, 266, 78, 128, 128)
Add-Text $g 'bMuisc' 'Segoe UI' ([int][System.Drawing.FontStyle]::Bold) 30 $white (New-Object System.Drawing.RectangleF(0, 226, 660, 52))
Add-Text $g $cjk 'Microsoft YaHei UI' 0 13 $gray (New-Object System.Drawing.RectangleF(0, 282, 660, 28))
$g.DrawRectangle([System.Drawing.Pens]::Transparent, 0, 0, 1, 1)
$db.Save("$root\dmg-background.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $db.Dispose()

$icon.Dispose()
Write-Output 'generated: nsis-sidebar.bmp, nsis-header.bmp, dmg-background.png'
