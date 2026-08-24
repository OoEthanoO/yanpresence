# Draws assets/yanpresence.ico.
#
# Committed output, run by hand -- the icon changes about never, and making the
# build depend on GDI+ to redraw the same bytes every time would be silly.
#
# The shapes are primitives rather than a font glyph on purpose: a tray icon is
# rendered at 16x16, where a "musical note" character from a system font turns
# to mush. Two heavy note heads and a beam survive it.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\yanpresence.ico'
$sizes = 16, 20, 24, 32, 48, 64, 128, 256

function New-Frame([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded square in Apple Music's red, so the icon reads as what it is
  # reporting on even at tray size.
  $pad = [math]::Max(1.0, $s * 0.045)
  $box = New-Object System.Drawing.RectangleF($pad, $pad, ($s - 2 * $pad), ($s - 2 * $pad))
  $r = $s * 0.23

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($box.X, $box.Y, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($box.Right - 2 * $r, $box.Y, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($box.Right - 2 * $r, $box.Bottom - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc($box.X, $box.Bottom - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $box,
    [System.Drawing.Color]::FromArgb(255, 250, 36, 60),
    [System.Drawing.Color]::FromArgb(255, 251, 92, 116),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillPath($brush, $path)

  # A beamed pair of notes, in white, drawn from primitives.
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $headW = $s * 0.30
  $headH = $s * 0.235
  $stemW = [math]::Max(1.0, $s * 0.075)

  $leftX = $s * 0.22
  $rightX = $s * 0.53
  $baseY = $s * 0.70
  $topY = $s * 0.235

  $stemRight = $rightX + $headW - $stemW
  $stemLeft = $leftX + $headW - $stemW

  # Stems first, so the heads sit over their ends.
  $g.FillRectangle($white, $stemLeft, $topY, $stemW, ($baseY - $topY))
  $g.FillRectangle($white, $stemRight, ($topY - $s * 0.055), $stemW, ($baseY - $topY - $s * 0.10))

  # The beam, slightly deeper than a stem so it holds together when scaled down.
  $g.FillRectangle($white, $stemLeft, ($topY - $s * 0.055), ($stemRight + $stemW - $stemLeft), ($s * 0.135))

  $g.FillEllipse($white, $leftX, ($baseY - $headH * 0.5), $headW, $headH)
  $g.FillEllipse($white, $rightX, ($baseY - $headH * 0.5 - $s * 0.045), $headW, $headH)

  $g.Dispose()
  $brush.Dispose()
  $white.Dispose()
  $path.Dispose()
  return $bmp
}

# The classic uncompressed frame: a BITMAPINFOHEADER whose height is doubled
# to account for the AND mask, then bottom-up BGRA rows, then the mask itself.
# The mask is all zeros because the alpha channel already carries the shape,
# but it has to be there -- its absence is not "no mask", it is a truncated
# frame.
function Get-DibFrame([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $pixels = New-Object byte[] ($data.Stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
  $stride = $data.Stride
  $bmp.UnlockBits($data)

  $stream = New-Object System.IO.MemoryStream
  $w2 = New-Object System.IO.BinaryWriter($stream)

  $w2.Write([uint32]40)            # biSize
  $w2.Write([int32]$w)             # biWidth
  $w2.Write([int32]($h * 2))       # biHeight: image + mask
  $w2.Write([uint16]1)             # biPlanes
  $w2.Write([uint16]32)            # biBitCount
  $w2.Write([uint32]0)             # biCompression: BI_RGB
  $w2.Write([uint32]($w * $h * 4)) # biSizeImage
  $w2.Write([int32]0); $w2.Write([int32]0)
  $w2.Write([uint32]0); $w2.Write([uint32]0)

  # Bottom-up, which is what a DIB means by row order.
  for ($y = $h - 1; $y -ge 0; $y--) { $w2.Write($pixels, $y * $stride, $w * 4) }

  # AND mask: 1bpp, each row padded out to a 4-byte boundary.
  $maskRow = [int][math]::Floor(($w + 31) / 32) * 4
  $zeros = New-Object byte[] $maskRow
  for ($y = 0; $y -lt $h; $y++) { $w2.Write($zeros, 0, $maskRow) }

  $w2.Flush()
  $bytes = $stream.ToArray()
  $w2.Dispose()
  $stream.Dispose()
  # The comma is load-bearing: without it PowerShell unrolls the byte[] into the
  # pipeline and the caller gets an object[], which BinaryWriter.Write binds to
  # its single-byte overload. That writes one byte per frame and produces a
  # directory whose entries all point past the end of the file.
  return , $bytes
}

function Get-PngFrame([System.Drawing.Bitmap]$bmp) {
  $stream = New-Object System.IO.MemoryStream
  $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  $stream.Dispose()
  return , $bytes
}

# PNG entries only from 128 up. Windows has understood them since Vista and
# they keep a 256x256 frame from costing 256KB of raw BGRA -- but System.Drawing
# reads PNG frames back badly, and the tray icon is loaded through
# System.Drawing. The sizes the tray actually asks for stay uncompressed.
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Frame $s
  if ($s -ge 128) { $bytes = [byte[]](Get-PngFrame $bmp) } else { $bytes = [byte[]](Get-DibFrame $bmp) }
  $frames += , @{ size = $s; bytes = $bytes }
  $bmp.Dispose()
}

$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ico)

# ICONDIR
$w.Write([uint16]0)                # reserved
$w.Write([uint16]1)                # type: icon
$w.Write([uint16]$frames.Count)

# ICONDIRENTRY per frame. Offsets follow the whole directory.
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  # 256 is written as 0: the field is one byte wide.
  $w.Write([byte]$(if ($f.size -ge 256) { 0 } else { $f.size }))
  $w.Write([byte]$(if ($f.size -ge 256) { 0 } else { $f.size }))
  $w.Write([byte]0)                # palette entries
  $w.Write([byte]0)                # reserved
  $w.Write([uint16]1)              # colour planes
  $w.Write([uint16]32)             # bits per pixel
  $w.Write([uint32]$f.bytes.Length)
  $w.Write([uint32]$offset)
  $offset += $f.bytes.Length
}

foreach ($f in $frames) { $w.Write([byte[]]$f.bytes, 0, $f.bytes.Length) }

$w.Flush()
[System.IO.File]::WriteAllBytes($out, $ico.ToArray())
$w.Dispose()
$ico.Dispose()

Write-Output "Wrote $out ($((Get-Item $out).Length) bytes, $($frames.Count) sizes)"
