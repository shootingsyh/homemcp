#!/usr/bin/env bash
# HomeMCP tunnel server — bare-metal installer (no Docker).
#
# Installs frps (official fatedier/frp release binary) and, unless
# PHASE1=1, tunneld (built from this repo's server/tunneld with Go),
# each under its own systemd unit.
#
# Run as root from the server/ directory of a repo checkout:
#   cp .env.example .env && chmod 600 .env   # FRP_TOKEN, TUNNELD_ADMIN_KEY, Stripe…
#   sudo ./deploy/install.sh
#
# Or standalone for the phase-1 frps-only relay (no checkout needed):
#   curl -fsSL <raw install.sh> | sudo FRP_TOKEN=<hex> PHASE1=1 bash
#
# Options (env):
#   PHASE1=1        frps only, WITHOUT the tunneld plugin block
#                   (owner single-tenant; see README "Phase 1").
#   FRP_VERSION     frp release to install (default v0.68.0).
#   TUNNELD_BIN     path to a prebuilt tunneld binary (skips Go build).
#   SKIP_FIREWALL=1 do not touch iptables.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# The working directory the operator invoked us from: .env and the
# tunneld/ source dir live there. Section [1] cds to /tmp for the
# frp tarball, so capture this first (an earlier version lost .env
# that way and silently installed tunneld unconfigured).
START_DIR="$PWD"
export DEBIAN_FRONTEND=noninteractive
FRP_VERSION="${FRP_VERSION:-v0.68.0}"
PHASE1="${PHASE1:-0}"

case "$(uname -m)" in
  aarch64|arm64) FRP_ARCH=linux_arm64 ;;
  x86_64|amd64)  FRP_ARCH=linux_amd64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

echo "== [1] frps ${FRP_VERSION} (${FRP_ARCH}) =="
cd /tmp
curl -fsSL -o frp.tar.gz "https://github.com/fatedier/frp/releases/download/${FRP_VERSION}/frp_${FRP_VERSION#v}_${FRP_ARCH}.tar.gz"
tar -xzf frp.tar.gz
FRP_DIR=$(ls -d frp_*_"${FRP_ARCH}" | head -1)
install -m 755 "$FRP_DIR/frps" /usr/local/bin/frps
install -m 755 "$FRP_DIR/frpc" /usr/local/bin/frpc
frps --version

echo "== [2] frps config + unit =="
mkdir -p /etc/frp
if [[ -f "$START_DIR/.env" ]]; then set -a; # shellcheck disable=SC1091
  source "$START_DIR/.env"; set +a; fi
: "${FRP_TOKEN:?Set FRP_TOKEN (env or .env): openssl rand -hex 32}"
{
  echo "# HomeMCP tunnel relay (multi-tenant, zero-knowledge)."
  echo "# TLS on 443 is NOT terminated here: frps routes by SNI and"
  echo "# passes the opaque TLS stream to the tenant's frpc."
  echo 'bindAddr = "0.0.0.0"'
  echo "bindPort = 7000"
  echo "vhostHTTPSPort = 443"
  echo 'auth.method = "token"'
  echo 'auth.token = "{{ .Envs.FRP_TOKEN }}"'
  echo "transport.tls.force = true"
  if [[ "$PHASE1" != "1" ]]; then
    echo ""
    echo "# tunneld control-plane plugin (bare metal: loopback)."
    echo "[[httpPlugins]]"
    echo 'name = "tunneld"'
    echo 'addr = "http://127.0.0.1:7200"'
    echo 'path = "/plugin/frp"'
    echo 'ops = ["Login", "NewProxy"]'
  fi
} > /etc/frp/frps.toml
printf 'FRP_TOKEN=%s\n' "$FRP_TOKEN" > /etc/frp/frps.env
chmod 600 /etc/frp/frps.env
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
if [[ -f "$SCRIPT_DIR/homemcp-frps.service" ]]; then
  install -m 644 "$SCRIPT_DIR/homemcp-frps.service" /etc/systemd/system/
else
  cat > /etc/systemd/system/homemcp-frps.service <<'UNIT'
[Unit]
Description=HomeMCP tunnel relay (frps, TLS passthrough data plane)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=/etc/frp/frps.env
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
fi

if [[ "$PHASE1" != "1" ]]; then
  echo "== [3] tunneld =="
  if [[ -n "${TUNNELD_BIN:-}" ]]; then
    install -m 755 "$TUNNELD_BIN" /usr/local/bin/tunneld
  elif [[ -d "$START_DIR/tunneld" ]]; then
    if ! command -v go >/dev/null 2>&1; then
      echo "Go not found — installing toolchain to /usr/local/go"
      GO_VER=1.23.4
      case "$(uname -m)" in aarch64|arm64) GO_ARCH=arm64 ;; *) GO_ARCH=amd64 ;; esac
      curl -fsSL "https://go.dev/dl/go${GO_VER}.linux-${GO_ARCH}.tar.gz" | tar -C /usr/local -xz
      export PATH="$PATH:/usr/local/go/bin"
    fi
    (cd "$START_DIR/tunneld" && go build -trimpath -o /usr/local/bin/tunneld .)
  else
    echo "No tunneld source (./tunneld) and no TUNNELD_BIN — cannot install tunneld." >&2
    echo "Run from a repo checkout, or pass TUNNELD_BIN=/path/to/tunneld." >&2
    exit 1
  fi
  id tunneld >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin tunneld
  mkdir -p /var/lib/tunneld /etc/tunneld
  chown tunneld:tunneld /var/lib/tunneld
  if [[ -f "$START_DIR/.env" ]]; then
    # systemd EnvironmentFile: plain KEY=VALUE lines only.
    grep -E '^[A-Z_]+=' "$START_DIR/.env" > /etc/tunneld/env || true
  fi
  [[ -f /etc/tunneld/env ]] || touch /etc/tunneld/env
  grep -q '^TUNNELD_STORE_PATH=' /etc/tunneld/env || echo 'TUNNELD_STORE_PATH=/var/lib/tunneld/tunneld.json' >> /etc/tunneld/env
  chmod 600 /etc/tunneld/env
  if [[ -f "$SCRIPT_DIR/homemcp-tunneld.service" ]]; then
    install -m 644 "$SCRIPT_DIR/homemcp-tunneld.service" /etc/systemd/system/
  else
    cat > /etc/systemd/system/homemcp-tunneld.service <<'UNIT'
[Unit]
Description=HomeMCP tunneld (control plane: frp plugin, registration API, Stripe webhooks)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=tunneld
Group=tunneld
EnvironmentFile=/etc/tunneld/env
ExecStart=/usr/local/bin/tunneld
WorkingDirectory=/var/lib/tunneld
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
  fi
fi

echo "== [4] firewall (OCI image iptables) =="
if [[ "${SKIP_FIREWALL:-0}" != "1" ]]; then
  for p in 7000 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save || true; fi
fi

echo "== [5] start services =="
systemctl daemon-reload
if [[ "$PHASE1" != "1" ]]; then
  # restart (not enable --now): on upgrades the service is already
  # running with the old binary/config and must pick up the new ones.
  systemctl enable homemcp-tunneld
  systemctl restart homemcp-tunneld
  sleep 2
  TUNNELD_LISTEN=127.0.0.1:7200 /usr/local/bin/tunneld healthcheck || { journalctl -u homemcp-tunneld --no-pager -n 30; exit 1; }
fi
systemctl enable homemcp-frps
systemctl restart homemcp-frps
sleep 2
systemctl is-active homemcp-frps
ss -lntp | grep -E ':(7000|443)\b'
echo "INSTALL_DONE"
