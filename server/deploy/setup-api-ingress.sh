#!/usr/bin/env bash
# HomeMCP API ingress setup (run as root ON the relay host, AFTER
# deploy/install.sh has installed frps + tunneld).
#
# Why this exists: frps owns the host's public 443 for SNI
# passthrough of tenant domains, so the operator API hostname
# (api.homemcp.si) cannot have its own 443 listener. Instead the API
# is routed THROUGH frps like a tenant — by a dedicated operator frpc
# account ("api-ingress", a reserved username the tunneld plugin
# confines to exactly the API hostname) — down to a local Caddy that
# terminates TLS for the API host only and reverse-proxies just
# /api/* and /webhooks/* to tunneld on 127.0.0.1:7200. Tenant
# passthrough is untouched; the plugin endpoint is NOT exposed
# (Caddy 404s everything outside the allowlist).
#
# What it does (idempotent):
#   1. seeds the api-ingress user into tunneld's store (generating
#      its per-user token once into /etc/frp/api-ingress.token, 600);
#   2. installs Caddy (pinned release) + /etc/caddy/Caddyfile + the
#      homemcp-caddy unit; uses CERT_FILE/KEY_FILE if given, else a
#      1-day self-signed placeholder (swap in the real Let's Encrypt
#      cert and `systemctl reload homemcp-caddy` afterwards);
#   3. writes /etc/frp/frpc-api.toml + the homemcp-frpc-api unit and
#      starts both services.
#
# Env knobs: CADDY_VERSION (default v2.8.4), CADDY_PORT (default
# 8444), CERT_FILE, KEY_FILE.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
CADDY_VERSION="${CADDY_VERSION:-v2.8.4}"
CADDY_PORT="${CADDY_PORT:-8444}"
STORE_PATH="${TUNNELD_STORE_PATH:-/var/lib/tunneld/tunneld.json}"
API_BASE="$(grep '^API_PUBLIC_BASE=' /etc/tunneld/env | cut -d= -f2)"
API_HOST="$(python3 -c "from urllib.parse import urlparse; print(urlparse('$API_BASE').hostname)")"
[[ -n "$API_HOST" ]] || { echo "could not derive API host from API_PUBLIC_BASE=$API_BASE" >&2; exit 1; }
FRP_TOKEN="$(grep '^FRP_TOKEN=' /etc/frp/frps.env | cut -d= -f2)"
[[ -n "$FRP_TOKEN" ]] || { echo "FRP_TOKEN not found in /etc/frp/frps.env" >&2; exit 1; }

echo "== [1] seed api-ingress user (API host: $API_HOST) =="
if grep -q '"api-ingress"' "$STORE_PATH" 2>/dev/null; then
  echo "api-ingress already seeded; keeping existing token"
else
  INGTOK="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  echo -n "$INGTOK" > /etc/frp/api-ingress.token
  chmod 600 /etc/frp/api-ingress.token
  systemctl stop homemcp-tunneld
  python3 - "$STORE_PATH" "$INGTOK" "$API_HOST" <<'PY'
import json, hashlib, sys, datetime
path, tok, host = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
d.setdefault("users", {})["api-ingress"] = {
    "username": "api-ingress",
    "token_hash": hashlib.sha256(tok.encode()).hexdigest(),
    "subdomain": host,
    "plan": "annual",
    "sub_status": "active",
    "created_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
json.dump(d, open(path, "w"), indent=2)
print("seeded api-ingress")
PY
  systemctl start homemcp-tunneld
fi
INGTOK="$(cat /etc/frp/api-ingress.token)"

echo "== [2] caddy =="
if [[ ! -x /usr/local/bin/caddy ]]; then
  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
  curl -fsSL -o /tmp/caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/${CADDY_VERSION}/caddy_${CADDY_VERSION#v}_linux_${ARCH}.tar.gz"
  tar -C /tmp -xzf /tmp/caddy.tar.gz caddy
  install -m 755 /tmp/caddy /usr/local/bin/caddy
fi
mkdir -p /etc/caddy
if [[ -n "${CERT_FILE:-}" && -n "${KEY_FILE:-}" ]]; then
  install -m 644 "$CERT_FILE" /etc/caddy/api.crt
  install -m 600 "$KEY_FILE" /etc/caddy/api.key
elif [[ ! -f /etc/caddy/api.crt ]]; then
  openssl req -x509 -newkey rsa:2048 -keyout /etc/caddy/api.key -out /etc/caddy/api.crt \
    -days 1 -nodes -subj "/CN=$API_HOST" -addext "subjectAltName=DNS:$API_HOST" >/dev/null 2>&1
  echo "NOTE: installed a 1-day self-signed placeholder cert for $API_HOST;"
  echo "      replace /etc/caddy/api.crt|key with the real cert, then: systemctl reload homemcp-caddy"
fi
cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
	auto_https off
}
$API_HOST:$CADDY_PORT {
	bind 127.0.0.1
	tls /etc/caddy/api.crt /etc/caddy/api.key
	@api path /api/* /webhooks/*
	handle @api {
		reverse_proxy 127.0.0.1:7200
	}
	handle {
		respond "not found" 404
	}
}
EOF
cat > /etc/systemd/system/homemcp-caddy.service <<'UNIT'
[Unit]
Description=HomeMCP API TLS terminator (API host -> tunneld)
After=network.target homemcp-tunneld.service
[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT

echo "== [3] operator frpc =="
cat > /etc/frp/frpc-api.toml <<EOF
serverAddr = "127.0.0.1"
serverPort = 7000
user = "api-ingress"
auth.method = "token"
auth.token = "$FRP_TOKEN"
metadatas.token = "$INGTOK"
transport.tls.enable = true
[[proxies]]
name = "api"
type = "https"
customDomains = ["$API_HOST"]
localIP = "127.0.0.1"
localPort = $CADDY_PORT
EOF
chmod 600 /etc/frp/frpc-api.toml
cat > /etc/systemd/system/homemcp-frpc-api.service <<'UNIT'
[Unit]
Description=HomeMCP API ingress frpc (API host via frps)
After=network.target homemcp-frps.service homemcp-tunneld.service homemcp-caddy.service
[Service]
ExecStart=/usr/local/bin/frpc -c /etc/frp/frpc-api.toml
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable homemcp-caddy homemcp-frpc-api
systemctl restart homemcp-caddy homemcp-frpc-api
sleep 3
systemctl is-active homemcp-caddy homemcp-frpc-api
echo "API_INGRESS_DONE — verify: curl https://$API_HOST/api/v1/account (expect tunneld's 401 JSON)"
