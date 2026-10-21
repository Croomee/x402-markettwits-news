#!/usr/bin/env bash
# One-command install of the headless-browser WB/Ozon parser (parser/) on a Debian/Ubuntu VPS (run as root).
#
#   PROXY_URL='socks5h://USER:PASS@v2.proxyempire.io:5000' \
#     bash <(curl -fsSL https://raw.githubusercontent.com/Croomee/x402-markettwits-news/main/scripts/beget-parser-setup.sh)
#
# Options: [PORT] (default 8090)  --reset-token  --no-swap  --no-firewall  --debug (set -x; secrets kept out)
# Re-running is safe: updates the code, keeps /etc/x402-parser.env (token + proxy) and restarts the service.
# Every step is logged to /var/log/x402-parser-setup.log; on failure the failing step and the log tail are shown.
# Downloads have fallbacks for networks where a CDN is blocked/slow:
#   Node 20: existing node>=20 -> official tarball into /usr/local (nodejs.org, then npmmirror.com; never touches an
#            apt nodejs, e.g. Ubuntu 24.04's v18) -> NodeSource apt (removes the distro nodejs/libnode first)
#   npm:     registry.npmjs.org -> registry.npmmirror.com
#   Chromium: Playwright CDN -> npmmirror.com/mirrors/playwright -> Debian's apt "chromium" package
set -Eeuo pipefail

PORT=8090; RESET=0; SWAP=1; FW=1; DEBUG=0
REPO=${REPO:-https://github.com/Croomee/x402-markettwits-news.git}
APP=${APP:-/opt/x402-markettwits-news}; ENVF=${ENVF:-/etc/x402-parser.env}; STATE=${STATE:-/var/lib/x402-parser}
BROWSERS=${BROWSERS:-/opt/x402-parser-browsers}; NODE_PREFIX=${NODE_PREFIX:-/usr/local}
LOG=${LOG:-/var/log/x402-parser-setup.log}
SVC=x402-parser; RUNUSER=x402parser; UNIT_DIR=${UNIT_DIR:-/etc/systemd/system}
NODESOURCE_URL=${NODESOURCE_URL:-https://deb.nodesource.com/setup_20.x}
NODE_MIRRORS=${NODE_MIRRORS:-"https://nodejs.org/dist https://npmmirror.com/mirrors/node"}
NPM_REGISTRIES=${NPM_REGISTRIES:-"https://registry.npmjs.org https://registry.npmmirror.com"}
PW_MIRROR=${PW_MIRROR:-https://npmmirror.com/mirrors/playwright}
export DEBIAN_FRONTEND=noninteractive
export PATH="$NODE_PREFIX/bin:$PATH"   # a tarball node in /usr/local wins over an old apt /usr/bin/node

# ---------- helpers ----------
log()  { echo "==> $*"; echo "==> $*" >>"$LOG" 2>/dev/null || true; }
warn() { echo "!!  $*" >&2; echo "!!  $*" >>"$LOG" 2>/dev/null || true; }
die()  { warn "$*"; echo "    full log: $LOG" >&2; exit 1; }
# run DESC CMD...: run quietly, output appended to $LOG; on failure show the step, exit code and the log tail.
run() {
  local desc=$1; shift; local rc=0
  echo "--- $(date -u +%FT%TZ) $desc" >>"$LOG"
  "$@" >>"$LOG" 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    echo "!!  step failed: $desc (exit $rc); last output:" >&2; tail -n 25 "$LOG" | sed 's/^/    | /' >&2
    echo "!!  step failed: $desc (exit $rc)" >>"$LOG"
  fi
  return "$rc"
}
on_err() { local rc=$1 line=$2 cmd=$3; trap - ERR
  echo >&2; echo "!!  FAILED at line $line (exit $rc): $cmd" >&2
  [ -f "$LOG" ] && { echo "    last log lines ($LOG):" >&2; tail -n 30 "$LOG" | sed 's/^/    | /' >&2; }
  exit "$rc"; }
node_major() { command -v node >/dev/null 2>&1 || { echo 0; return; }; node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/;t;s/.*/0/'; }
apt_get() { apt-get -o DPkg::Lock::Timeout=300 -o Acquire::Retries=3 -o Acquire::http::Timeout=30 "$@" </dev/null; }

node_arch() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; aarch64|arm64) echo arm64 ;; armv7l) echo armv7l ;; ppc64le) echo ppc64le ;; s390x) echo s390x ;; *) return 1 ;; esac; }

