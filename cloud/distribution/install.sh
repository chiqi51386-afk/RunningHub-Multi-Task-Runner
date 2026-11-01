#!/usr/bin/env bash
set -euo pipefail
umask 077
DIR="${HOME}/rh-runner-cloud"
PORT=17863
USE_SERVICE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?missing directory}"; shift 2;;
    --port) PORT="${2:?missing port}"; shift 2;;
    --no-service) USE_SERVICE=0; shift;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo 'Linux required' >&2; exit 1; }
for program in node npm python3; do command -v "$program" >/dev/null || { echo "Missing: $program" >&2; exit 1; }; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(!((a===22&&b>=21)||(a===24&&b>=5)))process.exit(1)' || { echo 'Use a current Node 22 or 24 LTS release.' >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$PORT >= 1 && 10#$PORT <= 65535)) || { echo 'Invalid port' >&2; exit 1; }
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
[[ "$DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]] && [ "$DIR" != / ] || { echo 'Use an absolute installation path without spaces or special characters.' >&2; exit 1; }
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir "$DIR/.install-lock" || { echo 'Another install is active; inspect .install-lock first.' >&2; exit 1; }
trap 'rmdir "$DIR/.install-lock"' EXIT
VERSION="$(node -p "require(process.argv[1]).version" "$PKG_DIR/app/package.json")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-][a-zA-Z0-9.-]+)?$ ]] || exit 1
RELEASE="$DIR/releases/$VERSION-$(date +%s)-$$"
mkdir -p "$RELEASE" "$DIR/data"
cp -R "$PKG_DIR/app/." "$RELEASE/"
(
  cd "$RELEASE"
  npm ci
  ./node_modules/.bin/tsc -p cloud/tsconfig.json
  npm prune --omit=dev
)
# Build first. Never overwrite binaries/modules under a running process.
SUDO=()
if [ "$(id -u)" != 0 ]; then SUDO=(sudo); fi
SERVICE_OK=0
if [ "$USE_SERVICE" = 1 ] && command -v systemctl >/dev/null && systemctl show-environment >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ] || { command -v sudo >/dev/null && sudo -n true 2>/dev/null; }; then SERVICE_OK=1; fi
fi
if command -v systemctl >/dev/null && systemctl is-active --quiet rh-runner; then
  [ "$SERVICE_OK" = 1 ] || { echo 'Stop the existing rh-runner service before a manual upgrade.' >&2; exit 1; }
  "${SUDO[@]}" systemctl stop rh-runner
fi
ln -s "$RELEASE" "$DIR/.current-$$"
mv -Tf "$DIR/.current-$$" "$DIR/current"
for folder in scripts smoke; do
  mkdir -p "$DIR/$folder"
  cp -R "$PKG_DIR/$folder/." "$DIR/$folder/"
done
cp "$PKG_DIR/AGENT_GUIDE.md" "$PKG_DIR/VIDEO_GUIDE.md" "$DIR/"
cp "$PKG_DIR/VERSION" "$DIR/"
# Preserve platform-supplied egress settings, without a software proxy UI.
python3 - "$DIR/runtime.env" "$DIR/data" "$PORT" <<'PY'
import json, os, sys
values={'RH_DATA_DIR':sys.argv[2], 'RH_BIND':'127.0.0.1', 'RH_PORT':sys.argv[3], 'RH_API_HOST':'https://www.runninghub.ai'}
for key in ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NO_PROXY','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE']:
    if os.environ.get(key): values[key]=os.environ[key]
if any(key in values for key in ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']): values['NODE_USE_ENV_PROXY']='1'
with open(sys.argv[1], 'w') as out:
    for key,value in values.items():
        if any(ord(c)<32 for c in value): raise SystemExit('Invalid environment value')
        out.write(key+'='+json.dumps(value,ensure_ascii=False)+'\n')
os.chmod(sys.argv[1],0o600)
PY
if [ "$SERVICE_OK" = 1 ]; then
  NODE="$(command -v node)"
  [[ "$NODE" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Node path contains unsupported characters' >&2; exit 1; }
  UNIT="$(mktemp)"
  cat > "$UNIT" <<EOF
[Unit]
Description=RH Runner
After=network-online.target
[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$DIR/current
EnvironmentFile=$DIR/runtime.env
ExecStart=$NODE dist/src/cloud/main.js
ExecStartPost=-$(command -v python3) $DIR/scripts/check_update.py
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF
  "${SUDO[@]}" install -m 644 "$UNIT" /etc/systemd/system/rh-runner.service
  rm -f "$UNIT"
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable rh-runner
  "${SUDO[@]}" systemctl restart rh-runner
  for attempt in $(seq 1 30); do
    if RH_BASE_URL="http://127.0.0.1:$PORT" RH_TOKEN_FILE="$DIR/data/api.token" python3 "$DIR/current/cloud/client.py" GET /health >/dev/null 2>&1; then
      echo "Ready: http://127.0.0.1:$PORT (data retained in $DIR/data)"; exit 0
    fi
    sleep 1
  done
  echo 'Health check failed. Inspect journalctl -u rh-runner; previous releases and data remain available.' >&2
  exit 1
fi
echo "Installed. Start manually: cd '$DIR/current' && RH_DATA_DIR='$DIR/data' RH_PORT='$PORT' node dist/src/cloud/main.js"
echo 'For managed egress, retain the platform proxy/CA environment when starting manually.'
