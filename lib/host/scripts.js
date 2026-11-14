/**
 * 划词助手 —— 桌面联动用的 PowerShell 脚本（Windows）。
 *
 * 单独拆出来有两个原因：一是便于 `desktop.js` 之外的测试直接跑这些脚本，
 * 二是这些字符串里有大量 `$`、引号与换行，集中放着比嵌在逻辑里好读。
 *
 * 约定：
 *   - 所有输出都是单行文本，`字段|base64(字段)|…` 形式，避免中文编码与换行问题。
 *   - 监听脚本常驻，`READY` 之后按需输出 `FOCUS|hwnd|b64(title)` 与 `CLIP|b64(text)|b64(app)`。
 *   - 输入脚本一次性执行，最后输出一行 JSON。
 *
 * @module dsh-wordhelper/lib/host/scripts
 */

/** 轮询间隔（毫秒）。 */
export const POLL_INTERVAL_MS = 420;

/** Win32 互操作：前台窗口、标题、以及绕过前台锁需要的线程 API。 */
const WIN32_TYPES = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WHWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
}
`;

/**
 * 常驻监听脚本：前台窗口变化 → FOCUS 行；剪贴板文字变化 → CLIP 行。
 * 每一行都显式 Flush，因为宿主是按行读 stdout 的。
 */
export const WATCHER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${WIN32_TYPES}
'@
function B64([string]$s) {
  if ($null -eq $s) { $s = '' }
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}
function TitleOf([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][WHWin32]::GetWindowText($h, $sb, 512)
  return $sb.ToString()
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$lastText = $null
$lastFocus = ''
while ($true) {
  $h = [WHWin32]::GetForegroundWindow()
  $title = TitleOf $h
  $hwndText = $h.ToInt64().ToString()
  $key = $hwndText + '|' + $title
  if ($key -ne $lastFocus) {
    $lastFocus = $key
    [Console]::Out.WriteLine('FOCUS|' + $hwndText + '|' + (B64 $title))
    [Console]::Out.Flush()
  }
  $text = ''
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() }
  } catch { $text = '' }
  if ($text -ne $lastText) {
    $lastText = $text
    if ($text.Length -gt 0) {
      [Console]::Out.WriteLine('CLIP|' + (B64 $text) + '|' + (B64 $title))
      [Console]::Out.Flush()
    }
  }
  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS}
}
`;

/**
 * 模拟输入脚本：写剪贴板 →（给了 hwnd 就切过去并确认）→ 等 delay → 发 Ctrl+V。
 *
 * 环境变量：
 *   WH_TEXT_B64  必填，要输入的文字（UTF-8 的 base64）
 *   WH_HWND      可选，目标窗口句柄；0 表示不切换窗口
 *   WH_SENDKEYS  可选，"0" 表示只写剪贴板、不发送按键
 *   WH_DELAY     可选，发送前的等待毫秒数
 */
export const PASTE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
${WIN32_TYPES}
'@
} catch {
  [Console]::Out.WriteLine('{"ok":false,"reason":"assembly"}')
  exit 0
}
try {
  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WH_TEXT_B64))
  [System.Windows.Forms.Clipboard]::SetText($text)
} catch {
  [Console]::Out.WriteLine('{"ok":false,"reason":"clipboard"}')
  exit 0
}
$sendKeys = $true
if ($env:WH_SENDKEYS -eq '0') { $sendKeys = $false }
$target = [int64]0
if ($env:WH_HWND) { [int64]::TryParse($env:WH_HWND, [ref]$target) | Out-Null }
if ($sendKeys -eq $false) {
  [Console]::Out.WriteLine('{"ok":true,"typed":false,"clipboard":true}')
  exit 0
}
if ($target -ne 0) {
  $want = [IntPtr]$target
  # 策略一：直接切
  [void][WHWin32]::SetForegroundWindow($want)
  Start-Sleep -Milliseconds 160
  $current = [WHWin32]::GetForegroundWindow().ToInt64()
  if ($current -ne $target) {
    # 策略二：挂到当前前台线程上再抢
    $fore = [WHWin32]::GetForegroundWindow()
    $procId = [uint32]0
    $foreThread = [WHWin32]::GetWindowThreadProcessId($fore, [ref]$procId)
    $selfThread = [WHWin32]::GetCurrentThreadId()
    [void][WHWin32]::AttachThreadInput($selfThread, $foreThread, $true)
    [void][WHWin32]::SetForegroundWindow($want)
    Start-Sleep -Milliseconds 120
    [void][WHWin32]::AttachThreadInput($selfThread, $foreThread, $false)
    Start-Sleep -Milliseconds 120
    $current = [WHWin32]::GetForegroundWindow().ToInt64()
  }
  if ($current -ne $target) {
    # 策略三：先敲一下 ALT（让系统认为有用户输入），再切
    try { [System.Windows.Forms.SendKeys]::SendWait('%') } catch {}
    Start-Sleep -Milliseconds 80
    [void][WHWin32]::SetForegroundWindow($want)
    Start-Sleep -Milliseconds 160
    $current = [WHWin32]::GetForegroundWindow().ToInt64()
  }
  if ($current -ne $target) {
    [Console]::Out.WriteLine('{"ok":false,"reason":"focus","clipboard":true}')
    exit 0
  }
}
$delay = 0
if ($env:WH_DELAY) { [int]::TryParse($env:WH_DELAY, [ref]$delay) | Out-Null }
if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
# 发送前再确认一次：前台如果是 DSH 自己，就绝不按键，免得把文字打进输入框。
if ($env:WH_SELF_TITLE_B64) {
  $selfTitle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:WH_SELF_TITLE_B64))
  $foreHwnd = [WHWin32]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][WHWin32]::GetWindowText($foreHwnd, $sb, 512)
  $foreTitle = $sb.ToString()
  if ($selfTitle -ne '' -and $foreTitle.Contains($selfTitle)) {
    [Console]::Out.WriteLine('{"ok":false,"reason":"still-self","clipboard":true}')
    exit 0
  }
}
try {
  [System.Windows.Forms.SendKeys]::SendWait('^v')
} catch {
  [Console]::Out.WriteLine('{"ok":false,"reason":"sendkeys","clipboard":true}')
  exit 0
}
[Console]::Out.WriteLine('{"ok":true,"typed":true,"clipboard":true}')
`;