install_node_nodesource() {
  local tmp; tmp=$(mktemp)
  # Ubuntu's nodejs (18.x) + libnode* + npm conflict with NodeSource's nodejs package: remove them first.
  if dpkg -s nodejs >/dev/null 2>&1 && ! dpkg -s nodejs 2>/dev/null | grep -qi nodesource; then
    apt_get remove -y nodejs npm 'libnode*' || true
  fi
  curl -fsSL --connect-timeout 15 --max-time 90 "$NODESOURCE_URL" -o "$tmp" || { rm -f "$tmp"; return 1; }
  bash "$tmp" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  apt_get install -y nodejs
}
# Remove a NodeSource apt source that cannot be reached, otherwise every later `apt-get update` fails.
drop_nodesource_repo() { rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true; }

install_node_tarball() {   # official linux binary (sha256-verified) into $NODE_PREFIX/lib/nodejs, symlinks in $NODE_PREFIX/bin
  local arch base sums file ver tmp
  arch=$(node_arch) || { echo "unsupported CPU arch $(uname -m)"; return 1; }
  command -v xz >/dev/null 2>&1 || echo "note: xz missing, using .tar.gz"
  for base in $NODE_MIRRORS; do
    echo "trying $base"
    sums=$(curl -fsSL --connect-timeout 15 --max-time 60 "$base/latest-v20.x/SHASUMS256.txt") || { echo "  unreachable: $base"; continue; }
    if command -v xz >/dev/null 2>&1; then file=$(echo "$sums" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2; exit}')
    else file=$(echo "$sums" | awk -v a="linux-$arch.tar.gz" '$2 ~ a"$" {print $2; exit}'); fi
    [ -n "$file" ] || { echo "  no $arch build listed at $base"; continue; }
    ver=${file#node-}; ver=${ver%%-linux*}
    tmp=$(mktemp -d)
    if ! curl -fsSL --connect-timeout 15 --max-time 600 "$base/latest-v20.x/$file" -o "$tmp/$file"; then echo "  download failed: $base/$file"; rm -rf "$tmp"; continue; fi
    if ! (cd "$tmp" && echo "$sums" | grep -E "  $file\$" | sha256sum -c - >/dev/null); then echo "  sha256 mismatch for $file"; rm -rf "$tmp"; continue; fi
    mkdir -p "$NODE_PREFIX/lib/nodejs" "$NODE_PREFIX/bin"
    rm -rf "$NODE_PREFIX/lib/nodejs/node-$ver-linux-$arch"
    tar -xf "$tmp/$file" -C "$NODE_PREFIX/lib/nodejs"
    rm -rf "$tmp"
    for b in node npm npx corepack; do
      [ -e "$NODE_PREFIX/lib/nodejs/node-$ver-linux-$arch/bin/$b" ] && ln -sfn "$NODE_PREFIX/lib/nodejs/node-$ver-linux-$arch/bin/$b" "$NODE_PREFIX/bin/$b"
    done
    echo "installed node $ver from $base"
    return 0
  done
  return 1
}

npm_ci() {   # npm ci with registry fallback (lockfile URLs are rewritten to the chosen registry by npm)
  local reg
  for reg in $NPM_REGISTRIES; do
    log "npm ci (registry $reg)"
    if run "npm ci via $reg" npm ci --omit=dev --no-audit --no-fund --registry="$reg" --fetch-timeout=60000 --fetch-retries=2; then return 0; fi
    warn "npm ci via $reg failed, trying next registry"
  done
  return 1
}

install_chromium() {   # sets CHROMIUM_EXECUTABLE when falling back to the distro package
  local pw=./node_modules/.bin/playwright
  log "Chromium system libraries (playwright install-deps chromium)"
  run "playwright install-deps chromium" env PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" "$pw" install-deps chromium || warn "install-deps failed; continuing (the distro fallback pulls its own deps)"
  log "Chromium download (Playwright CDN)"
  if run "playwright install chromium (CDN)" timeout 900 env PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" "$pw" install chromium; then return 0; fi
  log "Chromium download (mirror $PW_MIRROR)"
  if run "playwright install chromium (mirror)" timeout 900 env PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" PLAYWRIGHT_DOWNLOAD_HOST="$PW_MIRROR" "$pw" install chromium; then return 0; fi
  log "falling back to the distro chromium package"
  if run "apt-get install chromium" apt_get install -y chromium || run "apt-get install chromium-browser" apt_get install -y chromium-browser; then
    CHROMIUM_EXECUTABLE=$(command -v chromium || command -v chromium-browser || true)
    if [ -n "$CHROMIUM_EXECUTABLE" ] && ! readlink -f "$CHROMIUM_EXECUTABLE" | grep -q snap; then return 0; fi
    warn "distro chromium is a snap wrapper (Ubuntu) and will not work under systemd"
  fi
  return 1
}

getv() { grep -E "^$1=" "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- || true; }
setv() { local k=$1 v=$2; { grep -vE "^$k=" "$ENVF" 2>/dev/null || true; } > "$ENVF.tmp"; printf '%s=%s\n' "$k" "$v" >> "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; chmod 600 "$ENVF"; }

# Allow `X402_SETUP_LIB=1 source scripts/beget-parser-setup.sh` to load only the functions (tests).
[ "${X402_SETUP_LIB:-0}" = 1 ] && return 0 2>/dev/null

for a in "$@"; do case "$a" in
  --reset-token) RESET=1 ;; --no-swap) SWAP=0 ;; --no-firewall) FW=0 ;; --debug) DEBUG=1 ;;
  [0-9]*) PORT="$a" ;; -h|--help) sed -n '2,16p' "$0"; exit 0 ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
