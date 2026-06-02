#!/usr/bin/env sh
set -eu

DISPLAY="${DISPLAY:-:99}"
export DISPLAY
CHROME_CDP_PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9222}"
PROFILE_DIR="${BROWSER_PROFILE_DIR:-/data/chrome-profile}"
START_URL="${BROWSER_START_URL:-https://app.monarchmoney.com/login}"

mkdir -p "$PROFILE_DIR"
rm -f "$PROFILE_DIR"/SingletonLock "$PROFILE_DIR"/SingletonSocket "$PROFILE_DIR"/SingletonCookie 2>/dev/null || true

CHROME="${CHROME_BIN:-}"
if [ -z "$CHROME" ]; then
  for c in /usr/bin/chromium-browser /usr/bin/chromium /usr/bin/google-chrome; do
    if [ -x "$c" ]; then
      CHROME="$c"
      break
    fi
  done
fi

if [ -z "$CHROME" ]; then
  echo "Chrome/Chromium not found" >&2
  exit 1
fi

exec "$CHROME" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CHROME_CDP_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --window-size=1280,900 \
  --window-position=0,0 \
  --start-maximized \
  --no-first-run \
  --no-default-browser-check \
  "$START_URL"
