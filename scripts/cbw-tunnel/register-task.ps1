# Register the CBW tunnel keepers as logon-start Scheduled Tasks.
#
# Two keepers, both hidden + logon-start + self-healing:
#   - CBWTunnelReverse : ssh -R 15722 (server claude -> local desktop gateway)
#   - CBWTunnelForward : ssh -L 15723 (local browser -> server control plane)
#
# Paths are resolved from $PSScriptRoot (never a hard-coded non-ASCII literal —
# PowerShell 5.1 mis-decodes those as GBK and silently breaks the task Argument).
# Idempotent: -Force replaces any existing task of the same name.

$ErrorActionPreference = "Stop"

# Load local-only config; keepers consume it at run time, but fail fast here too
# so a misconfigured machine surfaces the error at registration time.
$Config = Join-Path $PSScriptRoot "config.local.ps1"
if (-not (Test-Path $Config)) {
  Write-Error "Missing $Config — copy config.local.example.ps1 to config.local.ps1 and fill in real values."
  exit 1
}
. $Config

$PsExe = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"

$keepers = @(
  @{ Task = "CBWTunnelReverse"; Script = "reverse-tunnel.ps1" },
  @{ Task = "CBWTunnelForward"; Script = "forward-tunnel.ps1" }
)

foreach ($k in $keepers) {
  $scriptPath = Join-Path $PSScriptRoot $k.Script
  if (-not (Test-Path $scriptPath)) { throw "keeper script not found: $scriptPath" }

  $action = New-ScheduledTaskAction -Execute $PsExe `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  # Interactive logon principal: needs the user's ssh key + a desktop session for
  # the loopback gateway to exist.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $k.Task -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output "registered task: $($k.Task)"
}

Get-ScheduledTask -TaskName "CBWTunnel*" | Select-Object TaskName, State | Format-Table -AutoSize