mkdir -p "$(dirname "$LOG")"; : >>"$LOG"; chmod 600 "$LOG"
echo "=== $(date -u +%FT%TZ) setup start (port $PORT)" >>"$LOG"
trap 'on_err $? $LINENO "$BASH_COMMAND"' ERR
if [ "$DEBUG" = 1 ]; then export PS4='+ ${LINENO}: '; set -x; fi

# ---------- OS ----------
[ -r /etc/os-release ] || die "cannot read /etc/os-release; only Debian/Ubuntu are supported"
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) ;; *) die "unsupported OS '${PRETTY_NAME:-unknown}': this script needs Debian or Ubuntu (apt)";; esac
command -v apt-get >/dev/null || die "apt-get not found"
log "OS: ${PRETTY_NAME:-$ID} ($(uname -m)), RAM $(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo) MB, free disk $(df -Pm / | awk 'NR==2{print $4}') MB"
[ "$(df -Pm / | awk 'NR==2{print $4}')" -ge 1500 ] || warn "less than 1.5 GB free on / (Chromium + node_modules need ~1 GB)"

# ---------- memory: Chromium with a warm WB tab uses ~500-800 MB; add swap on small VPSes ----------
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [ "$SWAP" = 1 ] && [ "$MEM_MB" -lt 2000 ] && [ "$(awk 'NR>1' /proc/swaps | wc -l)" = 0 ]; then
  log "RAM ${MEM_MB} MB and no swap: creating 2G /swapfile"
  if { fallocate -l 2G /swapfile 2>>"$LOG" || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none 2>>"$LOG"; } \
     && chmod 600 /swapfile && mkswap /swapfile >>"$LOG" 2>&1 && swapon /swapfile 2>>"$LOG"; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else warn "could not enable swap (container/OpenVZ?); continuing without it"; rm -f /swapfile; fi
fi

# ---------- base packages ----------
log "installing base packages"
if ! run "apt-get update" apt_get update; then
  drop_nodesource_repo   # a stale/blocked NodeSource repo from an earlier run breaks apt-get update
  run "apt-get update (retry without nodesource repo)" apt_get update || die "apt-get update failed (see log above)"
fi
run "apt-get install base packages" apt_get install -y ca-certificates curl git openssl xz-utils tar coreutils procps || die "could not install base packages"

# ---------- Node 20 ----------
NODE_BIN=""
if [ "$(node_major)" -ge 20 ]; then log "node $(node -v) already installed at $(command -v node)"
else
  [ "$(node_major)" -gt 0 ] && log "found old node $(node -v) at $(command -v node); installing Node 20 alongside it in $NODE_PREFIX (the old one is left untouched)"
  log "installing Node.js 20 from the official binary tarball"
  if run "node tarball" install_node_tarball && [ -x "$NODE_PREFIX/bin/node" ] && [ "$("$NODE_PREFIX/bin/node" -v | sed -E 's/^v([0-9]+).*/\1/')" -ge 20 ]; then
    NODE_BIN="$NODE_PREFIX/bin/node"
  else
    warn "tarball install failed; trying NodeSource (apt)"
    log "installing Node.js 20 (NodeSource)"
    if ! run "NodeSource setup_20.x + apt-get install nodejs" install_node_nodesource; then
      drop_nodesource_repo; run "apt-get update" apt_get update || true
      die "could not install Node.js 20 (tarball mirrors: $NODE_MIRRORS; NodeSource: $NODESOURCE_URL)"
    fi
  fi
  hash -r
fi
[ "$(node_major)" -ge 20 ] || die "node >= 20 not first in PATH after install (found: $(command -v node || echo none) $(node -v 2>/dev/null))"
[ -n "$NODE_BIN" ] || NODE_BIN=$(command -v node)
log "node $("$NODE_BIN" -v) at $NODE_BIN, npm $(npm -v)"

# ---------- code ----------
if [ -d "$APP/.git" ]; then log "updating $APP"; run "git update" bash -c "git -C '$APP' fetch -q --depth 1 origin main && git -C '$APP' reset -q --hard origin/main" || die "git update failed"
else log "cloning into $APP"; run "git clone" git clone -q --depth 1 "$REPO" "$APP" || die "git clone of $REPO failed"; fi
id "$RUNUSER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$RUNUSER"
mkdir -p "$STATE" "$BROWSERS"; chown -R "$RUNUSER:$RUNUSER" "$STATE"
cd "$APP/parser"
npm_ci || die "npm ci failed with every registry ($NPM_REGISTRIES)"
CHROMIUM_EXECUTABLE=""
install_chromium || die "could not install Chromium (CDN, mirror and distro package all failed)"
chmod -R a+rX "$BROWSERS"

