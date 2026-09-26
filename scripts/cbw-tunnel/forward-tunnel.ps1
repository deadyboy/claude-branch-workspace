# CBW forward tunnel keeper — local UI -> USTC server control plane.
#
# Maintains a forward SSH tunnel so the local browser reaches the control plane
# running on the server (127.0.0.1:15723 there) at the same address locally.
# Loopback-bound on both ends (NOT exposed to the network).
#
# Self-healing: restarts ssh whenever it exits. Intended to run hidden at logon
# via a Scheduled Task, alongside the reverse-tunnel keeper.

$ErrorActionPreference = "Continue"

$SshExe  = "C:\Windows\System32\OpenSSH\ssh.exe"
$KeyFile = Join-Path $env:USERPROFILE ".ssh\id_rsa"
$Target  = "jianf@210.45.73.166"
$LogDir  = Join-Path $PSScriptRoot "logs"
$LogFile = Join-Path $LogDir "forward-tunnel.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $LogFile -Value $line
}

Log "forward keeper started (pid $PID)"

# -N: no remote command; -L: forward local 15723 -> server loopback 15723
# (the server control plane). ExitOnForwardFailure: bail so we retry if the
# local port is already taken.
$sshArgs = @(
  "-i", $KeyFile,
  "-N",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=accept-new",
  "-L", "127.0.0.1:15723:127.0.0.1:15723",
  $Target
)

while ($true) {
  Log "connecting..."
  & $SshExe @sshArgs 2>> $LogFile
  $code = $LASTEXITCODE
  Log "ssh exited (code $code); retrying in 5s"
  Start-Sleep -Seconds 5
}
