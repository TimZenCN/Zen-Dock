# install-cli.ps1 —— 把 zd 命令加进用户 PATH
#
# 只改 HKCU\Environment\Path，不碰系统级 PATH，不需要管理员权限。
# 幂等：已经在 PATH 里就什么也不做。
# 保持原值的注册表类型（REG_EXPAND_SZ），避免 %USERPROFILE% 这类变量被固化。

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
$SubKey = 'Environment'
$Name = 'Path'

function Get-PathEntry {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
    if (-not $key) { return @{ Value = ''; Kind = 'String' } }
    try {
        $value = $key.GetValue($Name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = 'String'
        try { $kind = $key.GetValueKind($Name).ToString() } catch { }
        return @{ Value = [string]$value; Kind = $kind }
    } finally {
        $key.Close()
    }
}

function Set-PathEntry([string]$Value, [string]$Kind) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $true)
    if (-not $key) { throw "打不开 HKCU\$SubKey" }
    try {
        $type = [Microsoft.Win32.RegistryValueKind]::String
        if ($Kind -eq 'ExpandString') { $type = [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue($Name, $Value, $type)
    } finally {
        $key.Close()
    }
    Send-SettingChange
}

function Send-SettingChange {
    # 广播 WM_SETTINGCHANGE，让已经开着的终端/资源管理器重新读环境变量
    if (-not ('Win32.NativeMethods' -as [type])) {
        Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $out = [UIntPtr]::Zero
    [void][Win32.NativeMethods]::SendMessageTimeout(
        [IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out)
}

function Split-PathList([string]$Value) {
    if (-not $Value) { return @() }
    return $Value.Split(';') | Where-Object { $_ -ne '' }
}

function Test-SamePath([string]$A, [string]$B) {
    $na = $A.TrimEnd('\', '/')
    $nb = $B.TrimEnd('\', '/')
    return [string]::Equals($na, $nb, [System.StringComparison]::OrdinalIgnoreCase)
}

# ---------- 状态 ----------

$current = Get-PathEntry
$entries = Split-PathList $current.Value
$present = @($entries | Where-Object { Test-SamePath $_ $Root }).Count -gt 0

if ($Status -or ($Uninstall -and -not $present)) {
    Write-Host "项目目录   $Root"
    Write-Host "注册表类型 $($current.Kind)"
    if ($present) {
        Write-Host "PATH 状态  已注册" -ForegroundColor Green
    } else {
        Write-Host "PATH 状态  未注册" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "（新开的终端才会生效，已经开着的窗口要重启）"
    if ($Status) { exit 0 }
}

# ---------- 卸载 ----------

if ($Uninstall) {
    if (-not $present) {
        Write-Host "PATH 里没有这个目录，无需卸载" -ForegroundColor Yellow
        exit 0
    }
    $kept = $entries | Where-Object { -not (Test-SamePath $_ $Root) }
    Set-PathEntry (($kept -join ';')) $current.Kind
    Write-Host "已从用户 PATH 移除：$Root" -ForegroundColor Green
    Write-Host "新开的终端生效。" -ForegroundColor Gray
    exit 0
}

# ---------- 安装 ----------

if ($present) {
    Write-Host "已经在 PATH 里了，不用重复添加。" -ForegroundColor Green
    Write-Host "当前值：$Root" -ForegroundColor Gray
    exit 0
}

# 先备份，出问题能手工恢复
$backupDir = Join-Path $Root 'shell'
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFile = Join-Path $backupDir "path-backup-$stamp.txt"
@(
    "备份时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "注册表类型: $($current.Kind)",
    "原始用户 PATH:",
    $current.Value
) | Set-Content -Path $backupFile -Encoding UTF8
Write-Host "已备份原 PATH 到 $backupFile" -ForegroundColor Gray

$newValue = (@($entries) + $Root) -join ';'
if ($newValue.Length -gt 2047) {
    Write-Host "警告：新的 PATH 有 $($newValue.Length) 个字符，超过 2047 后部分老程序可能读不全。" -ForegroundColor Yellow
}

Set-PathEntry $newValue $current.Kind

Write-Host ""
Write-Host "已加入用户 PATH：$Root" -ForegroundColor Green
Write-Host "注册表类型保持为 $($current.Kind)" -ForegroundColor Gray
Write-Host ""
Write-Host "新开一个终端，然后试：" -ForegroundColor Gray
Write-Host "  zd list" -ForegroundColor Cyan
Write-Host ""
Write-Host "撤销：.\install-cli.ps1 -Uninstall" -ForegroundColor Gray
