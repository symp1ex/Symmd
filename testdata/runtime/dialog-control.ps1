[CmdletBinding()]
param(
    [Parameter(Mandatory)] [int] $ProcessId,
    [Parameter(Mandatory)] [string] $Title,
    [string] $Path,
    [int] $FileNameControlId = 1001,
    [int] $AcceptButtonControlId = 1,
    [switch] $ButtonOnly,
    [switch] $ListOnly
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class SymmdDialogControl
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int capacity);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int capacity);

    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    private const uint WM_SETTEXT = 0x000C;
    private const uint BM_CLICK = 0x00F5;

    private static string Text(IntPtr hwnd)
    {
        var text = new StringBuilder(1024);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    private static string ClassName(IntPtr hwnd)
    {
        var text = new StringBuilder(256);
        GetClassNameW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    public static IntPtr FindTopLevel(int processId, string title)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, parameter) => {
            uint candidateProcessId;
            GetWindowThreadProcessId(hwnd, out candidateProcessId);
            if (candidateProcessId == (uint)processId && Text(hwnd) == title)
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string[] DescribeChildren(IntPtr parent)
    {
        var descriptions = new List<string>();
        EnumChildWindows(parent, (hwnd, parameter) => {
            descriptions.Add(String.Format("HWND=0x{0:X} ID={1} CLASS={2} TEXT={3}", hwnd.ToInt64(), GetDlgCtrlID(hwnd), ClassName(hwnd), Text(hwnd)));
            return true;
        }, IntPtr.Zero);
        return descriptions.ToArray();
    }

    public static bool SetControlText(IntPtr parent, int controlId, string className, string text)
    {
        IntPtr control = IntPtr.Zero;
        EnumChildWindows(parent, (hwnd, parameter) => {
            if (GetDlgCtrlID(hwnd) == controlId && ClassName(hwnd) == className)
            {
                control = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (control == IntPtr.Zero) return false;
        SendMessageW(control, WM_SETTEXT, IntPtr.Zero, text);
        return true;
    }

    public static bool ClickControl(IntPtr parent, int controlId, string className)
    {
        IntPtr control = IntPtr.Zero;
        EnumChildWindows(parent, (hwnd, parameter) => {
            if (GetDlgCtrlID(hwnd) == controlId && ClassName(hwnd) == className)
            {
                control = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (control == IntPtr.Zero) return false;
        SendMessageW(control, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
        return true;
    }
}
'@

$deadline = [DateTime]::UtcNow.AddSeconds(15)
$dialog = [IntPtr]::Zero
while ($dialog -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
    $dialog = [SymmdDialogControl]::FindTopLevel($ProcessId, $Title)
    if ($dialog -eq [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 100
    }
}
if ($dialog -eq [IntPtr]::Zero) {
    throw "Dialog '$Title' for process $ProcessId was not found."
}

Write-Output ('DIALOG_HWND=0x{0:X}' -f $dialog.ToInt64())
if ($ListOnly) {
    [SymmdDialogControl]::DescribeChildren($dialog) | Write-Output
    return
}
if (-not $ButtonOnly -and [string]::IsNullOrWhiteSpace($Path)) {
    throw '-Path is required unless -ListOnly is used.'
}
if (-not $ButtonOnly -and -not [SymmdDialogControl]::SetControlText($dialog, $FileNameControlId, 'Edit', $Path)) {
    throw "File name Edit control ID $FileNameControlId was not found."
}
if (-not [SymmdDialogControl]::ClickControl($dialog, $AcceptButtonControlId, 'Button')) {
    throw "Accept Button control ID $AcceptButtonControlId was not found."
}
Write-Output "DIALOG_ACCEPTED=True"
