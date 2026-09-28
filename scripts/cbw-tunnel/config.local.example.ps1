# CBW tunnel configuration — LOCAL ONLY.
#
# Copy config.local.example.ps1 to config.local.ps1 and fill in real values.
# config.local.ps1 is gitignored and never committed to a shared repository.
# The keepers (reverse-tunnel.ps1 / forward-tunnel.ps1 / register-task.ps1)
# dot-source this file and fail loudly if it is missing.

# SSH identity used by the keepers (path to the private key).
$CbwSshKey = "$env:USERPROFILE\.ssh\id_rsa"

# Remote SSH target: user@host of the CBW server.
$CbwSshTarget = "REDACTED@REDACTED"

# Loopback ports (fixed topology, do not change unless you also update the
# server-side systemd unit and the local Vision Bridge):
$CbwReversePort = 15722   # server claude  -> local gateway ( -R )
$CbwForwardPort = 15723   # local browser  -> server CP    ( -L )
