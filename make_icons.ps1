# make_icons.ps1 — generates CinePilot's icon set.
#
# Mark: rounded red gradient tile + white play triangle. At 32px and above,
# fullscreen corner brackets are added around the triangle (the "auto fullscreen"
# half of the extension); at 16px they are dropped so the glyph stays legible.
#
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\make_icons.ps1

Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # ---- rounded tile ----
  $pad = [Math]::Max(1, [int]($size * 0.05))
  $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2*$pad), ($size - 2*$pad))
  $radius = [int]($size * 0.24)
  $d = [Math]::Max(2, $radius * 2)

  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $gp.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
  $gp.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
  $gp.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
  $gp.CloseFigure()

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 255, 71, 92),
        [System.Drawing.Color]::FromArgb(255, 199, 15, 43),
        45.0)
  $g.FillPath($bg, $gp)

  # ---- play triangle ----
  $cx = $size / 2.0
  $cy = $size / 2.0
  $tw = $size * 0.26          # half-width
  $th = $size * 0.30          # half-height
  $shift = $size * 0.045      # optical centering nudge

  $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $pts = @(
    (New-Object System.Drawing.PointF(($cx - $tw * 0.62 + $shift), ($cy - $th))),
    (New-Object System.Drawing.PointF(($cx - $tw * 0.62 + $shift), ($cy + $th))),
    (New-Object System.Drawing.PointF(($cx + $tw + $shift), $cy))
  )
  $g.FillPolygon($whiteBrush, [System.Drawing.PointF[]]$pts)

  # ---- fullscreen corner brackets (larger sizes only) ----
  if ($size -ge 32) {
    $sw = [Math]::Max(1.0, $size * 0.062)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 255, 255), $sw)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $inset = $size * 0.20     # distance from the tile edge
    $len = $size * 0.11       # arm length
    $lo = $inset
    $hi = $size - $inset

    # top-left
    $g.DrawLine($pen, $lo, ($lo + $len), $lo, $lo)
    $g.DrawLine($pen, $lo, $lo, ($lo + $len), $lo)
    # top-right
    $g.DrawLine($pen, ($hi - $len), $lo, $hi, $lo)
    $g.DrawLine($pen, $hi, $lo, $hi, ($lo + $len))
    # bottom-right
    $g.DrawLine($pen, $hi, ($hi - $len), $hi, $hi)
    $g.DrawLine($pen, $hi, $hi, ($hi - $len), $hi)
    # bottom-left
    $g.DrawLine($pen, ($lo + $len), $hi, $lo, $hi)
    $g.DrawLine($pen, $lo, $hi, $lo, ($hi - $len))

    $pen.Dispose()
  }

  $whiteBrush.Dispose()
  $bg.Dispose()
  $gp.Dispose()
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($s in 16, 32, 48, 128) {
  New-Icon $s (Join-Path $dir ("icon{0}.png" -f $s))
  Write-Output ("wrote icon{0}.png" -f $s)
}