# ---------- env file: PROXY_URL + PARSER_TOKEN (0600 root; secrets never echoed or traced) ----------
{ set +x; } 2>/dev/null
touch "$ENVF"; chmod 600 "$ENVF"
if [ -n "${PROXY_URL:-}" ]; then setv PROXY_URL "$PROXY_URL"; log "PROXY_URL stored in $ENVF"
elif [ -z "$(getv PROXY_URL)" ]; then
  if [ -r /dev/tty ]; then read -rsp "PROXY_URL (socks5h://USER:PASS@host:port, empty = direct): " P </dev/tty; echo; [ -n "$P" ] && setv PROXY_URL "$P"
  else warn "no PROXY_URL; the parser will go direct (WB/Ozon block datacenter IPs)"; fi
fi
TOKEN=$(getv PARSER_TOKEN)
if [ -z "$TOKEN" ] || [ "$RESET" = 1 ]; then TOKEN=$(openssl rand -hex 24); setv PARSER_TOKEN "$TOKEN"; log "generated new PARSER_TOKEN"; fi
[ "$DEBUG" = 1 ] && set -x
setv PORT "$PORT"; setv HOST 0.0.0.0; setv STATE_DIR "$STATE"; setv PLAYWRIGHT_BROWSERS_PATH "$BROWSERS"
if [ -n "$CHROMIUM_EXECUTABLE" ]; then setv CHROMIUM_EXECUTABLE "$CHROMIUM_EXECUTABLE"; else setv CHROMIUM_EXECUTABLE ""; fi
# <1.5 GB RAM: one page at a time, and Chromium low-memory flags (parser/browser.mjs reads LOW_MEMORY).
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 1500 ]; then
  [ -n "$(getv CONCURRENCY)" ] || setv CONCURRENCY 1
  [ -n "$(getv LOW_MEMORY)" ] || setv LOW_MEMORY 1
fi
[ -n "$(getv CONCURRENCY)" ] || setv CONCURRENCY 2
[ -n "$(getv PARSE_TIMEOUT_MS)" ] || setv PARSE_TIMEOUT_MS 25000
[ -n "$(getv CACHE_TTL_S)" ] || setv CACHE_TTL_S 600

# ---------- systemd ----------
command -v systemctl >/dev/null || die "systemd not found (needed for the service)"
cat > "$UNIT_DIR/$SVC.service" <<UNIT
[Unit]
Description=x402 WB/Ozon headless-browser parser
After=network-online.target
Wants=network-online.target

[Service]
User=$RUNUSER
EnvironmentFile=$ENVF
WorkingDirectory=$APP/parser
Environment=PATH=$NODE_PREFIX/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN server.mjs
Restart=always
RestartSec=3
# Daily restart keeps Chromium memory in check.
RuntimeMaxSec=86400
MemoryMax=1200M
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$STATE

[Install]
WantedBy=multi-user.target
UNIT
run "systemctl daemon-reload/enable/restart" bash -c "systemctl daemon-reload && systemctl enable -q $SVC && systemctl restart $SVC" || die "systemd start failed"

# ---------- firewall ----------
if [ "$FW" = 1 ]; then
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$PORT/tcp" >>"$LOG" 2>&1 && log "ufw: opened $PORT/tcp"
  elif command -v iptables >/dev/null && ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT 2>>"$LOG" && log "iptables: opened $PORT/tcp (not persisted; install iptables-persistent to keep it)" || warn "iptables rule failed"
  fi
fi

# ---------- smoke test ----------
ok=0; for _ in $(seq 1 30); do curl -fs -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
if [ "$ok" = 1 ]; then log "health: $(curl -s -m 5 "http://127.0.0.1:$PORT/health")"
else warn "service not answering on :$PORT"; journalctl -u "$SVC" -n 40 --no-pager >&2 || true; die "parser did not start"; fi
log "test parse (WB, cold start incl. anti-bot challenge, up to ~25s):"
curl -s -m 60 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/parse?url=https%3A%2F%2Fwww.wildberries.ru%2Fcatalog%2F839226871%2Fdetail.aspx" | cut -c1-400; echo

IP=$(curl -fs -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
trap - ERR
echo
echo "Set these on Render (Environment):"
echo "PARSER_URL=http://${IP:-159.194.215.201}:$PORT"
echo "PARSER_TOKEN=$TOKEN"
echo
echo "Logs: journalctl -u $SVC -f    Setup log: $LOG    Config: $ENVF    Re-run this script to update."
