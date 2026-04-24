#!/usr/bin/env bash
# Start a static file server + public HTTPS tunnel + print QR code.
#
# Usage:
#   ./tunnel.sh              # auto: prefers cloudflared, falls back to ngrok
#   ./tunnel.sh cloudflared  # force cloudflared (no interstitial, recommended for PWA install)
#   ./tunnel.sh ngrok        # force ngrok
#
# Requires: python3, qrencode, plus either cloudflared or ngrok.
#   brew install qrencode cloudflared ngrok
set -e

PORT="${PORT:-8000}"
cd "$(dirname "$0")"

TUNNEL="${1:-auto}"
if [[ "$TUNNEL" == "auto" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    TUNNEL="cloudflared"
  elif command -v ngrok >/dev/null 2>&1; then
    TUNNEL="ngrok"
  else
    echo "Neither cloudflared nor ngrok found. Install one:"
    echo "  brew install cloudflared   # recommended"
    echo "  brew install ngrok"
    exit 1
  fi
fi

command -v qrencode >/dev/null 2>&1 || { echo "qrencode missing. brew install qrencode"; exit 1; }

cleanup() {
  [[ -n "$HTTP_PID" ]] && kill "$HTTP_PID" 2>/dev/null || true
  [[ -n "$TUN_PID" ]] && kill "$TUN_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 -m http.server "$PORT" >/dev/null 2>&1 &
HTTP_PID=$!

LOG=/tmp/tunnel.log
: > "$LOG"

case "$TUNNEL" in
  cloudflared)
    cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >"$LOG" 2>&1 &
    TUN_PID=$!
    ;;
  ngrok)
    ngrok http "$PORT" --log=stdout >"$LOG" 2>&1 &
    TUN_PID=$!
    ;;
  *)
    echo "Unknown tunnel: $TUNNEL"
    exit 1
    ;;
esac

echo "Starting $TUNNEL tunnel..."

URL=""
for i in {1..60}; do
  case "$TUNNEL" in
    cloudflared)
      URL=$(grep -oE 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
      ;;
    ngrok)
      URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
        | python3 -c "import sys,json
try:
  t=json.load(sys.stdin)['tunnels']
  print(next(x['public_url'] for x in t if x['public_url'].startswith('https')))
except: pass" || true)
      ;;
  esac
  [[ -n "$URL" ]] && break
  sleep 0.5
done

if [[ -z "$URL" ]]; then
  echo "Failed to get public URL from $TUNNEL. Log: $LOG"
  tail -30 "$LOG"
  exit 1
fi

echo ""
echo "  Tunnel: $TUNNEL"
echo "  URL:    $URL"
echo ""
qrencode -t ANSIUTF8 "$URL"
echo ""
echo "Scan with your phone. Ctrl+C to stop."
wait "$TUN_PID"
