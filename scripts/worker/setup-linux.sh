#!/usr/bin/env bash
# Prepares a GitHub-hosted Ubuntu runner for one Git2App job (docs/ARCHITECTURE.md §7).
#
# The repository being built is untrusted. Its install and build scripts run as "g2a", a user
# with no sudo, a scrubbed environment (see packages/runner/src/exec.ts) and no access to:
#   - the runner's home, where the runner keeps its own files;
#   - cloud metadata and private networks (iptables owner match), so it cannot reach the VM's
#     identity endpoint or anything internal.
# The runner itself keeps the job's OIDC request token in its own process environment, which
# another user cannot read.
set -euo pipefail

SANDBOX_USER=g2a
WORK_ROOT=/g2a-work

if ! id "$SANDBOX_USER" >/dev/null 2>&1; then
  sudo useradd --create-home --shell /usr/sbin/nologin "$SANDBOX_USER"
fi
command -v setfacl >/dev/null || sudo apt-get install -y -qq acl >/dev/null

# The runner's home holds its credentials and work folders; nobody else may enter it.
sudo chmod 700 "$HOME"

# Job files live outside the runner's home, handed to the sandbox user per job.
sudo mkdir -p "$WORK_ROOT"
sudo chown "$(id -u):$(id -g)" "$WORK_ROOT"
sudo chmod 755 "$WORK_ROOT"

# No cloud metadata, Azure wire server or private ranges for the sandbox user.
for net in 169.254.0.0/16 168.63.129.16/32 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  sudo iptables -I OUTPUT -m owner --uid-owner "$SANDBOX_USER" -d "$net" -j REJECT
done
for net in fc00::/7 fe80::/10; do
  sudo ip6tables -I OUTPUT -m owner --uid-owner "$SANDBOX_USER" -d "$net" -j REJECT || true
done

{
  echo "G2A_SANDBOX_USER=$SANDBOX_USER"
  echo "G2A_WORK_ROOT=$WORK_ROOT"
} >> "${GITHUB_ENV:-/dev/null}"
echo "Sandbox user $SANDBOX_USER ready; work root $WORK_ROOT"
