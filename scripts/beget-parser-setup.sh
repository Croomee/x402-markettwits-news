#!/usr/bin/env bash
# One-command install of the headless-browser WB/Ozon parser (parser/) on a Debian/Ubuntu VPS (run as root).
#
#   PROXY_URL='socks5h://USER:PASS@v2.proxyempire.io:5000' \
#     bash <(curl -fsSL https://raw.githubusercontent.com/Croomee/x402-markettwits-news/main/scripts/beget-parser-setup.sh)
#
# Options: [PORT] (default 8090)  --reset-token  --no-swap  --no-firewall
# Re-running is safe: it updates the code, keeps /etc/x402-parser.env (token + proxy) and restarts the service.
# PROXY_URL: socks5/socks5h (bridged locally, Chromium can't do SOCKS auth) or http(s)://USER:PASS@host:port.
# If PROXY_URL is not given and none is stored yet, you are prompted for it (input hidden).
set -euo pipefail
PORT=8090; RESET=0; SWAP=1; FW=1
for a in "$@"; do case "$a" in
  --reset-token) RESET=1 ;; --no-swap) SWAP=0 ;; --no-firewall) FW=0 ;;
  [0-9]*) PORT="$a" ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
REPO=https://github.com/Croomee/x402-markettwits-news.git
APP=/opt/x402-markettwits-news; ENVF=/etc/x402-parser.env; STATE=/var/lib/x402-parser; BROWSERS=/opt/x402-parser-browsers
SVC=x402-parser; RUNUSER=x402parser
export DEBIAN_FRONTEND=noninteractive
log() { echo "==> $*"; }

# --- memory: Chromium with a warm WB tab uses ~500-800 MB; add swap on small VPSes ---
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$SWAP" = 1 ] && [ "$MEM_MB" -lt 2000 ] && [ "$(awk 'NR>1' /proc/swaps | wc -l)" = 0 ]; then
  log "RAM ${MEM_MB} MB and no swap: creating 2G /swapfile"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- packages + Node 20 ---
log "installing base packages"
apt-get update -qq </dev/null
apt-get install -y -qq ca-certificates curl git openssl </dev/null >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  log "installing Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - </dev/null >/dev/null
  apt-get install -y -qq nodejs </dev/null >/dev/null
fi
log "node $(node -v)"

# --- code ---
if [ -d "$APP/.git" ]; then log "updating $APP"; git -C "$APP" fetch -q --depth 1 origin main && git -C "$APP" reset -q --hard origin/main
else log "cloning into $APP"; git clone -q --depth 1 "$REPO" "$APP"; fi
id "$RUNUSER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$RUNUSER"
mkdir -p "$STATE" "$BROWSERS"; chown -R "$RUNUSER:$RUNUSER" "$STATE"
cd "$APP/parser"
log "npm ci (playwright, socks)"
npm ci --omit=dev --no-audit --no-fund --loglevel=error </dev/null
log "installing Chromium + system deps (playwright install --with-deps chromium; takes a few minutes)"
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" npx --yes playwright install --with-deps chromium </dev/null >/dev/null
chmod -R a+rX "$BROWSERS"

# --- env file: PROXY_URL + PARSER_TOKEN (0600 root; never printed except the token at the end) ---
touch "$ENVF"; chmod 600 "$ENVF"
getv() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- || true; }
setv() { local k=$1 v=$2; grep -vE "^$k=" "$ENVF" > "$ENVF.tmp" || true; printf '%s=%s\n' "$k" "$v" >> "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"; }
if [ -n "${PROXY_URL:-}" ]; then setv PROXY_URL "$PROXY_URL"
elif [ -z "$(getv PROXY_URL)" ]; then
  if [ -r /dev/tty ]; then read -rsp "PROXY_URL (socks5h://USER:PASS@host:port, empty = direct): " P </dev/tty; echo; [ -n "$P" ] && setv PROXY_URL "$P"
  else echo "WARNING: no PROXY_URL; the parser will go direct (WB/Ozon block datacenter IPs)" >&2; fi
fi
TOKEN=$(getv PARSER_TOKEN)
if [ -z "$TOKEN" ] || [ "$RESET" = 1 ]; then TOKEN=$(openssl rand -hex 24); setv PARSER_TOKEN "$TOKEN"; log "generated new PARSER_TOKEN"; fi
setv PORT "$PORT"; setv HOST 0.0.0.0; setv STATE_DIR "$STATE"; setv PLAYWRIGHT_BROWSERS_PATH "$BROWSERS"
[ -n "$(getv CONCURRENCY)" ] || setv CONCURRENCY 2
[ -n "$(getv PARSE_TIMEOUT_MS)" ] || setv PARSE_TIMEOUT_MS 25000
[ -n "$(getv CACHE_TTL_S)" ] || setv CACHE_TTL_S 600

# --- systemd ---
cat > /etc/systemd/system/$SVC.service <<UNIT
[Unit]
Description=x402 WB/Ozon headless-browser parser
After=network-online.target
Wants=network-online.target

[Service]
User=$RUNUSER
EnvironmentFile=$ENVF
WorkingDirectory=$APP/parser
ExecStart=$(command -v node) server.mjs
Restart=always
RestartSec=3
# Daily restart keeps Chromium memory in check.
RuntimeMaxSec=86400
MemoryMax=1600M
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$STATE

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q $SVC
systemctl restart $SVC

# --- firewall ---
if [ "$FW" = 1 ]; then
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT/tcp" >/dev/null; log "ufw: opened $PORT/tcp"
  elif command -v iptables >/dev/null && ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT && log "iptables: opened $PORT/tcp (not persisted; install iptables-persistent to keep it)"
  fi
fi

# --- smoke test ---
for i in $(seq 1 30); do curl -fs -m 3 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 1; done
log "health: $(curl -s -m 5 "http://127.0.0.1:$PORT/health" || echo 'not answering, see: journalctl -u '$SVC' -n 50')"
log "test parse (WB, cold start incl. anti-bot challenge, up to ~25s):"
curl -s -m 60 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/parse?url=https%3A%2F%2Fwww.wildberries.ru%2Fcatalog%2F839226871%2Fdetail.aspx" | cut -c1-400; echo

IP=$(curl -fs -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "Set these on Render (Environment):"
echo "PARSER_URL=http://${IP:-159.194.215.201}:$PORT"
echo "PARSER_TOKEN=$TOKEN"
echo
echo "Logs: journalctl -u $SVC -f    Config: $ENVF    Re-run this script to update."
