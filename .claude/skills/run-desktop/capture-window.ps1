# Captures a window exactly as the OS compositor shows it (Tier 2 WebContentsViews included), cropped to its visible frame.
# Usage: powershell -File capture-window.ps1 <hwnd> <out.png>
param([Int64]$Hwnd, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class OcCap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
}
"@
[OcCap]::SetProcessDPIAware() | Out-Null
$r = New-Object OcCap+RECT
# DWMWA_EXTENDED_FRAME_BOUNDS (9): the visible frame, without Windows 11's invisible resize borders.
[OcCap]::DwmGetWindowAttribute([IntPtr]$Hwnd, 9, [ref]$r, 16) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"$w x $h"
