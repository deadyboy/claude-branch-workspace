# CBW reverse tunnel keeper — local Windows -> USTC server.
#
# Maintains a reverse SSH tunnel so the server's Claude CLI can reach the local
# desktop gateway (127.0.0.1:15722). Loopback-bound on the server (NOT exposed to
# the network). Server-side settings.json points ANTHROPIC_BASE_URL at this port.
#
# Self-healing: restarts ssh whenever it exits (network blip, server restart,
# laptop sleep). Intended to run hidden at logon via a Scheduled Task.

$ErrorActionPreference = "Continue"

# Load local-only config (host/key/ports). Fail loudly if missing — the public
# repo never ships real values; operators copy config.local.example.ps1.
$Config = Join-Path $PSScriptRoot "config.local.ps1"
if (-not (Test-Path $Config)) {
  Write-Error "Missing $Config — copy config.local.example.ps1 to config.local.ps1 and fill in real values."
  exit 1
}
. $Config

$SshExe  = "C:\Windows\System32\OpenSSH\ssh.exe"
$KeyFile = $CbwSshKey
$Target  = $CbwSshTarget
$LogDir  = Join-Path $PSScriptRoot "logs"
$LogFile = Join-Path $LogDir "reverse-tunnel.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $LogFile -Value $line
}

Log "keeper started (pid $PID)"

# -N: no remote command; -R: reverse-forward loopback:15722 -> local 15722;
# ServerAlive*: detect a dead link; ExitOnForwardFailure: bail (so we retry) if
# the server port is already taken rather than running without the forward.
$sshArgs = @(
  "-i", $KeyFile,
  "-N",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=accept-new",
  "-R", "127.0.0.1:${CbwReversePort}:127.0.0.1:${CbwReversePort}",
  $Target
)

while ($true) {
  Log "connecting..."
  & $SshExe @sshArgs 2>> $LogFile
  $code = $LASTEXITCODE
  Log "ssh exited (code $code); retrying in 5s"
  Start-Sleep -Seconds 5
}
