const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') {
  console.error('桌面快捷方式仅适用于 Windows；其他系统请使用 bash start.sh。');
  process.exitCode = 1;
} else {
  const root = path.resolve(__dirname, '..');
  // Fixed PowerShell code receives paths through environment variables, not interpolation.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$scannerRoot = $env:SCANNER_PROJECT_ROOT
$scannerDesktop = if ($env:SCANNER_DESKTOP_DIR) { [System.IO.Path]::GetFullPath($env:SCANNER_DESKTOP_DIR) } else { [Environment]::GetFolderPath('Desktop') }
if (-not (Test-Path -LiteralPath $scannerDesktop -PathType Container)) { throw 'Desktop directory does not exist.' }
$scannerPath = Join-Path $scannerDesktop '美股与A股扫描器.lnk'
$scannerShell = New-Object -ComObject WScript.Shell
$scannerShortcut = $scannerShell.CreateShortcut($scannerPath)
if ((Test-Path -LiteralPath $scannerPath) -and -not [string]::Equals($scannerShortcut.WorkingDirectory, $scannerRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'A shortcut for a different project already uses this name. Rename it before retrying.' }
$scannerShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\\cmd.exe'
$scannerShortcut.Arguments = '/d /c ""' + (Join-Path $scannerRoot 'start.bat') + '""'
$scannerShortcut.WorkingDirectory = $scannerRoot
$scannerShortcut.Description = '美股与A股扫描器：启动本机服务并打开页面'
$scannerShortcut.IconLocation = (Join-Path $scannerRoot 'assets\\scanner.ico') + ',0'
$scannerShortcut.WindowStyle = 1
$scannerShortcut.Save()
Write-Output ('已创建桌面图标：' + $scannerPath)
`;
  const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, SCANNER_PROJECT_ROOT: root } });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`创建失败：${result.error.message}`);
  process.exitCode = result.status ?? 1;
}
