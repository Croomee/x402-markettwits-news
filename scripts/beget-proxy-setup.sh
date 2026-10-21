#!/usr/bin/env bash
# Authenticated HTTPS-only forward proxy (squid) for x402-markettwits-news /product/info.
# Ubuntu/Debian, run as root:
#   curl -fsSL https://raw.githubusercontent.com/Croomee/x402-markettwits-news/main/scripts/beget-proxy-setup.sh | bash
#   ... | bash -s -- 3128 --reset      # custom port and/or new credentials
# - Basic auth only (random user/password generated here), CONNECT to port 443 only, private/loopback targets denied.
# - Idempotent: re-running keeps the saved credentials (/etc/squid/x402-proxy.env) unless --reset is given.
# - systemd-enabled (survives reboots); opens the port in ufw / firewalld / iptables when they are active.
# - Last lines: PROXY_URL=http://USER:PASS@IP:PORT and a curl test command.
set -euo pipefail

FALLBACK_IP="159.194.215.201"
STATE=/etc/squid/x402-proxy.env
PASSWD=/etc/squid/x402-passwd
CONF=/etc/squid/squid.conf
PORT=""
RESET=0

for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -h|--help) sed -n '2,10p' "$0" 2>/dev/null || true; exit 0 ;;
    *[!0-9]*|"") echo "Unknown argument: $arg (usage: [PORT] [--reset])" >&2; exit 2 ;;
    *) PORT="$arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This script supports Debian/Ubuntu (apt-get) only." >&2; exit 1; }

log() { echo "[proxy-setup] $*" >&2; }
rand_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

# ---- packages ----
if ! command -v squid >/dev/null || ! command -v htpasswd >/dev/null || ! command -v curl >/dev/null; then
  log "installing squid, apache2-utils, curl ..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq </dev/null
  apt-get install -y -qq squid apache2-utils curl </dev/null >/dev/null
fi
install -d -m 755 /etc/squid

# ---- credentials (kept across runs unless --reset) ----
PROXY_USER=""; PROXY_PASS=""; SAVED_PORT=""
if [ -f "$STATE" ] && [ "$RESET" -eq 0 ]; then
  # shellcheck disable=SC1090
  . "$STATE"
  SAVED_PORT="${PROXY_PORT:-}"
fi
PORT="${PORT:-${SAVED_PORT:-3128}}"
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo "Invalid port: $PORT" >&2; exit 2; fi
if [ -z "$PROXY_USER" ] || [ -z "$PROXY_PASS" ]; then
  PROXY_USER="x402$(rand_hex 4)"
  PROXY_PASS="$(rand_hex 16)"
  log "generated new credentials"
else
  log "reusing saved credentials (use --reset to regenerate)"
fi
umask 077
printf 'PROXY_USER=%s\nPROXY_PASS=%s\nPROXY_PORT=%s\n' "$PROXY_USER" "$PROXY_PASS" "$PORT" > "$STATE"
chmod 600 "$STATE"
htpasswd -b -c -m "$PASSWD" "$PROXY_USER" "$PROXY_PASS" >/dev/null 2>&1
SQUID_GROUP="proxy"; getent group proxy >/dev/null || SQUID_GROUP="squid"
chown "root:$SQUID_GROUP" "$PASSWD" 2>/dev/null || true
chmod 640 "$PASSWD"

# ---- squid config ----
AUTH_HELPER=""
for p in /usr/lib/squid/basic_ncsa_auth /usr/lib/squid3/basic_ncsa_auth /usr/lib64/squid/basic_ncsa_auth; do
  [ -x "$p" ] && { AUTH_HELPER="$p"; break; }
done
[ -n "$AUTH_HELPER" ] || { echo "basic_ncsa_auth helper not found" >&2; exit 1; }
[ -f "$CONF.orig-x402" ] || { [ -f "$CONF" ] && cp -p "$CONF" "$CONF.orig-x402"; } || true
umask 022
cat > "$CONF" <<SQUID
# Managed by beget-proxy-setup.sh (x402-markettwits-news). Original config: $CONF.orig-x402
http_port $PORT
visible_hostname x402-proxy

auth_param basic program $AUTH_HELPER $PASSWD
auth_param basic realm proxy
auth_param basic children 5
auth_param basic credentialsttl 2 hours

acl authenticated proxy_auth REQUIRED
acl SSL_ports port 443
acl CONNECT method CONNECT
acl to_private dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ::1 fc00::/7 fe80::/10

http_access deny to_private
http_access deny !CONNECT
http_access deny CONNECT !SSL_ports
http_access allow authenticated
http_access deny all

forwarded_for delete
via off
cache deny all
cache_mem 16 MB
access_log daemon:/var/log/squid/access.log squid
SQUID
squid -k parse -f "$CONF" >/dev/null 2>&1 || { squid -k parse -f "$CONF"; echo "squid config check failed" >&2; exit 1; }

# ---- service ----
systemctl enable squid >/dev/null 2>&1 || true
systemctl restart squid
sleep 2
systemctl is-active --quiet squid || { journalctl -u squid -n 30 --no-pager >&2 || true; echo "squid failed to start" >&2; exit 1; }

# ---- firewall ----
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null && log "ufw: allowed $PORT/tcp"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --quiet --permanent --add-port="$PORT/tcp" && firewall-cmd --quiet --reload && log "firewalld: allowed $PORT/tcp"
elif command -v iptables >/dev/null && iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)|-j (DROP|REJECT)'; then
  iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
  log "iptables: allowed $PORT/tcp"
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi
else
  log "no active host firewall detected (check the Beget panel firewall if the port is unreachable)"
fi

# ---- public IP + result ----
IP=""
for u in https://api.ipify.org https://ifconfig.me/ip https://ipv4.icanhazip.com; do
  IP="$(curl -4 -fsS --max-time 5 "$u" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
  IP=""
done
IP="${IP:-$FALLBACK_IP}"
PROXY_URL="http://${PROXY_USER}:${PROXY_PASS}@${IP}:${PORT}"

echo
echo "Squid proxy is running on port $PORT (auth required, CONNECT to :443 only). Credentials saved in $STATE."
echo "Set this on the API server (Render env / .env):"
echo
echo "PROXY_URL=${PROXY_URL}"
echo
echo "Test (should print an HTTP status line):"
echo "curl -x \"${PROXY_URL}\" -sI https://www.wildberries.ru | head -1"
