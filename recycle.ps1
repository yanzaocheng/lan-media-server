# 把 $env:RECYCLE_PATHS（换行分隔）里的文件/文件夹移到回收站，不弹任何对话框
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Recycler {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
    public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string[] paths) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3; // FO_DELETE
    op.pFrom = string.Join("\0", paths) + "\0\0";
    op.fFlags = 0x0004 | 0x0010 | 0x0040 | 0x0400; // SILENT | NOCONFIRMATION | ALLOWUNDO | NOERRORUI
    int r = SHFileOperation(ref op);
    if (r == 0 && op.fAnyOperationsAborted) r = -1;
    return r;
  }
}
'@
$paths = $env:RECYCLE_PATHS -split "`n" | Where-Object { $_ -ne '' }
$code = [Recycler]::Recycle([string[]]$paths)
if ($code -ne 0) { [Console]::Error.WriteLine("SHFileOperation failed: 0x{0:X}" -f $code); exit 1 }
